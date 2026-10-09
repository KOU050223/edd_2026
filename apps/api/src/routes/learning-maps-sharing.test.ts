/**
 * 学習マップの共有と版（#244 の S1-a・T1-a・T2・T5）。
 *
 * 持ち主の手元のマップと共有の版を分け、「共有へ上げる」で版になること、
 * 持ち主以外は版を読めるが手元・版を変えられないこと、復元が新しい版を作り履歴を書き換えないことを確かめる。
 */

import { beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import type { Concept } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { stubAuth } from "../auth/test-auth.js";
import type {
  LearningMapView,
  ListMapVersionsResponse,
  ListSharedMapsResponse,
  MapPublishPreview,
  MapVersionResponse,
  PublishLearningMapResponse,
  SaveLearningMapResponse,
  SharedMapView,
} from "../contract/learning-maps.js";
import {
  createInMemoryRepositoryStore,
  InMemoryIdentityRepository,
  InMemoryLearningMapRepository,
  InMemoryPersonalCheckRepository,
  type InMemoryRepositoryStore,
} from "../repository/memory.js";
import { personalCheck } from "../maps/test-map.js";
import { createLearningMapsRoute } from "./learning-maps.js";

let store: InMemoryRepositoryStore;
let checks: InMemoryPersonalCheckRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;
let keys: number;
let nowMs: number;

const ENV = {} as unknown as CloudflareBindings;
const TOKENS = { "token-a": "user-a", "token-b": "user-b" };

const FIXED_CONCEPTS: Concept[] = [
  {
    id: "go.defer",
    label: "defer",
    language: "go",
    summary: "関数を抜けるときに実行する。",
    prerequisites: [],
    source: { kind: "manual" },
  },
];

beforeEach(() => {
  store = createInMemoryRepositoryStore();
  store.fixedObjectives.push({
    id: "go.defer:execution_timing",
    conceptId: "go.defer",
    label: "実行タイミング",
    source: "manual",
  });
  const identity = new InMemoryIdentityRepository(store);
  const maps = new InMemoryLearningMapRepository(store);
  checks = new InMemoryPersonalCheckRepository(store);
  keys = 0;
  nowMs = 1_000;
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(TOKENS));
  app.route(
    "/v1",
    createLearningMapsRoute(() => ({
      identity,
      maps,
      checks,
      fixedConcepts: FIXED_CONCEPTS,
      newKey: () => `k${String(++keys).padStart(7, "0")}`,
      nowIso: () => new Date(nowMs).toISOString(),
      nowMs: () => nowMs,
    })),
  );
});

function send(method: string, path: string, token: string, body?: unknown) {
  return app.request(
    `/v1${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    ENV,
  );
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}

const TWO_NODES = {
  title: "Rust 入門",
  description: "所有権まで",
  nodes: [
    { kind: "own", ref: "new:a", label: "変数", summary: "let で束縛する。" },
    { kind: "own", ref: "new:b", label: "所有権", summary: "値の持ち主は1つ。" },
  ],
  edges: [{ from: "new:a", to: "new:b" }],
};

async function create(body: unknown = TWO_NODES, token = "token-a") {
  return json<SaveLearningMapResponse>(await send("POST", "/learning-maps", token, body), 201);
}

function preview(mapId: string, query = "", token = "token-a") {
  return send("GET", `/learning-maps/${mapId}/versions:preview${query}`, token);
}

/** 確認画面を開いて、見た中身のまま上げる。 */
async function publish(
  mapId: string,
  visibility: "link" | "public" = "link",
  includeChecks?: boolean,
): Promise<PublishLearningMapResponse> {
  const shown = await json<MapPublishPreview>(
    await preview(
      mapId,
      includeChecks === undefined ? "" : `?includeChecks=${String(includeChecks)}`,
    ),
  );
  return json<PublishLearningMapResponse>(
    await send("POST", `/learning-maps/${mapId}/versions`, "token-a", {
      visibility,
      includeChecks: shown.includeChecks,
      baseVersion: shown.latest?.version ?? null,
      contentHash: shown.contentHash,
    }),
    201,
  );
}

/**
 * 持ち主以外として共有の側を読む。「リンクだけ」なら持ち主の画面から鍵を取って付ける（決定 U1）。
 */
async function readShared(mapId: string, token = "token-b") {
  const own = await json<LearningMapView>(await send("GET", `/learning-maps/${mapId}`, "token-a"));
  const query = own.shareKey === null ? "" : `?key=${own.shareKey}`;
  return send("GET", `/shared-maps/${mapId}${query}`, token);
}

/** ノードの表示名を変えて手元を保存する。 */
async function rename(map: LearningMapView, label: string) {
  return json<SaveLearningMapResponse>(
    await send("PUT", `/learning-maps/${map.id}`, "token-a", {
      title: map.title,
      description: map.description,
      nodes: map.nodes.map((node, index) =>
        node.kind === "own"
          ? {
              kind: "own",
              ref: node.conceptId,
              label: index === 0 ? label : node.label,
              summary: node.summary,
            }
          : { kind: "reference", conceptId: node.conceptId },
      ),
      edges: map.edges,
    }),
  );
}

/** 作成時の確認問題（#247）を1組入れる。 */
async function putCreationCheck(mapId: string, conceptId: string, objectiveId?: string) {
  const saved = await checks.put("user-a", personalCheck(conceptId, objectiveId), 0, {
    mapId,
    origin: "map_creation",
  });
  expect(saved).toEqual({ saved: true });
}

describe("確認画面（S1-a）", () => {
  test("まだ版が無ければ、出ていく中身の全部が「足した」差分になる", async () => {
    const { map } = await create();
    const body = await json<MapPublishPreview>(await preview(map.id));
    expect(body.latest).toBeNull();
    expect(body.visibility).toBe("private");
    expect(body.hasChanges).toBe(true);
    expect(body.includeChecks).toBe(true);
    expect(body.content.nodes.map((node) => node.conceptId)).toEqual(
      map.nodes.map((node) => node.conceptId),
    );
    expect(body.diff.added.map((node) => node.conceptId)).toEqual(
      map.nodes.map((node) => node.conceptId),
    );
    expect(body.diff.title).toEqual({ before: "", after: "Rust 入門" });
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("作成時の確認問題は含めるかを選べ、含めなくても数は出る", async () => {
    const { map } = await create();
    const node = map.nodes[1]!.conceptId;
    await putCreationCheck(map.id, node);
    // 解くときに作った組（on_demand）は共有へ出さない（#247）。
    await checks.put("user-a", personalCheck(map.nodes[0]!.conceptId), 0, { mapId: map.id });

    const included = await json<MapPublishPreview>(await preview(map.id));
    expect(included.availableChecks).toBe(1);
    expect(included.content.checks.map((check) => check.conceptId)).toEqual([node]);
    expect(included.diff.checks.added).toHaveLength(1);

    const excluded = await json<MapPublishPreview>(await preview(map.id, "?includeChecks=false"));
    expect(excluded.availableChecks).toBe(1);
    expect(excluded.content.checks).toEqual([]);
    expect(excluded.contentHash).not.toBe(included.contentHash);

    expect((await preview(map.id, "?includeChecks=yes")).status).toBe(400);
  });

  test("持ち主以外は確認画面を開けない", async () => {
    const { map } = await create();
    expect((await preview(map.id, "", "token-b")).status).toBe(404);
  });
});

describe("共有へ上げる（T1-a）", () => {
  test("上げると版 1 になり、持ち主以外が読める", async () => {
    const { map } = await create();
    const published = await publish(map.id, "link");
    expect(published.version).toMatchObject({
      version: 1,
      authorUserId: "user-a",
      restoredFrom: null,
      summary: { added: 2, removed: 0, changed: 0, titleChanged: true },
    });
    expect(published.visibility).toBe("link");

    const own = await json<LearningMapView>(
      await send("GET", `/learning-maps/${map.id}`, "token-a"),
    );
    expect(own.visibility).toBe("link");
    expect(own.latestVersion).toBe(1);

    const shared = await json<SharedMapView>(await readShared(map.id));
    expect(shared).toMatchObject({
      id: map.id,
      visibility: "link",
      version: 1,
      isOwner: false,
      title: "Rust 入門",
      checkCount: 0,
    });
    expect(shared.nodes).toEqual(map.nodes);
    expect(shared.edges).toEqual(map.edges);
  });

  test("手元を直しても、上げるまで共有の側は変わらない", async () => {
    const { map } = await create();
    await publish(map.id);
    const renamed = await rename(map, "束縛");

    const shared = await json<SharedMapView>(await readShared(map.id));
    expect(shared.nodes[0]).toMatchObject({ label: "変数" });

    const shown = await json<MapPublishPreview>(await preview(map.id));
    expect(shown.hasChanges).toBe(true);
    expect(shown.diff.changed).toEqual([
      expect.objectContaining({
        conceptId: map.nodes[0]!.conceptId,
        fields: ["label"],
        before: expect.objectContaining({ label: "変数" }),
        after: expect.objectContaining({ label: "束縛" }),
      }),
    ]);

    const second = await publish(renamed.map.id);
    expect(second.version).toMatchObject({ version: 2, summary: { changed: 1 } });
    const updated = await json<SharedMapView>(await readShared(map.id));
    expect(updated).toMatchObject({ version: 2 });
    expect(updated.nodes[0]).toMatchObject({ label: "束縛" });
  });

  test("確認画面のあとに手元が変わったら、上げずに 409 を返す", async () => {
    const { map } = await create();
    const shown = await json<MapPublishPreview>(await preview(map.id));
    await rename(map, "束縛");
    const response = await send("POST", `/learning-maps/${map.id}/versions`, "token-a", {
      visibility: "link",
      includeChecks: true,
      baseVersion: null,
      contentHash: shown.contentHash,
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("content_changed");
    expect((await send("GET", `/shared-maps/${map.id}`, "token-b")).status).toBe(404);
  });

  test("確認画面のあとに別の端末で上げられていたら 409、中身が同じなら新しい版にしない", async () => {
    const { map } = await create();
    const shown = await json<MapPublishPreview>(await preview(map.id));
    await publish(map.id);

    const stale = await send("POST", `/learning-maps/${map.id}/versions`, "token-a", {
      visibility: "link",
      includeChecks: true,
      baseVersion: null,
      contentHash: shown.contentHash,
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toBe("version_conflict");

    const again = await json<MapPublishPreview>(await preview(map.id));
    expect(again.hasChanges).toBe(false);
    const same = await send("POST", `/learning-maps/${map.id}/versions`, "token-a", {
      visibility: "public",
      includeChecks: true,
      baseVersion: 1,
      contentHash: again.contentHash,
    });
    expect(same.status).toBe(409);
    expect(await same.text()).toBe("no_changes");
  });

  test("持ち主以外は上げられず、手元も変えられない", async () => {
    const { map } = await create();
    await publish(map.id);
    const shown = await json<MapPublishPreview>(await preview(map.id));
    const attempts = [
      send("POST", `/learning-maps/${map.id}/versions`, "token-b", {
        visibility: "link",
        includeChecks: false,
        baseVersion: 1,
        contentHash: shown.contentHash,
      }),
      send("PUT", `/learning-maps/${map.id}`, "token-b", TWO_NODES),
      send("PUT", `/learning-maps/${map.id}/visibility`, "token-b", { visibility: "private" }),
      send("GET", `/learning-maps/${map.id}/versions`, "token-b"),
      send("GET", `/learning-maps/${map.id}/versions/1`, "token-b"),
      send("POST", `/learning-maps/${map.id}/versions/1/restore`, "token-b", { baseVersion: 1 }),
      send("DELETE", `/learning-maps/${map.id}`, "token-b"),
    ];
    for (const response of await Promise.all(attempts)) expect(response.status).toBe(404);
    expect((await readShared(map.id)).status).toBe(200);
  });

  test("共有に含めた作成時の確認問題は版に写り、あとで消しても版は変わらない", async () => {
    const { map } = await create();
    const node = map.nodes[1]!.conceptId;
    await putCreationCheck(map.id, node);
    await publish(map.id);
    expect((await json<SharedMapView>(await readShared(map.id))).checkCount).toBe(1);

    await checks.deleteAllByUser("user-a");
    const version = await json<MapVersionResponse>(
      await send("GET", `/learning-maps/${map.id}/versions/1`, "token-a"),
    );
    expect(version.content.checks.map((check) => check.conceptId)).toEqual([node]);
    expect(version.version.checksIncluded).toBe(true);
  });

  test("含めないを選ぶと、版に確認問題は入らない", async () => {
    const { map } = await create();
    await putCreationCheck(map.id, map.nodes[1]!.conceptId);
    const published = await publish(map.id, "link", false);
    expect(published.version.checksIncluded).toBe(false);
    expect((await json<SharedMapView>(await readShared(map.id))).checkCount).toBe(0);
    // 次の確認画面の既定は、前の版で選んだもの。
    expect((await json<MapPublishPreview>(await preview(map.id))).includeChecks).toBe(false);
  });

  test("自分の別のマップへの参照は元の中身を写し、固定の Concept は今の一覧から引く", async () => {
    const other = await create({
      title: "元",
      nodes: [{ kind: "own", ref: "new:x", label: "借用", summary: "参照を貸す。" }],
    });
    const borrowed = other.map.nodes[0]!.conceptId;
    await send("PUT", `/learning-maps/${other.map.id}/nodes/${borrowed}/objectives`, "token-a", {
      objectives: [{ label: "& と &mut" }],
    });
    const { map } = await create({
      title: "参照つき",
      nodes: [
        { kind: "reference", conceptId: "go.defer" },
        { kind: "reference", conceptId: borrowed },
      ],
    });
    await publish(map.id);
    // 元のマップを消しても、共有の側には上げた時点の中身が残る。
    expect((await send("DELETE", `/learning-maps/${other.map.id}`, "token-a")).status).toBe(204);

    const shared = await json<SharedMapView>(await readShared(map.id));
    expect(shared.nodes).toEqual([
      {
        kind: "reference",
        conceptId: "go.defer",
        origin: {
          label: "defer",
          summary: "関数を抜けるときに実行する。",
          mapId: null,
          objectives: [
            { id: "go.defer:execution_timing", label: "実行タイミング", source: "manual" },
          ],
        },
      },
      {
        kind: "reference",
        conceptId: borrowed,
        origin: {
          label: "借用",
          summary: "参照を貸す。",
          mapId: null,
          objectives: [expect.objectContaining({ label: "& と &mut" })],
        },
      },
    ]);
  });
});

describe("手元の書き換えとの競合（PR #294 のレビュー）", () => {
  test("読んだあとに手元が直されたら、上げも復元もしない", async () => {
    const { map } = await create();
    await publish(map.id);
    await rename(map, "束縛");
    await publish(map.id);
    const repository = new InMemoryLearningMapRepository(store);
    const read = (await repository.get("user-a", map.id))!;
    // 読んだあとに、別の画面で手元を直した。
    await rename(map, "別の画面");

    const summary = {
      added: 0,
      removed: 0,
      changed: 0,
      titleChanged: false,
      reordered: false,
      checksAdded: 0,
      checksRemoved: 0,
    };
    expect(
      await repository.publishVersion("user-a", map.id, {
        expectedLatest: 2,
        expectedRevision: read.revision,
        scope: "link",
        shareKey: "k".repeat(32),
        content: "{}",
        contentHash: "0".repeat(64),
        checksIncluded: false,
        summary,
        nowIso: "2026-10-09T00:00:00.000Z",
        nowMs: 9,
      }),
    ).toBe(false);
    expect(
      await repository.restoreVersion("user-a", map.id, {
        fromVersion: 1,
        expectedLatest: 2,
        expectedRevision: read.revision,
        content: { title: "t", description: "", nodes: [], edges: [] },
        objectives: [],
        summary,
        nowIso: "2026-10-09T00:00:00.000Z",
        nowMs: 9,
      }),
    ).toBe(false);
    const after = (await repository.get("user-a", map.id))!;
    expect(after.latestVersion).toBe(2);
    expect(after.nodes[0]).toMatchObject({ label: "別の画面" });
    expect(after.revision).toBeGreaterThan(read.revision);
  });
});

describe("共有の範囲（T5）", () => {
  test("版が無いうちは範囲だけで共有へ切り替えられない", async () => {
    const { map } = await create();
    const response = await send("PUT", `/learning-maps/${map.id}/visibility`, "token-a", {
      visibility: "link",
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("not_published");
  });

  test("非公開に戻すと持ち主以外は読めず、版は残って再び共有できる", async () => {
    const { map } = await create();
    await publish(map.id, "link");
    await json(
      await send("PUT", `/learning-maps/${map.id}/visibility`, "token-a", {
        visibility: "private",
      }),
    );
    expect((await send("GET", `/shared-maps/${map.id}`, "token-b")).status).toBe(404);
    // 持ち主も共有の側からは読まない（手元を読む）。
    expect((await send("GET", `/shared-maps/${map.id}`, "token-a")).status).toBe(404);

    await json(
      await send("PUT", `/learning-maps/${map.id}/visibility`, "token-a", { visibility: "public" }),
    );
    const shared = await json<SharedMapView>(await readShared(map.id));
    expect(shared).toMatchObject({ visibility: "public", version: 1 });
  });

  test("全員の一覧には public だけが、共有の側の題名で新しく上げた順に出る", async () => {
    const first = await create({ ...TWO_NODES, title: "一つ目" });
    const second = await create({ ...TWO_NODES, title: "二つ目" });
    const linkOnly = await create({ ...TWO_NODES, title: "リンクだけ" });
    await create({ ...TWO_NODES, title: "非公開" });
    await publish(first.map.id, "public");
    nowMs += 1_000;
    await publish(second.map.id, "public");
    await publish(linkOnly.map.id, "link");
    // 手元の題名を変えても、一覧は上げた版の題名のまま。
    await send("PUT", `/learning-maps/${first.map.id}`, "token-a", {
      ...TWO_NODES,
      title: "手元だけの題名",
      nodes: first.map.nodes.map((node) =>
        node.kind === "own"
          ? { kind: "own", ref: node.conceptId, label: node.label, summary: node.summary }
          : node,
      ),
      edges: first.map.edges,
    });

    const listed = await json<ListSharedMapsResponse>(await send("GET", "/shared-maps", "token-b"));
    expect(listed.maps).toEqual([
      {
        id: second.map.id,
        title: "二つ目",
        description: "所有権まで",
        nodeCount: 2,
        version: 1,
        publishedAt: new Date(2_000).toISOString(),
      },
      expect.objectContaining({ id: first.map.id, title: "一つ目" }),
    ]);
  });
});

describe("「リンクだけ」の鍵（決定 U1）", () => {
  test("鍵が合わなければ持ち主以外には見せず、持ち主は鍵なしで読める", async () => {
    const { map } = await create();
    await publish(map.id, "link");
    const own = await json<LearningMapView>(
      await send("GET", `/learning-maps/${map.id}`, "token-a"),
    );
    expect(own.shareKey).toMatch(/^[a-z0-9]{32}$/);

    expect((await send("GET", `/shared-maps/${map.id}`, "token-b")).status).toBe(404);
    expect((await send("GET", `/shared-maps/${map.id}?key=wrong`, "token-b")).status).toBe(404);
    const wrongSameLength = "x".repeat(32);
    expect(
      (await send("GET", `/shared-maps/${map.id}?key=${wrongSameLength}`, "token-b")).status,
    ).toBe(404);
    expect(
      (await send("GET", `/shared-maps/${map.id}?key=${own.shareKey!}`, "token-b")).status,
    ).toBe(200);
    expect((await send("GET", `/shared-maps/${map.id}`, "token-a")).status).toBe(200);
  });

  test("「リンクだけ」のまま版を上げても鍵は変わらず、切り替え直すと作り直す", async () => {
    const { map } = await create();
    await publish(map.id, "link");
    const keyOf = async () =>
      (await json<LearningMapView>(await send("GET", `/learning-maps/${map.id}`, "token-a")))
        .shareKey;
    const first = await keyOf();
    await rename(map, "束縛");
    await publish(map.id, "link");
    expect(await keyOf()).toBe(first);

    await json(
      await send("PUT", `/learning-maps/${map.id}/visibility`, "token-a", { visibility: "public" }),
    );
    expect(await keyOf()).toBeNull();
    await json(
      await send("PUT", `/learning-maps/${map.id}/visibility`, "token-a", { visibility: "link" }),
    );
    const second = await keyOf();
    expect(second).toMatch(/^[a-z0-9]{32}$/);
    expect(second).not.toBe(first);
    // 前のリンクは使えない。
    expect((await send("GET", `/shared-maps/${map.id}?key=${first!}`, "token-b")).status).toBe(404);

    await json(
      await send("PUT", `/learning-maps/${map.id}/visibility`, "token-a", {
        visibility: "private",
      }),
    );
    expect(await keyOf()).toBeNull();
  });

  test("全員に共有したマップの参照からマップ ID が分かっても、「リンクだけ」のマップは開けない", async () => {
    const hidden = await create({
      title: "リンクだけ",
      nodes: [{ kind: "own", ref: "new:x", label: "借用", summary: "参照を貸す。" }],
    });
    await publish(hidden.map.id, "link");
    const borrowed = hidden.map.nodes[0]!.conceptId;
    const { map } = await create({
      title: "全員",
      nodes: [{ kind: "reference", conceptId: borrowed }],
    });
    await publish(map.id, "public");

    const shown = await json<SharedMapView>(await send("GET", `/shared-maps/${map.id}`, "token-b"));
    const leaked = shown.nodes[0]!.conceptId.split(".")[0]!;
    expect(leaked).toBe(hidden.map.id);
    expect((await send("GET", `/shared-maps/${leaked}`, "token-b")).status).toBe(404);
  });
});

describe("版の履歴と復元（T2）", () => {
  test("復元は過去の版の中身で新しい版を作り、履歴と過去の版は書き換えない", async () => {
    const { map } = await create();
    const node = map.nodes[1]!.conceptId;
    const saved = await json<{ objectives: { id: string }[] }>(
      await send("PUT", `/learning-maps/${map.id}/nodes/${node}/objectives`, "token-a", {
        objectives: [{ label: "代入で移る" }],
      }),
    );
    const kept = saved.objectives[0]!.id;
    await publish(map.id);

    nowMs += 1_000;
    const renamed = await rename(map, "束縛");
    const replaced = await json<{ objectives: { id: string }[] }>(
      await send("PUT", `/learning-maps/${map.id}/nodes/${node}/objectives`, "token-a", {
        objectives: [{ label: "別の項目" }],
      }),
    );
    const dropped = replaced.objectives[0]!.id;
    // 版 1 に無い項目を狙った確認問題は、復元で項目と一緒に消える。
    await checks.put("user-a", personalCheck(node, dropped), 0, { mapId: map.id });
    await publish(renamed.map.id);

    nowMs += 1_000;
    const restored = await json<PublishLearningMapResponse>(
      await send("POST", `/learning-maps/${map.id}/versions/1/restore`, "token-a", {
        baseVersion: 2,
      }),
      201,
    );
    expect(restored.version).toMatchObject({
      version: 3,
      restoredFrom: 1,
      summary: { changed: 2 },
    });

    const history = await json<ListMapVersionsResponse>(
      await send("GET", `/learning-maps/${map.id}/versions`, "token-a"),
    );
    expect(history.versions.map((version) => [version.version, version.restoredFrom])).toEqual([
      [3, 1],
      [2, null],
      [1, null],
    ]);
    const v1 = await json<MapVersionResponse>(
      await send("GET", `/learning-maps/${map.id}/versions/1`, "token-a"),
    );
    const v2 = await json<MapVersionResponse>(
      await send("GET", `/learning-maps/${map.id}/versions/2`, "token-a"),
    );
    const v3 = await json<MapVersionResponse>(
      await send("GET", `/learning-maps/${map.id}/versions/3`, "token-a"),
    );
    expect(v2.content.nodes[0]).toMatchObject({ label: "束縛" });
    expect(v3.content).toEqual(v1.content);

    // 手元のマップも版 1 の中身に戻る（項目の ID も戻る）。
    const own = await json<LearningMapView>(
      await send("GET", `/learning-maps/${map.id}`, "token-a"),
    );
    expect(own.nodes[0]).toMatchObject({ label: "変数" });
    expect(own.nodes[1]).toMatchObject({ objectives: [{ id: kept, label: "代入で移る" }] });
    expect(own.latestVersion).toBe(3);
    expect((await checks.listAllByUser("user-a")).map((check) => check.objectiveId)).toEqual([]);

    // 取り込んだ人には新しい版として届く。
    const shared = await json<SharedMapView>(await readShared(map.id));
    expect(shared).toMatchObject({ version: 3 });
    expect(shared.nodes[0]).toMatchObject({ label: "変数" });
  });

  test("いちばん新しい版は復元できず、読んだ版が古ければ 409", async () => {
    const { map } = await create();
    await publish(map.id);
    await rename(map, "束縛");
    await publish(map.id);

    const latest = await send("POST", `/learning-maps/${map.id}/versions/2/restore`, "token-a", {
      baseVersion: 2,
    });
    expect(latest.status).toBe(409);
    expect(await latest.text()).toBe("already_latest");

    const stale = await send("POST", `/learning-maps/${map.id}/versions/1/restore`, "token-a", {
      baseVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toBe("version_conflict");

    for (const version of ["9", "0", "abc"]) {
      const missing = await send("GET", `/learning-maps/${map.id}/versions/${version}`, "token-a");
      expect(missing.status).toBe(404);
    }
  });

  test("マップを消すと版も消え、共有の側も読めなくなる", async () => {
    const { map } = await create();
    await publish(map.id, "public");
    expect((await send("DELETE", `/learning-maps/${map.id}`, "token-a")).status).toBe(204);
    expect((await send("GET", `/shared-maps/${map.id}`, "token-b")).status).toBe(404);
    expect(
      (await json<ListSharedMapsResponse>(await send("GET", "/shared-maps", "token-b"))).maps,
    ).toEqual([]);
  });
});
