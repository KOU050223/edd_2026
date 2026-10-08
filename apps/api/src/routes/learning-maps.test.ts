import { beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import type { Concept } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { stubAuth } from "../auth/test-auth.js";
import {
  MAX_MAPS_PER_USER,
  type LearningMapView,
  type ListClientMapConceptsResponse,
  type ListLearningMapsResponse,
  type PutLearningObjectivesResponse,
  type SaveLearningMapResponse,
} from "../contract/learning-maps.js";
import {
  createInMemoryRepositoryStore,
  InMemoryIdentityRepository,
  InMemoryLearningMapRepository,
  InMemoryPersonalCheckRepository,
  type InMemoryRepositoryStore,
} from "../repository/memory.js";
import type { StoredLearningObjective } from "../repository/types.js";
import { personalCheck } from "../maps/test-map.js";
import { createLearningMapsRoute } from "./learning-maps.js";

// 応答の JSON 化は本番 app の onError が担う。エラーは本文の種別（平文）で確かめる。
let store: InMemoryRepositoryStore;
let identity: InMemoryIdentityRepository;
let maps: InMemoryLearningMapRepository;
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
/** 固定の項目は表（migrations/0017_fixed_objectives.sql）から読む。テストはストアへ入れる。 */
const FIXED_OBJECTIVES: StoredLearningObjective[] = [
  {
    id: "go.defer:execution_timing",
    conceptId: "go.defer",
    label: "実行タイミング",
    source: "manual",
  },
];

beforeEach(() => {
  store = createInMemoryRepositoryStore();
  store.fixedObjectives.splice(0, store.fixedObjectives.length, ...FIXED_OBJECTIVES);
  identity = new InMemoryIdentityRepository(store);
  maps = new InMemoryLearningMapRepository(store);
  keys = 0;
  nowMs = 1_000;
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(TOKENS));
  app.route(
    "/v1",
    createLearningMapsRoute(() => ({
      identity,
      // テストが途中で差し替えられるよう、リクエストのたびに今の値を読む。
      maps,
      fixedConcepts: FIXED_CONCEPTS,
      // 呼ばれた順に k0000001, k0000002 … を返す。採番の結果をテストで言い当てられるようにする。
      newKey: () => `k${String(++keys).padStart(7, "0")}`,
      nowIso: () => new Date(nowMs).toISOString(),
      nowMs: () => nowMs,
    })),
  );
});

function send(method: string, path: string, token: string, body?: unknown) {
  return app.request(
    path,
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
  const response = await send("POST", "/v1/learning-maps", token, body);
  expect(response.status).toBe(201);
  return (await response.json()) as SaveLearningMapResponse;
}

test("マップを作ると、ID を振ったノードと線を返し、一覧と表示で読める", async () => {
  const { map, assigned } = await create();

  // マップは m + 8 文字、ノードは <マップの ID>.<8 文字>。
  expect(map.id).toBe("mk0000001");
  expect(assigned).toEqual({ "new:a": "mk0000001.k0000002", "new:b": "mk0000001.k0000003" });
  expect(map.visibility).toBe("private");
  expect(map.nodes).toEqual([
    {
      kind: "own",
      conceptId: "mk0000001.k0000002",
      label: "変数",
      summary: "let で束縛する。",
      objectives: [],
    },
    {
      kind: "own",
      conceptId: "mk0000001.k0000003",
      label: "所有権",
      summary: "値の持ち主は1つ。",
      objectives: [],
    },
  ]);
  expect(map.edges).toEqual([{ from: "mk0000001.k0000002", to: "mk0000001.k0000003" }]);

  const list = (await (
    await send("GET", "/v1/learning-maps", "token-a")
  ).json()) as ListLearningMapsResponse;
  expect(list.maps).toEqual([
    {
      id: map.id,
      title: "Rust 入門",
      description: "所有権まで",
      visibility: "private",
      nodeCount: 2,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
    },
  ]);

  const shown = await send("GET", `/v1/learning-maps/${map.id}`, "token-a");
  expect(shown.status).toBe(200);
  expect(await shown.json()).toEqual(map);
});

test("一覧は更新の新しい順に並ぶ", async () => {
  const first = await create({ title: "1つ目" });
  nowMs = 2_000;
  await create({ title: "2つ目" });
  nowMs = 3_000;
  await send("PUT", `/v1/learning-maps/${first.map.id}`, "token-a", { title: "1つ目（直した）" });

  const list = (await (
    await send("GET", "/v1/learning-maps", "token-a")
  ).json()) as ListLearningMapsResponse;
  expect(list.maps.map((map) => map.title)).toEqual(["1つ目（直した）", "2つ目"]);
});

test("他の利用者のマップは取得・編集・削除とも 404 になる", async () => {
  const { map } = await create();
  const path = `/v1/learning-maps/${map.id}`;

  expect((await send("GET", path, "token-b")).status).toBe(404);
  expect((await send("PUT", path, "token-b", { title: "乗っ取り" })).status).toBe(404);
  expect((await send("DELETE", path, "token-b")).status).toBe(404);
  expect(
    (
      await send("PUT", `${path}/nodes/${map.nodes[0]!.conceptId}/objectives`, "token-b", {
        objectives: [{ label: "x" }],
      })
    ).status,
  ).toBe(404);
  const list = (await (
    await send("GET", "/v1/learning-maps", "token-b")
  ).json()) as ListLearningMapsResponse;
  expect(list.maps).toEqual([]);

  // 持ち主からは変わらず読める。
  expect(((await (await send("GET", path, "token-a")).json()) as LearningMapView).title).toBe(
    "Rust 入門",
  );
});

test("前提を2つ持つノードは保存しない（#242、前提は1つまで）", async () => {
  const response = await send("POST", "/v1/learning-maps", "token-a", {
    title: "t",
    nodes: [
      { kind: "own", ref: "new:a", label: "a", summary: "s" },
      { kind: "own", ref: "new:b", label: "b", summary: "s" },
      { kind: "own", ref: "new:c", label: "c", summary: "s" },
    ],
    edges: [
      { from: "new:a", to: "new:c" },
      { from: "new:b", to: "new:c" },
    ],
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("a node must have at most one prerequisite: new:c");
  expect(store.learningMaps.size).toBe(0);
});

test("線が循環すると保存しない", async () => {
  const response = await send("POST", "/v1/learning-maps", "token-a", {
    ...TWO_NODES,
    edges: [
      { from: "new:a", to: "new:b" },
      { from: "new:b", to: "new:a" },
    ],
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toBe("edges must not form a cycle");
  expect(store.learningMaps.size).toBe(0);
});

test("線がこのマップに無いノードを指すと保存しない", async () => {
  const response = await send("POST", "/v1/learning-maps", "token-a", {
    ...TWO_NODES,
    edges: [{ from: "new:a", to: "go.defer" }],
  });
  expect(response.status).toBe(400);
});

test("上限を超える入力は保存しない", async () => {
  const tooMany = Array.from({ length: 51 }, (_, i) => ({
    kind: "own",
    ref: `new:${i}`,
    label: `n${i}`,
    summary: "s",
  }));
  for (const body of [
    { title: "あ".repeat(81) },
    { title: "t", description: "あ".repeat(401) },
    { title: "t", nodes: [{ kind: "own", ref: "new:a", label: "あ".repeat(41), summary: "s" }] },
    { title: "t", nodes: [{ kind: "own", ref: "new:a", label: "l", summary: "あ".repeat(201) }] },
    // 概要は必須（確認問題の生成の入力になる）。空白だけも空として扱う。
    { title: "t", nodes: [{ kind: "own", ref: "new:a", label: "l", summary: "  " }] },
    { title: "t", nodes: tooMany },
    { title: "t", unknown: 1 },
  ]) {
    expect((await send("POST", "/v1/learning-maps", "token-a", body)).status).toBe(400);
  }
  expect(store.learningMaps.size).toBe(0);
});

test("1人が持てるマップは 20 まで", async () => {
  for (let i = 0; i < MAX_MAPS_PER_USER; i++) await create({ title: `map ${i}` });
  const response = await send("POST", "/v1/learning-maps", "token-a", { title: "21" });
  expect(response.status).toBe(409);
  expect(await response.text()).toBe("learning_map_limit_reached");

  // 上限は1人ずつ数える。
  await create({ title: "別の人" }, "token-b");
});

test("既存の Concept を参照で置くと、元の表示名・概要・項目が出る", async () => {
  const other = await create();
  const otherNodeId = other.map.nodes[0]!.conceptId;

  const { map } = await create({
    title: "Go と Rust",
    nodes: [
      { kind: "reference", conceptId: "go.defer" },
      { kind: "reference", conceptId: otherNodeId },
      { kind: "own", ref: "new:x", label: "後片付け", summary: "資源を閉じる。" },
    ],
    // 参照のノードどうし・参照から手で作ったノードへも線を引ける（前提は1つまで）。
    edges: [
      { from: "go.defer", to: otherNodeId },
      { from: otherNodeId, to: "new:x" },
    ],
  });

  expect(map.nodes[0]).toEqual({
    kind: "reference",
    conceptId: "go.defer",
    origin: {
      label: "defer",
      summary: "関数を抜けるときに実行する。",
      mapId: null,
      objectives: [{ id: "go.defer:execution_timing", label: "実行タイミング", source: "manual" }],
    },
  });
  expect(map.nodes[1]).toEqual({
    kind: "reference",
    conceptId: otherNodeId,
    origin: { label: "変数", summary: "let で束縛する。", mapId: other.map.id, objectives: [] },
  });

  // 元のマップを消すと、参照のノードは残り、元が見つからない（null）と出る。
  await send("DELETE", `/v1/learning-maps/${other.map.id}`, "token-a");
  const shown = (await (
    await send("GET", `/v1/learning-maps/${map.id}`, "token-a")
  ).json()) as LearningMapView;
  expect(shown.nodes[1]).toEqual({ kind: "reference", conceptId: otherNodeId, origin: null });
});

test("元が消えた参照を残したままでも、マップを置き換えられる", async () => {
  const other = await create();
  const otherNodeId = other.map.nodes[0]!.conceptId;
  const { map } = await create({
    title: "参照あり",
    nodes: [{ kind: "reference", conceptId: otherNodeId }],
  });
  await send("DELETE", `/v1/learning-maps/${other.map.id}`, "token-a");

  // 画面は読んだノードをそのまま送り返す。題名だけを変えても 400 にしない。
  const response = await send("PUT", `/v1/learning-maps/${map.id}`, "token-a", {
    title: "参照あり（改）",
    nodes: [{ kind: "reference", conceptId: otherNodeId }],
  });
  expect(response.status).toBe(200);
  const saved = (await response.json()) as SaveLearningMapResponse;
  expect(saved.map.title).toBe("参照あり（改）");
  expect(saved.map.nodes).toEqual([{ kind: "reference", conceptId: otherNodeId, origin: null }]);

  // 新しく足す参照は、これまでどおり元が無ければ拒否する。
  const added = await send("PUT", `/v1/learning-maps/${map.id}`, "token-a", {
    title: "t",
    nodes: [
      { kind: "reference", conceptId: otherNodeId },
      { kind: "reference", conceptId: "go.nothing" },
    ],
  });
  expect(added.status).toBe(400);
  expect(await added.text()).toBe("unknown concept: go.nothing");
});

test("存在しない Concept・他人のノード・同じマップのノードは参照で置けない", async () => {
  const others = await create(TWO_NODES, "token-b");
  for (const conceptId of ["go.nothing", others.map.nodes[0]!.conceptId]) {
    const response = await send("POST", "/v1/learning-maps", "token-a", {
      title: "t",
      nodes: [{ kind: "reference", conceptId }],
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(`unknown concept: ${conceptId}`);
  }

  const { map } = await create();
  const response = await send("PUT", `/v1/learning-maps/${map.id}`, "token-a", {
    title: "t",
    nodes: [{ kind: "reference", conceptId: map.nodes[0]!.conceptId }],
  });
  expect(response.status).toBe(400);
});

test("置き換えでは、残したノードの ID と項目を保ち、送らなかったノードは項目ごと消す", async () => {
  const { map } = await create();
  const [a, b] = map.nodes.map((node) => node.conceptId) as [string, string];
  for (const conceptId of [a, b]) {
    await send("PUT", `/v1/learning-maps/${map.id}/nodes/${conceptId}/objectives`, "token-a", {
      objectives: [{ label: `${conceptId} の項目` }],
    });
  }

  nowMs = 5_000;
  const response = await send("PUT", `/v1/learning-maps/${map.id}`, "token-a", {
    title: "Rust 入門（改）",
    nodes: [
      { kind: "own", ref: a, label: "変数と束縛", summary: "let で束縛する。" },
      { kind: "own", ref: "new:c", label: "借用", summary: "参照で貸す。" },
    ],
    edges: [{ from: a, to: "new:c" }],
  });
  expect(response.status).toBe(200);
  const saved = (await response.json()) as SaveLearningMapResponse;
  const c = saved.assigned["new:c"]!;

  expect(saved.map.title).toBe("Rust 入門（改）");
  expect(saved.map.updatedAt).toBe(new Date(5_000).toISOString());
  expect(saved.map.nodes.map((node) => node.conceptId)).toEqual([a, c]);
  expect(saved.map.nodes[0]).toMatchObject({
    label: "変数と束縛",
    objectives: [{ label: `${a} の項目` }],
  });
  expect(saved.map.edges).toEqual([{ from: a, to: c }]);
  expect(store.learningMaps.get(map.id)!.objectives.has(b)).toBe(false);
});

test("既存のノードは、このマップに今あるノードの ID でしか指せない", async () => {
  const { map } = await create();
  const response = await send("PUT", `/v1/learning-maps/${map.id}`, "token-a", {
    title: "t",
    nodes: [{ kind: "own", ref: `${map.id}.zzzzzzzz`, label: "l", summary: "s" }],
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toBe(`unknown node: ${map.id}.zzzzzzzz`);
});

test("「理解すること」は ID を振って保存し、送った順に置き換える", async () => {
  const { map } = await create();
  const node = map.nodes[0]!.conceptId;
  const path = `/v1/learning-maps/${map.id}/nodes/${node}/objectives`;

  const first = await send("PUT", path, "token-a", {
    objectives: [{ label: "let" }, { label: "mut" }],
  });
  expect(first.status).toBe(200);
  const created = (await first.json()) as PutLearningObjectivesResponse;
  expect(created.objectives).toEqual([
    { id: `${node}:k0000004`, label: "let", source: "manual" },
    { id: `${node}:k0000005`, label: "mut", source: "manual" },
  ]);

  // 並べ替えと書き換え、1つ削除。書き換えても ID は変えない。
  const second = await send("PUT", path, "token-a", {
    objectives: [{ id: `${node}:k0000005`, label: "mut で可変にする" }],
  });
  expect(((await second.json()) as PutLearningObjectivesResponse).objectives).toEqual([
    { id: `${node}:k0000005`, label: "mut で可変にする", source: "manual" },
  ]);
  const shown = (await (
    await send("GET", `/v1/learning-maps/${map.id}`, "token-a")
  ).json()) as LearningMapView;
  expect(shown.nodes[0]).toMatchObject({
    objectives: [{ id: `${node}:k0000005`, label: "mut で可変にする" }],
  });
});

test("「理解すること」の置き換えは、知らない ID・上限超え・参照のノード・無いノードを拒否する", async () => {
  const { map } = await create({
    title: "t",
    nodes: [
      { kind: "own", ref: "new:a", label: "l", summary: "s" },
      { kind: "reference", conceptId: "go.defer" },
    ],
  });
  const own = map.nodes[0]!.conceptId;
  const base = `/v1/learning-maps/${map.id}/nodes`;

  expect(
    (
      await send("PUT", `${base}/${own}/objectives`, "token-a", {
        objectives: [{ id: `${own}:nope`, label: "x" }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send("PUT", `${base}/${own}/objectives`, "token-a", {
        objectives: Array.from({ length: 9 }, (_, i) => ({ label: `項目 ${i}` })),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send("PUT", `${base}/${own}/objectives`, "token-a", {
        objectives: [{ label: "あ".repeat(81) }],
      })
    ).status,
  ).toBe(400);
  expect(
    (await send("PUT", `${base}/go.defer/objectives`, "token-a", { objectives: [{ label: "x" }] }))
      .status,
  ).toBe(400);
  expect(
    (
      await send("PUT", `${base}/${map.id}.missing0/objectives`, "token-a", {
        objectives: [{ label: "x" }],
      })
    ).status,
  ).toBe(404);
});

test("「理解すること」を読んでから書くまでの間にマップが消されたら、保存したと返さず 404 にする", async () => {
  const { map } = await create();
  const node = map.nodes[0]!.conceptId;
  // 別の端末の削除が、ルートの読み取りと書き込みの間に割り込んだ状態を作る。
  class DeletedBeforeWrite extends InMemoryLearningMapRepository {
    override async replaceObjectives(
      ...args: Parameters<InMemoryLearningMapRepository["replaceObjectives"]>
    ) {
      await this.delete("user-a", map.id);
      return super.replaceObjectives(...args);
    }
  }
  maps = new DeletedBeforeWrite(store);

  const response = await send(
    "PUT",
    `/v1/learning-maps/${map.id}/nodes/${node}/objectives`,
    "token-a",
    { objectives: [{ label: "x" }] },
  );
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("node not found");
});

test("マップを消すとノード・線・項目が残らず、退会でも消える", async () => {
  const { map } = await create();
  await send(
    "PUT",
    `/v1/learning-maps/${map.id}/nodes/${map.nodes[0]!.conceptId}/objectives`,
    "token-a",
    {
      objectives: [{ label: "x" }],
    },
  );

  const deleted = await send("DELETE", `/v1/learning-maps/${map.id}`, "token-a");
  expect(deleted.status).toBe(204);
  expect(store.learningMaps.size).toBe(0);
  expect((await send("GET", `/v1/learning-maps/${map.id}`, "token-a")).status).toBe(404);
  expect((await send("DELETE", `/v1/learning-maps/${map.id}`, "token-a")).status).toBe(404);

  await create();
  await create(TWO_NODES, "token-b");
  await identity.deleteUser("user-a");
  expect([...store.learningMaps.values()].map((stored) => stored.ownerUserId)).toEqual(["user-b"]);
});

describe("消したものの確認問題を消す（#242、2026-10-07 の決定）", () => {
  /** 保存済みの確認問題の (Concept, 狙い) の一覧。 */
  async function savedChecks(userId = "user-a") {
    const all = await new InMemoryPersonalCheckRepository(store).listAllByUser(userId);
    return all.map((check) => [check.conceptId, check.objectiveId ?? "concept"]);
  }

  async function putCheck(conceptId: string, objectiveId?: string, userId = "user-a") {
    await new InMemoryPersonalCheckRepository(store).put(
      userId,
      personalCheck(conceptId, objectiveId),
      0,
    );
  }

  test("マップを消すと、そのマップのノードの確認問題だけを消す", async () => {
    const other = await create();
    const { map } = await create({
      title: "t",
      nodes: [
        { kind: "own", ref: "new:x", label: "x", summary: "s" },
        { kind: "reference", conceptId: "go.defer" },
        { kind: "reference", conceptId: other.map.nodes[0]!.conceptId },
      ],
    });
    const x = map.nodes[0]!.conceptId;
    await putCheck(x);
    // 参照のノードの問題は元の Concept のもの。消さない。
    await putCheck("go.defer");
    await putCheck(other.map.nodes[0]!.conceptId);

    await send("DELETE", `/v1/learning-maps/${map.id}`, "token-a");

    expect(await savedChecks()).toEqual([
      ["go.defer", "concept"],
      [other.map.nodes[0]!.conceptId, "concept"],
    ]);
  });

  test("置き換えでノードを外すと、そのノードの確認問題を消す", async () => {
    const { map } = await create();
    const [a, b] = map.nodes.map((node) => node.conceptId) as [string, string];
    await putCheck(a);
    await putCheck(b);

    await send("PUT", `/v1/learning-maps/${map.id}`, "token-a", {
      title: "t",
      nodes: [{ kind: "own", ref: a, label: "a", summary: "s" }],
    });

    expect(await savedChecks()).toEqual([[a, "concept"]]);
  });

  test("項目を外すと、その項目を狙った組だけを消す", async () => {
    const { map } = await create();
    const node = map.nodes[0]!.conceptId;
    const path = `/v1/learning-maps/${map.id}/nodes/${node}/objectives`;
    const created = (await (
      await send("PUT", path, "token-a", { objectives: [{ label: "let" }, { label: "mut" }] })
    ).json()) as PutLearningObjectivesResponse;
    const [keep, drop] = created.objectives.map((objective) => objective.id) as [string, string];
    await putCheck(node, keep);
    await putCheck(node, drop);

    await send("PUT", path, "token-a", { objectives: [{ id: keep, label: "let" }] });

    expect(await savedChecks()).toEqual([[node, keep]]);
  });

  test("他の利用者の確認問題は消さない", async () => {
    const { map } = await create();
    const node = map.nodes[0]!.conceptId;
    await putCheck(node, undefined, "user-b");

    await send("DELETE", `/v1/learning-maps/${map.id}`, "token-a");

    expect(await savedChecks("user-b")).toEqual([[node, "concept"]]);
  });
});

test("VS Code 向けの一覧は、参照ではないノードを更新の新しいマップから返す", async () => {
  const older = await create();
  nowMs = 2_000;
  const newer = await create({
    title: "新しい方",
    nodes: [
      { kind: "reference", conceptId: "go.defer" },
      { kind: "own", ref: "new:x", label: "後片付け", summary: "資源を閉じる。" },
    ],
    edges: [{ from: "go.defer", to: "new:x" }],
  });
  const x = newer.assigned["new:x"]!;
  await send("PUT", `/v1/learning-maps/${newer.map.id}/nodes/${x}/objectives`, "token-a", {
    objectives: [{ label: "close を忘れない" }],
  });

  const response = await send("GET", "/v1/learning-maps:concepts", "token-a");
  expect(response.status).toBe(200);
  const body = (await response.json()) as ListClientMapConceptsResponse;
  expect(body.concepts.map((concept) => concept.id)).toEqual([
    x,
    ...older.map.nodes.map((node) => node.conceptId),
  ]);
  expect(body.concepts[0]).toEqual({
    id: x,
    label: "後片付け",
    summary: "資源を閉じる。",
    mapId: newer.map.id,
    mapTitle: "新しい方",
    prerequisites: ["go.defer"],
    objectives: [{ id: expect.stringMatching(new RegExp(`^${x}:`)), label: "close を忘れない" }],
  });

  const empty = (await (
    await send("GET", "/v1/learning-maps:concepts", "token-b")
  ).json()) as ListClientMapConceptsResponse;
  expect(empty.concepts).toEqual([]);
});

test("VS Code 向けの一覧は既定で 100 件、`limit` で自分のノードを全部まで読める", async () => {
  await create({
    title: "多い",
    nodes: Array.from({ length: 3 }, (_, i) => ({
      kind: "own",
      ref: `new:${String(i)}`,
      label: `n${String(i)}`,
      summary: "s",
    })),
  });
  const limited = (await (
    await send("GET", "/v1/learning-maps:concepts?limit=2", "token-a")
  ).json()) as ListClientMapConceptsResponse;
  expect(limited.concepts).toHaveLength(2);

  for (const limit of ["0", "1001", "abc", "1.5"]) {
    const response = await send("GET", `/v1/learning-maps:concepts?limit=${limit}`, "token-a");
    expect(response.status).toBe(400);
  }
  expect((await send("GET", "/v1/learning-maps:concepts?limit=1000", "token-a")).status).toBe(200);
});
