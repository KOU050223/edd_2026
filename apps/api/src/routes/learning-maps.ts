/**
 * `/v1/learning-maps`（Issue #242 / Web/18）。利用者が手で作る学習マップの作成・編集・削除。
 * AI でマップを作る `POST /v1/learning-maps:generate` と、その同意の
 * `GET` / `PUT` / `DELETE /v1/map-generation-consent` もここに置く（#243 / Web/19）。
 *
 * 共有（#244 / Web/20）: 持ち主が手元のマップを「共有へ上げる」と版になり
 * （`/v1/learning-maps/:id/versions*`）、持ち主以外は `/v1/shared-maps*` から
 * いちばん新しい版を読む。手元のマップ（`/v1/learning-maps/:id`）は持ち主だけが読み書きする。
 *
 * 対象のユーザーは `c.get("user").userId` だけから決める（routes/account.ts と同じ規律）。
 * 他人のマップは取得・編集・削除とも 404 にする（存在を隠す）。共有されていないマップも、
 * 持ち主以外には 404 にする。
 */

import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";
import {
  MAP_GENERATION_CONSENT_VERSION,
  type Concept,
  type ConsentRecord,
} from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { rateLimit } from "../auth/rate-limit.js";
import {
  MAX_CLIENT_CONCEPTS,
  MAX_LISTED_SHARED_MAPS,
  MAX_OWN_NODES,
  MAX_MAPS_PER_USER,
  generateLearningMapSchema,
  learningMapContentSchema,
  learningMapVisibilitySchema,
  learningObjectivesInputSchema,
  publishLearningMapSchema,
  restoreLearningMapSchema,
  type GenerateCreationChecksResponse,
  type GenerateLearningMapResponse,
  type LearningMapView,
  type LearningObjectiveSource,
  type LearningObjectiveView,
  type ListClientMapConceptsResponse,
  type ListLearningMapsResponse,
  type ListMapVersionsResponse,
  type ListSharedMapsResponse,
  type MapGenerationConsentBody,
  type MapPublishPreview,
  type MapVersionMeta,
  type MapVersionResponse,
  type PublishLearningMapResponse,
  type PutLearningObjectivesResponse,
  type ReferencedConcept,
  type SaveLearningMapResponse,
  type SharedMapContentView,
  type SharedMapView,
  type ShareScope,
} from "../contract/learning-maps.js";
import { newMapId, resolveMapContent } from "../maps/content.js";
import { generateLearningMap, type MapGenerationDeps } from "../maps/generate.js";
import { generateCreationChecks, MAX_CREATION_CHECK_ATTEMPTS } from "../maps/creation-checks.js";
import {
  buildSnapshot,
  diffContents,
  parseSnapshot,
  serializeSnapshot,
  snapshotContentView,
  snapshotHash,
  snapshotToStoredContent,
  summarizeDiff,
  type MapSnapshot,
} from "../maps/snapshot.js";
import type {
  IdentityRepository,
  LearningMapRepository,
  PersonalCheckRepository,
  StoredLearningMap,
  StoredLearningObjective,
  StoredMapVersion,
} from "../repository/types.js";

export interface LearningMapsDeps {
  identity: IdentityRepository;
  maps: LearningMapRepository;
  /** 共有へ上げるときに、作成時の確認問題（#247）を版の中身へ写すために読む（#244 の T6）。 */
  checks: PersonalCheckRepository;
  /** 参照のノードが指せる固定の Concept。テストだけが小さな一覧へ差し替える。 */
  fixedConcepts: readonly Concept[];
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
export async function parseBody<TSchema extends v.GenericSchema>(
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

/** 共有の操作の衝突（409）。本文の `error` は Web が見分けるための定型文。 */
function conflict(message: string): never {
  throw new HTTPException(409, { message });
}

/**
 * `?includeChecks=` を読む。省略したら `fallback`。解釈できない値は既定へ丸めず 400 にする
 * （`:concepts` の `limit` と同じ）。
 */
function parseIncludeChecks(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new HTTPException(400, { message: "includeChecks must be true or false" });
}

function parseVersionParam(raw: string): number {
  const version = Number(raw);
  if (!/^[1-9][0-9]{0,8}$/.test(raw) || !Number.isSafeInteger(version)) {
    throw new HTTPException(404, { message: "version not found" });
  }
  return version;
}

/**
 * 「リンクだけ」の鍵（#244 の決定 U1）。すでに「リンクだけ」で共有していれば今の鍵を使い続け、
 * 「リンクだけ」へ切り替えるときは作り直す（共有をやめて再開すると前のリンクは使えない）。
 * 32 文字（英小文字と数字）で、推測できない長さにする。
 */
function shareKeyFor(
  deps: LearningMapsDeps,
  map: StoredLearningMap,
  scope: ShareScope | null,
): string | null {
  if (scope !== "link") return null;
  if (map.visibility === "link" && map.shareKey !== null) return map.shareKey;
  return Array.from({ length: 4 }, () => deps.newKey()).join("");
}

/** 鍵を比べる。比べる時間から一致した長さが分からないよう、最後まで比べる。 */
function sameKey(given: string | undefined, expected: string | null): boolean {
  if (given === undefined || expected === null || given.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index++) {
    diff |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

function toVersionMeta(version: StoredMapVersion): MapVersionMeta {
  return {
    version: version.version,
    createdAt: version.createdAt,
    authorUserId: version.authorUserId,
    restoredFrom: version.restoredFrom,
    checksIncluded: version.checksIncluded,
    summary: version.summary,
  };
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

/** Concept ID ごとにまとめる。並びは入力の順を保つ。 */
function groupObjectivesByConcept(
  objectives: readonly StoredLearningObjective[],
): Map<string, StoredLearningObjective[]> {
  const grouped = new Map<string, StoredLearningObjective[]>();
  for (const objective of objectives) {
    grouped.set(objective.conceptId, [...(grouped.get(objective.conceptId) ?? []), objective]);
  }
  return grouped;
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
    const resolved = await resolveFixedReferences(deps, conceptIds);
    const others = conceptIds.filter((conceptId) => !resolved.has(conceptId));
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

  /** 固定の Concept への参照だけを引く。共有の版の表示（持ち主以外も読む）に使う。 */
  async function resolveFixedReferences(
    deps: LearningMapsDeps,
    conceptIds: readonly string[],
  ): Promise<Map<string, ReferencedConcept>> {
    const resolved = new Map<string, ReferencedConcept>();
    const fixed = new Map(deps.fixedConcepts.map((concept) => [concept.id, concept]));
    // 固定の項目は表から読む（#245）。固定の Concept を指す参照が無ければ読まない。
    const fixedObjectives = conceptIds.some((conceptId) => fixed.has(conceptId))
      ? groupObjectivesByConcept(await deps.maps.listFixedObjectives())
      : new Map<string, StoredLearningObjective[]>();
    for (const conceptId of conceptIds) {
      const concept = fixed.get(conceptId);
      if (concept === undefined) continue;
      resolved.set(conceptId, {
        label: concept.label,
        ...(concept.summary === undefined ? {} : { summary: concept.summary }),
        mapId: null,
        objectives: (fixedObjectives.get(conceptId) ?? []).map(toObjectiveView),
      });
    }
    return resolved;
  }

  /** 版の中身を表示する形へ変える。固定の Concept への参照は今の一覧から引く。 */
  async function contentViewOf(
    deps: LearningMapsDeps,
    snapshot: MapSnapshot,
  ): Promise<SharedMapContentView> {
    const fixed = await resolveFixedReferences(
      deps,
      snapshot.nodes
        .filter((node) => node.kind === "reference" && node.origin === null)
        .map((node) => node.conceptId),
    );
    return snapshotContentView(snapshot, (conceptId) => fixed.get(conceptId));
  }

  /** 保存した版の中身を読む。 */
  function snapshotOf(mapId: string, version: StoredMapVersion): MapSnapshot {
    return parseSnapshot(version.content, `${mapId}@${String(version.version)}`);
  }

  /**
   * 手元のマップから、上げると出ていく中身を作る（#244 の S1-a・T2・T6）。
   * `availableChecks` は含めないを選んでも数える（確認画面で「含める」の横に出す）。
   */
  async function draftOf(
    deps: LearningMapsDeps,
    userId: string,
    map: StoredLearningMap,
    includeChecks: boolean,
  ): Promise<{ snapshot: MapSnapshot; availableChecks: number }> {
    const [references, creationChecks] = await Promise.all([
      resolveReferences(
        deps,
        userId,
        map.nodes.filter((node) => node.kind === "reference").map((node) => node.conceptId),
      ),
      deps.checks.listMapCreationChecks(userId),
    ]);
    const withChecks = buildSnapshot(map, references, creationChecks);
    return {
      snapshot: includeChecks ? withChecks : { ...withChecks, checks: [] },
      availableChecks: withChecks.checks.length,
    };
  }

  /** 持ち主の手元のマップと、いちばん新しい版。無ければ 404。 */
  async function ownedWithLatest(deps: LearningMapsDeps, userId: string, mapId: string) {
    const map = await deps.maps.get(userId, mapId);
    if (map === null) notFound();
    if (map.latestVersion === null) return { map, latest: null };
    const latest = await deps.maps.getVersion(userId, mapId, map.latestVersion);
    // 一覧で番号が見えた版が読めないなら、読む間に消された（マップごと）か壊れている。
    if (latest === null) notFound();
    return { map, latest };
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
      latestVersion: map.latestVersion,
      shareKey: map.shareKey,
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
  // 一覧に入っているので返さない。固定の Concept の項目も一緒に返す（#245）。Web の編集画面は参照の候補として `?limit=` で全部読む。
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
    const [nodes, fixedObjectives] = await Promise.all([
      deps.maps.listOwnNodes(userId, limit),
      deps.maps.listFixedObjectives(),
    ]);
    const body: ListClientMapConceptsResponse = {
      fixedObjectives: fixedObjectives.map(({ id, conceptId, label }) => ({
        id,
        conceptId,
        label,
      })),
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

  // `/learning-maps*`（生成の口を含む）は `app.ts` が回数を制限している。ここで重ねると1回が2回と数えられる
  // （PR #283 のレビュー）。同意の口は `app.ts` の対象外なので、ここで制限する。
  // 認証（`app.ts` の `/v1/*`）の後に走るので userId で数えられる。
  app.use(
    "/map-generation-consent",
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

  // 共有へ上げる前の確認画面（#244 の S1-a）。上げると出ていく中身の全部と、いちばん新しい版との差分。
  app.get("/learning-maps/:id/versions:preview", async (c) => {
    const userId = c.get("user").userId;
    const mapId = c.req.param("id");
    const deps = resolve(c.env);
    const { map, latest } = await ownedWithLatest(deps, userId, mapId);
    // 既定は前の版で選んだもの（初めてなら含める）。
    const includeChecks = parseIncludeChecks(
      c.req.query("includeChecks"),
      latest?.checksIncluded ?? true,
    );
    const { snapshot, availableChecks } = await draftOf(deps, userId, map, includeChecks);
    const [content, before, contentHash] = await Promise.all([
      contentViewOf(deps, snapshot),
      latest === null ? null : contentViewOf(deps, snapshotOf(mapId, latest)),
      snapshotHash(snapshot),
    ]);
    const body: MapPublishPreview = {
      visibility: map.visibility,
      latest: latest === null ? null : toVersionMeta(latest),
      includeChecks,
      availableChecks,
      content,
      diff: diffContents(before, content),
      hasChanges: latest?.contentHash !== contentHash,
      contentHash,
    };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  // 共有へ上げる（#244 の T1-a）。確認画面で見た中身（contentHash）と版（baseVersion）が
  // 今と同じときだけ、新しい版にして共有の範囲を切り替える。
  app.post("/learning-maps/:id/versions", async (c) => {
    const userId = c.get("user").userId;
    const mapId = c.req.param("id");
    const input = await parseBody(c, publishLearningMapSchema);
    const deps = resolve(c.env);
    const { map, latest } = await ownedWithLatest(deps, userId, mapId);
    // 確認画面を開いたあとに、別の端末で上げられた。
    if (map.latestVersion !== input.baseVersion) conflict("version_conflict");
    const { snapshot } = await draftOf(deps, userId, map, input.includeChecks);
    const contentHash = await snapshotHash(snapshot);
    // 確認画面で見た中身と違う（そのあとに手元を直した）。確かめていない中身を出さない。
    if (contentHash !== input.contentHash) conflict("content_changed");
    // 中身が同じなら新しい版にしない。範囲だけを変えるなら PUT .../visibility を使う。
    if (latest?.contentHash === contentHash) conflict("no_changes");

    const [content, before] = await Promise.all([
      contentViewOf(deps, snapshot),
      latest === null ? null : contentViewOf(deps, snapshotOf(mapId, latest)),
    ]);
    const summary = summarizeDiff(diffContents(before, content));
    const nowIso = deps.nowIso();
    // 中身を読んだときの手元のまま上げる。読んだあとに別の画面で手元が直されたら、
    // 確かめた中身と今の手元が食い違うので上げない（PR #294 のレビュー）。
    const published = await deps.maps.publishVersion(userId, mapId, {
      expectedLatest: input.baseVersion,
      expectedRevision: map.revision,
      scope: input.visibility,
      shareKey: shareKeyFor(deps, map, input.visibility),
      content: serializeSnapshot(snapshot),
      contentHash,
      checksIncluded: input.includeChecks,
      summary,
      nowIso,
      nowMs: deps.nowMs(),
    });
    // 読んでから書くまでの間に、別の端末で上げられたか、手元が直された（またはマップが消された）。
    // どちらかは区別せず、確認画面を読み直させる。
    if (!published) conflict("content_changed");
    const body: PublishLearningMapResponse = {
      version: {
        version: (input.baseVersion ?? 0) + 1,
        createdAt: nowIso,
        authorUserId: userId,
        restoredFrom: null,
        checksIncluded: input.includeChecks,
        summary,
      },
      visibility: input.visibility,
    };
    return c.json(body, 201);
  });

  // 共有の範囲だけを変える（版は作らない）。共有へ切り替えるのは、版が1つ以上あるときだけ
  // （初めて共有するときは確認画面を通して POST .../versions で上げる、S1-a）。
  app.put("/learning-maps/:id/visibility", async (c) => {
    const userId = c.get("user").userId;
    const mapId = c.req.param("id");
    const { visibility } = await parseBody(c, learningMapVisibilitySchema);
    const deps = resolve(c.env);
    const map = await deps.maps.get(userId, mapId);
    if (map === null) notFound();
    const scope = visibility === "private" ? null : visibility;
    if (scope !== null && map.latestVersion === null) conflict("not_published");
    // 読んでから書くまでの間に、別の端末でマップが消された。
    if (!(await deps.maps.setShareScope(userId, mapId, scope, shareKeyFor(deps, map, scope)))) {
      notFound();
    }
    return c.json({ visibility }, 200);
  });

  app.get("/learning-maps/:id/versions", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const versions = await deps.maps.listVersions(userId, c.req.param("id"));
    if (versions === null) notFound();
    const body: ListMapVersionsResponse = { versions };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  app.get("/learning-maps/:id/versions/:version", async (c) => {
    const userId = c.get("user").userId;
    const mapId = c.req.param("id");
    const deps = resolve(c.env);
    const stored = await deps.maps.getVersion(
      userId,
      mapId,
      parseVersionParam(c.req.param("version")),
    );
    if (stored === null) throw new HTTPException(404, { message: "version not found" });
    const body: MapVersionResponse = {
      version: toVersionMeta(stored),
      content: await contentViewOf(deps, snapshotOf(mapId, stored)),
    };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  // 過去の版から復元する（#244 の T2）。その中身で新しい版を作り、手元のマップも戻す。
  app.post("/learning-maps/:id/versions/:version/restore", async (c) => {
    const userId = c.get("user").userId;
    const mapId = c.req.param("id");
    const fromVersion = parseVersionParam(c.req.param("version"));
    const { baseVersion } = await parseBody(c, restoreLearningMapSchema);
    const deps = resolve(c.env);
    const { map, latest } = await ownedWithLatest(deps, userId, mapId);
    if (latest === null || map.latestVersion !== baseVersion) conflict("version_conflict");
    // いちばん新しい版を復元しても、同じ中身の版が増えるだけ。
    if (fromVersion === latest.version) conflict("already_latest");
    const from = await deps.maps.getVersion(userId, mapId, fromVersion);
    if (from === null) throw new HTTPException(404, { message: "version not found" });

    const snapshot = snapshotOf(mapId, from);
    const [content, before] = await Promise.all([
      contentViewOf(deps, snapshot),
      contentViewOf(deps, snapshotOf(mapId, latest)),
    ]);
    const summary = summarizeDiff(diffContents(before, content));
    const { content: stored, objectives } = snapshotToStoredContent(snapshot);
    const nowIso = deps.nowIso();
    const restored = await deps.maps.restoreVersion(userId, mapId, {
      fromVersion,
      expectedLatest: baseVersion,
      // 読んだあとに別の画面で手元が直されたら、その分を黙って消さない（PR #294 のレビュー）。
      expectedRevision: map.revision,
      content: stored,
      objectives,
      summary,
      nowIso,
      nowMs: deps.nowMs(),
    });
    if (!restored) conflict("version_conflict");
    const body: PublishLearningMapResponse = {
      version: {
        version: baseVersion + 1,
        createdAt: nowIso,
        authorUserId: userId,
        restoredFrom: fromVersion,
        checksIncluded: from.checksIncluded,
        summary,
      },
      visibility: map.visibility,
    };
    return c.json(body, 201);
  });

  // 範囲が「全員」の共有マップの一覧（#244 の T5）。新しく上げた順。作成者の名前は出さない。
  app.get("/shared-maps", async (c) => {
    const deps = resolve(c.env);
    const body: ListSharedMapsResponse = {
      maps: await deps.maps.listPublic(MAX_LISTED_SHARED_MAPS),
    };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  // 共有の側のいちばん新しい版（#244）。リンクを知っている人（link、`?key=` の鍵が合う人）と
  // 全員（public）が読める。共有されていないマップは、持ち主にも 404 にする（持ち主は手元のマップを読む）。
  // 鍵が合わないときも、マップがあることを隠すため 404 にする（決定 U1）。
  app.get("/shared-maps/:id", async (c) => {
    const userId = c.get("user").userId;
    const mapId = c.req.param("id");
    const deps = resolve(c.env);
    const shared = await deps.maps.getShared(mapId);
    if (shared === null || shared.visibility === "private" || shared.latest === null) notFound();
    const isOwner = shared.ownerUserId === userId;
    if (shared.visibility === "link" && !isOwner && !sameKey(c.req.query("key"), shared.shareKey)) {
      notFound();
    }
    const snapshot = snapshotOf(mapId, shared.latest);
    const content = await contentViewOf(deps, snapshot);
    const body: SharedMapView = {
      id: shared.id,
      visibility: shared.visibility,
      version: shared.latest.version,
      publishedAt: shared.latest.createdAt,
      isOwner,
      title: content.title,
      description: content.description,
      nodes: content.nodes,
      edges: content.edges,
      checkCount: content.checks.length,
    };
    return c.json(body, 200, { "cache-control": "no-store" });
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
