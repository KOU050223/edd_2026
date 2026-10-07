/**
 * `/v1/learning-maps`（Issue #242 / Web/18）。利用者が手で作る学習マップの作成・編集・削除。
 * AI でマップを作る `POST /v1/learning-maps:generate` と、その同意の
 * `GET` / `PUT` / `DELETE /v1/map-generation-consent` もここに置く（#243 / Web/19）。
 *
 * 対象のユーザーは `c.get("user").userId` だけから決める（routes/account.ts と同じ規律）。
 * 他人のマップは取得・編集・削除とも 404 にする（存在を隠す）。
 */

import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";
import {
  MAP_GENERATION_CONSENT_VERSION,
  type Concept,
  type ConsentRecord,
  type LearningObjective,
} from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { rateLimit } from "../auth/rate-limit.js";
import {
  MAX_CLIENT_CONCEPTS,
  MAX_OWN_NODES,
  MAX_MAPS_PER_USER,
  generateLearningMapSchema,
  learningMapContentSchema,
  learningObjectivesInputSchema,
  type GenerateCreationChecksResponse,
  type GenerateLearningMapResponse,
  type LearningMapView,
  type LearningObjectiveSource,
  type LearningObjectiveView,
  type ListClientMapConceptsResponse,
  type ListLearningMapsResponse,
  type MapGenerationConsentBody,
  type PutLearningObjectivesResponse,
  type ReferencedConcept,
  type SaveLearningMapResponse,
} from "../contract/learning-maps.js";
import { newMapId, resolveMapContent } from "../maps/content.js";
import { generateLearningMap, type MapGenerationDeps } from "../maps/generate.js";
import { generateCreationChecks, MAX_CREATION_CHECK_ATTEMPTS } from "../maps/creation-checks.js";
import type {
  IdentityRepository,
  LearningMapRepository,
  StoredLearningMap,
  StoredLearningObjective,
} from "../repository/types.js";

export interface LearningMapsDeps {
  identity: IdentityRepository;
  maps: LearningMapRepository;
  /** 参照のノードが指せる固定の Concept。テストだけが小さな一覧へ差し替える。 */
  fixedConcepts: readonly Concept[];
  /** 固定の Concept の「理解すること」（今は packages/domain のモック）。 */
  fixedObjectives: readonly LearningObjective[];
  /** 英小文字と数字 8 文字を返す。マップ・ノード・項目の ID に使う。 */
  newKey: () => string;
  nowIso: () => string;
  nowMs: () => number;
  /**
   * AI でマップを作るための依存（#243）。無ければ生成と同意の口は 503 を返す。
   * 手で作るマップのテストでは渡さない。
   */
  generation?: MapGenerationDeps;
}

export type LearningMapsDepsResolver = (env: CloudflareBindings) => LearningMapsDeps;

type AppContext = Context<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

/**
 * 本文を読んで検証する。拒否の理由には入力値を載せず、
 * こちらが書いた定型文とパスだけを返す（routes/conversations.ts と同じ）。
 */
async function parseBody<TSchema extends v.GenericSchema>(
  c: AppContext,
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid request body" });
  }
  const parsed = v.safeParse(schema, payload);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    const path = issue?.path?.map((entry) => String(entry.key)).join(".");
    throw new HTTPException(400, {
      message: path ? `${path}: ${issue?.message}` : (issue?.message ?? "invalid request body"),
    });
  }
  return parsed.output;
}

function notFound(): never {
  throw new HTTPException(404, { message: "learning map not found" });
}

/** AI の生成の依存が無い。運営側の設定漏れ。 */
function generationNotConfigured(): never {
  throw new HTTPException(503, { message: "map generation is not configured" });
}

function consentBody(record: ConsentRecord | null): MapGenerationConsentBody {
  const granted = record !== null && record.version === MAP_GENERATION_CONSENT_VERSION;
  return {
    version: MAP_GENERATION_CONSENT_VERSION,
    granted,
    ...(granted ? { grantedAt: record.grantedAt } : {}),
  };
}

function toObjectiveView(objective: StoredLearningObjective): LearningObjectiveView {
  return { id: objective.id, label: objective.label, source: objective.source };
}

export function createLearningMapsRoute(resolve: LearningMapsDepsResolver) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  /**
   * 参照のノードが指す元の Concept を引く。固定の Concept を先に見て、
   * 無ければ自分の他のマップのノードを見る。見つからない ID は結果に入らない。
   */
  async function resolveReferences(
    deps: LearningMapsDeps,
    userId: string,
    conceptIds: readonly string[],
  ): Promise<Map<string, ReferencedConcept>> {
    const resolved = new Map<string, ReferencedConcept>();
    const fixed = new Map(deps.fixedConcepts.map((concept) => [concept.id, concept]));
    const others: string[] = [];
    for (const conceptId of conceptIds) {
      const concept = fixed.get(conceptId);
      if (concept === undefined) {
        others.push(conceptId);
        continue;
      }
      resolved.set(conceptId, {
        label: concept.label,
        ...(concept.summary === undefined ? {} : { summary: concept.summary }),
        mapId: null,
        // 固定の項目は今は手で起こしたモックなので、出どころは manual として返す。
        objectives: deps.fixedObjectives
          .filter((objective) => objective.conceptId === conceptId)
          .map((objective) => ({ id: objective.id, label: objective.label, source: "manual" })),
      });
    }
    for (const node of await deps.maps.findOwnNodes(userId, others)) {
      resolved.set(node.conceptId, {
        label: node.label,
        summary: node.summary,
        mapId: node.mapId,
        objectives: node.objectives.map(toObjectiveView),
      });
    }
    return resolved;
  }

  async function toView(
    deps: LearningMapsDeps,
    userId: string,
    map: StoredLearningMap,
  ): Promise<LearningMapView> {
    const references = await resolveReferences(
      deps,
      userId,
      map.nodes.filter((node) => node.kind === "reference").map((node) => node.conceptId),
    );
    return {
      id: map.id,
      title: map.title,
      description: map.description,
      visibility: map.visibility,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
      nodes: map.nodes.map((node) =>
        node.kind === "own"
          ? {
              ...node,
              objectives: (map.objectives.get(node.conceptId) ?? []).map(toObjectiveView),
            }
          : {
              kind: "reference",
              conceptId: node.conceptId,
              origin: references.get(node.conceptId) ?? null,
            },
      ),
      edges: map.edges,
      ...(map.creationChecks === null
        ? {}
        : {
            creationChecks: {
              status:
                map.creationChecks.doneAt !== null
                  ? "done"
                  : map.creationChecks.attempts >= MAX_CREATION_CHECK_ATTEMPTS
                    ? "exhausted"
                    : "pending",
            },
          }),
    };
  }

  /**
   * 入力を保存する形へ変える。新しく足した参照の行き先が無ければ 400。
   *
   * @param current 置き換える前のマップ。新しく作るなら `null`。
   *   このマップにすでにある参照は、元が消えていても（`origin: null`）そのまま通す。
   *   通さないと、元のマップを消しただけで、題名の変更すら保存できなくなる。
   */
  async function resolveContent(
    deps: LearningMapsDeps,
    userId: string,
    mapId: string,
    input: v.InferOutput<typeof learningMapContentSchema>,
    current: StoredLearningMap | null,
  ) {
    const existingOwnIds = new Set<string>();
    const existingReferenceIds = new Set<string>();
    for (const node of current?.nodes ?? []) {
      (node.kind === "own" ? existingOwnIds : existingReferenceIds).add(node.conceptId);
    }
    const resolved = resolveMapContent(mapId, input, existingOwnIds, deps.newKey);
    if (!resolved.ok) throw new HTTPException(400, { message: resolved.error });
    const added = resolved.referenceIds.filter((conceptId) => !existingReferenceIds.has(conceptId));
    const found = await resolveReferences(deps, userId, added);
    const missing = added.find((conceptId) => !found.has(conceptId));
    if (missing !== undefined) {
      throw new HTTPException(400, { message: `unknown concept: ${missing}` });
    }
    return resolved;
  }

  // VS Code が AI へ渡す「既知の概念一覧」に加える。参照のノードは元の Concept が
  // 一覧に入っているので返さない。Web の編集画面は参照の候補として `?limit=` で全部読む。
  app.get("/learning-maps:concepts", async (c) => {
    const userId = c.get("user").userId;
    const raw = c.req.query("limit");
    const limit = raw === undefined ? MAX_CLIENT_CONCEPTS : Number(raw);
    // 解釈できない値は既定へ丸めず 400 にする（routes/conversations.ts と同じ）。
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OWN_NODES) {
      throw new HTTPException(400, {
        message: `limit must be an integer between 1 and ${String(MAX_OWN_NODES)}`,
      });
    }
    const deps = resolve(c.env);
    const nodes = await deps.maps.listOwnNodes(userId, limit);
    const body: ListClientMapConceptsResponse = {
      concepts: nodes.map((node) => ({
        id: node.conceptId,
        label: node.label,
        summary: node.summary,
        mapId: node.mapId,
        mapTitle: node.mapTitle,
        prerequisites: node.prerequisites,
        objectives: node.objectives.map((objective) => ({
          id: objective.id,
          label: objective.label,
        })),
      })),
    };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  // AI を呼ぶ口と、その同意。認証（`app.ts` の `/v1/*`）の後に走るので userId で数えられる。
  app.use(
    "/learning-maps:generate",
    rateLimit((env) => env.PROFILE_RATE_LIMITER),
  );
  app.use(
    "/map-generation-consent",
    rateLimit((env) => env.PROFILE_RATE_LIMITER),
  );
  app.use(
    "/learning-maps/:id/checks:generate",
    rateLimit((env) => env.PROFILE_RATE_LIMITER),
  );

  // 作成時の確認問題（#247）。AI で作ったマップを保存したあと、Web が続けて呼ぶ。
  app.post("/learning-maps/:id/checks:generate", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const generation = deps.generation ?? generationNotConfigured();
    const outcome = await generateCreationChecks(
      { ...deps, generation },
      userId,
      c.req.param("id"),
      c.req.path,
    );
    if (outcome.status === 200) {
      const body: GenerateCreationChecksResponse = outcome.body;
      return c.json(body, 200, { "cache-control": "no-store" });
    }
    return c.json(outcome.body, outcome.status);
  });

  app.post("/learning-maps:generate", async (c) => {
    const userId = c.get("user").userId;
    const input = await parseBody(c, generateLearningMapSchema);
    const deps = resolve(c.env);
    const generation = deps.generation ?? generationNotConfigured();
    const outcome = await generateLearningMap({ ...deps, generation }, userId, input, c.req.path);
    if (outcome.status !== 201) return c.json(outcome.body, outcome.status);
    const map = await deps.maps.get(userId, outcome.mapId);
    // 作った直後に読めないなら、書き込みか読み取りが壊れている。空の応答で隠さない。
    if (map === null) throw new Error("generated learning map could not be read back");
    const body: GenerateLearningMapResponse = { map: await toView(deps, userId, map) };
    return c.json(body, 201);
  });

  app.get("/map-generation-consent", async (c) => {
    const generation = resolve(c.env).generation ?? generationNotConfigured();
    const record = await generation.consents.get(c.get("user").userId);
    return c.json(consentBody(record), 200, { "cache-control": "no-store" });
  });

  app.put("/map-generation-consent", async (c) => {
    const { version } = await parseBody(
      c,
      v.strictObject({ version: v.pipe(v.number(), v.integer()) }),
    );
    if (version !== MAP_GENERATION_CONSENT_VERSION) {
      // 古い文面を見て押した同意を、今の文面への同意として記録しない（確認問題と同じ）。
      return c.json(
        {
          error: "consent_outdated",
          message:
            "確認の文面が更新されました。ページを再読み込みして、最新の内容を確認してください。",
        },
        409,
      );
    }
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const generation = deps.generation ?? generationNotConfigured();
    const now = generation.now();
    await deps.identity.ensureUser({ userId, nowMs: now.getTime() });
    const record: ConsentRecord = {
      version: MAP_GENERATION_CONSENT_VERSION,
      grantedAt: now.toISOString(),
    };
    await generation.consents.put(userId, record);
    return c.json(consentBody(record), 200, { "cache-control": "no-store" });
  });

  app.delete("/map-generation-consent", async (c) => {
    const generation = resolve(c.env).generation ?? generationNotConfigured();
    await generation.consents.delete(c.get("user").userId);
    return c.json(consentBody(null), 200, { "cache-control": "no-store" });
  });

  app.get("/learning-maps", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const body: ListLearningMapsResponse = { maps: await deps.maps.listByOwner(userId) };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  app.post("/learning-maps", async (c) => {
    const userId = c.get("user").userId;
    const input = await parseBody(c, learningMapContentSchema);
    const deps = resolve(c.env);
    const mapId = newMapId(deps.newKey);
    const { content, assigned } = await resolveContent(deps, userId, mapId, input, null);

    // learning_maps.owner_user_id は users(id) を参照する。
    await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });
    const { created } = await deps.maps.create(userId, {
      id: mapId,
      content,
      nowIso: deps.nowIso(),
      nowMs: deps.nowMs(),
      maxMaps: MAX_MAPS_PER_USER,
    });
    if (!created) {
      throw new HTTPException(409, { message: "learning_map_limit_reached" });
    }
    const map = await deps.maps.get(userId, mapId);
    // 作った直後に読めないなら、書き込みか読み取りが壊れている。空の応答で隠さない。
    if (map === null) throw new Error("created learning map could not be read back");
    const body: SaveLearningMapResponse = { map: await toView(deps, userId, map), assigned };
    return c.json(body, 201);
  });

  app.get("/learning-maps/:id", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const map = await deps.maps.get(userId, c.req.param("id"));
    if (map === null) notFound();
    return c.json(await toView(deps, userId, map), 200, { "cache-control": "no-store" });
  });

  app.put("/learning-maps/:id", async (c) => {
    const userId = c.get("user").userId;
    const mapId = c.req.param("id");
    const input = await parseBody(c, learningMapContentSchema);
    const deps = resolve(c.env);
    const current = await deps.maps.get(userId, mapId);
    if (current === null) notFound();

    const { content, assigned } = await resolveContent(deps, userId, mapId, input, current);
    const replaced = await deps.maps.replace(userId, mapId, content, {
      nowIso: deps.nowIso(),
      nowMs: deps.nowMs(),
    });
    // 読んでから書くまでの間に、別の端末で消された。
    if (!replaced) notFound();
    const map = await deps.maps.get(userId, mapId);
    if (map === null) notFound();
    const body: SaveLearningMapResponse = { map: await toView(deps, userId, map), assigned };
    return c.json(body, 200);
  });

  app.delete("/learning-maps/:id", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    if (!(await deps.maps.delete(userId, c.req.param("id")))) notFound();
    return c.body(null, 204);
  });

  app.put("/learning-maps/:id/nodes/:conceptId/objectives", async (c) => {
    const userId = c.get("user").userId;
    const mapId = c.req.param("id");
    const conceptId = c.req.param("conceptId");
    const input = await parseBody(c, learningObjectivesInputSchema);
    const deps = resolve(c.env);
    const map = await deps.maps.get(userId, mapId);
    if (map === null) notFound();

    const node = map.nodes.find((candidate) => candidate.conceptId === conceptId);
    if (node === undefined) {
      throw new HTTPException(404, { message: "node not found" });
    }
    // 参照のノードの項目は元の Concept のもの。このマップからは書き換えない。
    if (node.kind === "reference") {
      throw new HTTPException(400, {
        message: "objectives of a referenced concept cannot be edited here",
      });
    }

    const existing = new Map(
      (map.objectives.get(conceptId) ?? []).map((objective) => [objective.id, objective]),
    );
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
        // AI が作った項目でも、手で書き換えたら手書きになる。
        const source = before.label === item.label ? before.source : "manual";
        objectives.push({ id: item.id, label: item.label, source });
        continue;
      }
      objectives.push({
        id: newObjectiveId(deps, conceptId, existing, used),
        label: item.label,
        source: "manual",
      });
    }

    const saved = await deps.maps.replaceObjectives(userId, {
      mapId,
      conceptId,
      objectives,
      nowIso: deps.nowIso(),
      nowMs: deps.nowMs(),
    });
    // 読んでから書くまでの間に、別の端末でマップかノードが消された。
    // 書けていない項目を「保存した」と返さない。
    if (!saved) {
      throw new HTTPException(404, { message: "node not found" });
    }
    const body: PutLearningObjectivesResponse = {
      objectives: objectives.map(({ id, label, source }) => ({ id, label, source })),
    };
    return c.json(body, 200);
  });

  return app;
}

/** `<Concept ID>:<識別子>`。今ある項目と、この置き換えで使った ID とは重ならないものを引く。 */
function newObjectiveId(
  deps: LearningMapsDeps,
  conceptId: string,
  existing: ReadonlyMap<string, unknown>,
  used: Set<string>,
): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = `${conceptId}:${deps.newKey()}`;
    if (!existing.has(id) && !used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error("could not assign a unique objective id");
}
