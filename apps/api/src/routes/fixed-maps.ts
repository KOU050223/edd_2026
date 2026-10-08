/**
 * `/v1/fixed-maps`（Issue #245）。固定の言語別マップの「理解すること」を、その言語のマップの
 * 作成者（migrations/0018_fixed_map_creators.sql）が AI で作り直し、手で直して確定する。
 *
 * 作成者以外は 403（決定 N5）。作成者は手で SQL を流して入れるので、API からは変えられない。
 * 知らない言語・その言語に無い Concept は 404。
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Concept } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import {
  generateFixedObjectivesSchema,
  putFixedObjectivesSchema,
  type ListFixedMapsResponse,
  type PutFixedObjectivesResponse,
} from "../contract/fixed-maps.js";
import type { LearningObjectiveSource } from "../contract/learning-maps.js";
import {
  generateFixedObjectives,
  type FixedObjectivesGenerationDeps,
} from "../maps/fixed-objectives.js";
import type {
  AuditLogRepository,
  FixedMapCreatorRepository,
  IdentityRepository,
  LearningMapRepository,
} from "../repository/types.js";
import { parseBody } from "./learning-maps.js";

export interface FixedMapsDeps {
  identity: IdentityRepository;
  maps: LearningMapRepository;
  creators: FixedMapCreatorRepository;
  audit: AuditLogRepository;
  /** 固定の Concept。テストだけが小さな一覧へ差し替える。 */
  fixedConcepts: readonly Concept[];
  /** 英小文字と数字 8 文字を返す。新しい項目の ID に使う。 */
  newKey: () => string;
  nowIso: () => string;
  nowMs: () => number;
  /** AI で作り直すための依存。無ければ生成の口は 503 を返す。 */
  generation?: FixedObjectivesGenerationDeps;
}

export type FixedMapsDepsResolver = (env: CloudflareBindings) => FixedMapsDeps;

/** AI の生成の依存が無い。運営側の設定漏れ。 */
function generationNotConfigured(): never {
  throw new HTTPException(503, { message: "fixed objectives generation is not configured" });
}

export function createFixedMapsRoute(resolve: FixedMapsDepsResolver) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  /** その言語の Concept（学ぶ順）。作成者でなければ 403。 */
  async function authorize(
    deps: FixedMapsDeps,
    userId: string,
    language: string,
  ): Promise<Concept[]> {
    const concepts = deps.fixedConcepts.filter((concept) => concept.language === language);
    if (concepts.length === 0) {
      throw new HTTPException(404, { message: "fixed map not found" });
    }
    if (!(await deps.creators.isCreator(language, userId))) {
      throw new HTTPException(403, { message: "only the creator of this map can edit it" });
    }
    return concepts;
  }

  // 固定の項目は誰でも読める（理解度の表示と確認問題に使う）。編集できる言語は本人の分だけ返す。
  app.get("/fixed-maps", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const [objectives, editableLanguages] = await Promise.all([
      deps.maps.listFixedObjectives(),
      deps.creators.languagesOf(userId),
    ]);
    const body: ListFixedMapsResponse = {
      objectives: objectives.map(({ id, conceptId, label, source }) => ({
        id,
        conceptId,
        label,
        source,
      })),
      editableLanguages,
    };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  app.post("/fixed-maps/:language/objectives:generate", async (c) => {
    const userId = c.get("user").userId;
    const language = c.req.param("language");
    const input = await parseBody(c, generateFixedObjectivesSchema);
    const deps = resolve(c.env);
    const concepts = await authorize(deps, userId, language);
    const generation = deps.generation ?? generationNotConfigured();

    let targets = concepts;
    if (input.conceptIds !== undefined) {
      const wanted = new Set(input.conceptIds);
      if (wanted.size !== input.conceptIds.length) {
        throw new HTTPException(400, { message: "conceptIds must not repeat" });
      }
      const known = new Set(concepts.map((concept) => concept.id));
      const unknown = input.conceptIds.find((conceptId) => !known.has(conceptId));
      if (unknown !== undefined) {
        throw new HTTPException(400, { message: `unknown concept: ${unknown}` });
      }
      // 学ぶ順に並べ直す。
      targets = concepts.filter((concept) => wanted.has(concept.id));
    }

    const outcome = await generateFixedObjectives(
      { generation, identity: deps.identity, maps: deps.maps },
      userId,
      language,
      targets,
      c.req.path,
    );
    if (outcome.status === 200) return c.json(outcome.body, 200, { "cache-control": "no-store" });
    return c.json(outcome.body, outcome.status);
  });

  app.put("/fixed-maps/:language/concepts/:conceptId/objectives", async (c) => {
    const userId = c.get("user").userId;
    const language = c.req.param("language");
    const conceptId = c.req.param("conceptId");
    const input = await parseBody(c, putFixedObjectivesSchema);
    const deps = resolve(c.env);
    const concepts = await authorize(deps, userId, language);
    if (!concepts.some((concept) => concept.id === conceptId)) {
      throw new HTTPException(404, { message: "concept not found" });
    }

    const current = await deps.maps.getFixedObjectives(conceptId);
    const existing = new Map(current.objectives.map((objective) => [objective.id, objective]));
    const used = new Set<string>();
    const objectives: { id: string; label: string; source: LearningObjectiveSource }[] = [];
    for (const item of input.objectives) {
      if (item.id !== undefined) {
        const before = existing.get(item.id);
        if (before === undefined) {
          throw new HTTPException(400, { message: `unknown objective: ${item.id}` });
        }
        if (used.has(item.id)) {
          throw new HTTPException(400, { message: `duplicate objective: ${item.id}` });
        }
        used.add(item.id);
        // 表示名を変えても ID は同じ（決定 M6）。手で書き換えたら手書きになる。
        const source = item.source ?? (before.label === item.label ? before.source : "manual");
        objectives.push({ id: item.id, label: item.label, source });
        continue;
      }
      objectives.push({
        id: newObjectiveId(deps.newKey, conceptId, existing, used),
        label: item.label,
        source: item.source ?? "manual",
      });
    }

    // 全利用者の理解度と確認問題に効く操作なので、誰がいつ何を変えたかを残す。書く前に記録する
    // （記録が落ちたまま書き換えだけが済む「追えない操作」を作らない。docs/api-ops.md）。
    // 監査ログは users(id) を参照する。
    await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });
    await deps.audit.record({
      userId,
      action: "fixed_objectives.replaced",
      occurredAtMs: deps.nowMs(),
      detail: {
        conceptId,
        objectiveIds: objectives.map((objective) => objective.id),
        removedIds: [...existing.keys()].filter((id) => !used.has(id)),
      },
    });
    const replaced = await deps.maps.replaceFixedObjectives({
      conceptId,
      expectedRevision: current.revision,
      revision: deps.newKey(),
      objectives,
      nowIso: deps.nowIso(),
    });
    // 読んでから書くまでの間に、別の確定が入った。読んだ一覧で確かめた ID が今も正しいとは限らない。
    if (!replaced) {
      return c.json(
        {
          error: "fixed objectives changed",
          message:
            "ほかの操作で、この Concept の項目が変わりました。画面を読み込み直してから確定してください。",
        },
        409,
      );
    }
    const body: PutFixedObjectivesResponse = {
      objectives: objectives.map(({ id, label, source }) => ({ id, label, source })),
    };
    return c.json(body, 200);
  });

  return app;
}

/** `<Concept ID>:<識別子>`。今ある項目と、この置き換えで使った ID とは重ならないものを引く。 */
function newObjectiveId(
  newKey: () => string,
  conceptId: string,
  existing: ReadonlyMap<string, unknown>,
  used: Set<string>,
): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = `${conceptId}:${newKey()}`;
    if (!existing.has(id) && !used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error("could not assign a unique objective id");
}
