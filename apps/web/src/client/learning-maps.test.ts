import { expect, test } from "vitest";
import { ApiError } from "./api.js";
import { layoutTrees } from "./learning-map.js";
import {
  createLearningMap,
  deleteLearningMap,
  fetchOwnMapConcepts,
  isMapId,
  isOnExistingMap,
  MapInputError,
  MapLimitError,
  saveLearningMap,
  saveObjectives,
  mapDefinitions,
  mapIdOfConcept,
  MISSING_ORIGIN_LABEL,
  type LearningMapView,
} from "./learning-maps.js";

const MAP: LearningMapView = {
  id: "mrust0001",
  title: "Rust 入門",
  description: "",
  visibility: "private",
  latestVersion: null,
  shareKey: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  nodes: [
    {
      kind: "own",
      conceptId: "mrust0001.binding1",
      label: "変数の束縛",
      summary: "let で束縛する。",
      objectives: [],
    },
    {
      kind: "reference",
      conceptId: "go.defer",
      origin: {
        label: "defer",
        summary: "関数を抜けるときに実行する。",
        mapId: null,
        objectives: [{ id: "go.defer:timing", label: "実行タイミング", source: "manual" }],
      },
    },
    {
      kind: "own",
      conceptId: "mrust0001.owner001",
      label: "所有権",
      summary: "値の持ち主は1つ。",
      objectives: [{ id: "mrust0001.owner001:move", label: "move", source: "ai" }],
    },
    { kind: "reference", conceptId: "mgone0001.node0001", origin: null },
  ],
  edges: [
    { from: "mrust0001.binding1", to: "mrust0001.owner001" },
    { from: "go.defer", to: "mrust0001.owner001" },
  ],
};

test("手で作ったノードの ID からマップの ID を引き、固定の Concept では引かない", () => {
  expect(mapIdOfConcept("m7k2x9qa4.n3p8d2kw")).toBe("m7k2x9qa4");
  expect(mapIdOfConcept("go.defer")).toBeUndefined();
  // 形が少しでも違えば手で作ったノードとみなさない。
  expect(mapIdOfConcept("m7k2x9qa.n3p8d2kw")).toBeUndefined();
  expect(mapIdOfConcept("m7k2x9qa4.n3p8d2kw:move")).toBeUndefined();
});

test("マップを、参照のノードも含めて1つの木の定義へ変える", () => {
  const defined = mapDefinitions(MAP);

  expect(defined.concepts.map((concept) => [concept.id, concept.label, concept.language])).toEqual([
    ["mrust0001.binding1", "変数の束縛", "mrust0001"],
    ["go.defer", "defer", "mrust0001"],
    ["mrust0001.owner001", "所有権", "mrust0001"],
    ["mgone0001.node0001", MISSING_ORIGIN_LABEL, "mrust0001"],
  ]);
  // 前提は線から引く。参照のノードからの線も前提になる。
  expect(defined.concepts[2]?.prerequisites).toEqual(["mrust0001.binding1", "go.defer"]);
  expect(defined.concepts[1]?.summary).toBe("関数を抜けるときに実行する。");
  expect(defined.concepts[3]?.summary).toBeUndefined();
  // 項目は、そのマップで置いたノードの ID に付ける（参照は元の項目をそのまま使う）。
  expect(defined.objectives).toEqual([
    { id: "go.defer:timing", conceptId: "go.defer", label: "実行タイミング" },
    { id: "mrust0001.owner001:move", conceptId: "mrust0001.owner001", label: "move" },
  ]);
  expect([...defined.referenceIds]).toEqual(["go.defer", "mgone0001.node0001"]);

  // 既存の地図の配置にそのまま渡せる（1マップで1本の木）。
  const trees = layoutTrees(defined.concepts);
  expect(trees).toHaveLength(1);
  expect(trees[0]?.nodes.find((node) => node.conceptId === "mrust0001.owner001")?.depth).toBe(1);
});

test("ノードの無いマップは木を作らない", () => {
  expect(layoutTrees(mapDefinitions({ ...MAP, nodes: [], edges: [] }).concepts)).toEqual([]);
});

test("マップの数の上限は、汎用の失敗ではなく上限の失敗として返す", async () => {
  await expect(
    createLearningMap({ title: "t", description: "" }, async () =>
      Response.json({ error: "learning_map_limit_reached" }, { status: 409 }),
    ),
  ).rejects.toBeInstanceOf(MapLimitError);
  // 同意が無いときは Worker が止める。既存の書き込みと同じ種別にする。
  await expect(
    createLearningMap({ title: "t", description: "" }, async () =>
      Response.json({ error: "consent_required" }, { status: 403 }),
    ),
  ).rejects.toEqual(new ApiError("consent_required"));
  // 2xx でも本文が読めなければ失敗として扱う（RULE-004）。
  await expect(
    createLearningMap(
      { title: "t", description: "" },
      async () => new Response("oops", { status: 201 }),
    ),
  ).rejects.toEqual(new ApiError("unavailable"));
});

test("作成は題名と説明を POST し、作ったマップを返す", async () => {
  let sent: RequestInit | undefined;
  const result = await createLearningMap({ title: "t", description: "d" }, async (_input, init) => {
    sent = init;
    return Response.json({ map: MAP, assigned: {} }, { status: 201 });
  });
  expect(sent?.method).toBe("POST");
  expect(JSON.parse(String(sent?.body))).toEqual({ title: "t", description: "d" });
  expect(result.map.id).toBe("mrust0001");
});

test("削除の 204（本文なし）は成功として扱い、404 は対象なしとして返す", async () => {
  await expect(
    deleteLearningMap("mrust0001", async () => new Response(null, { status: 204 })),
  ).resolves.toBeUndefined();
  await expect(
    deleteLearningMap("mrust0001", async () =>
      Response.json({ error: "learning map not found" }, { status: 404 }),
    ),
  ).rejects.toEqual(new ApiError("not_found"));
});

test("今あるマップに載っている手作りのノードだけを「マップに載っている」とみなす", () => {
  // API は今あるノードにだけ表示名を付ける。
  expect(isOnExistingMap({ conceptId: "mrust0001.owner001", label: "所有権" })).toBe(true);
  // マップやノードを消した後の記録は表示名なしで残る。項目一覧から消さない。
  expect(isOnExistingMap({ conceptId: "mrust0001.owner001" })).toBe(false);
  expect(isOnExistingMap({ conceptId: "go.defer", label: "defer" })).toBe(false);
});

test("マップの ID の形だけを、確認問題からの戻り先として受け取る", () => {
  expect(isMapId("mrust0001")).toBe(true);
  expect(isMapId("mrust000")).toBe(false);
  expect(isMapId("go")).toBe(false);
  expect(isMapId("mrust0001/../x")).toBe(false);
});

test("保存の 400 は、API の定型文つきの入力の誤りとして返す", async () => {
  const error = await saveLearningMap("mrust0001", {}, async () =>
    Response.json({ error: "edges must not form a cycle" }, { status: 400 }),
  ).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(MapInputError);
  expect((error as MapInputError).message).toBe("edges must not form a cycle");
});

test("「理解すること」は、ノードの ID をパスに入れて置き換える", async () => {
  let url: string | undefined;
  let sent: RequestInit | undefined;
  await saveObjectives(
    "mrust0001",
    "mrust0001.owner001",
    [{ id: "mrust0001.owner001:move", label: "move" }, { label: "drop" }],
    async (input, init) => {
      url = String(input);
      sent = init;
      return Response.json({ objectives: [] });
    },
  );
  expect(url).toBe("/api/v1/learning-maps/mrust0001/nodes/mrust0001.owner001/objectives");
  expect(sent?.method).toBe("PUT");
  expect(JSON.parse(String(sent?.body))).toEqual({
    objectives: [{ id: "mrust0001.owner001:move", label: "move" }, { label: "drop" }],
  });
});

test("参照の候補は、件数を指定すると自分のノードを全部まで読む", async () => {
  const urls: string[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json({ concepts: [] });
  };
  await fetchOwnMapConcepts(fetcher);
  await fetchOwnMapConcepts(fetcher, false, 1000);
  expect(urls).toEqual([
    "/api/v1/learning-maps:concepts",
    "/api/v1/learning-maps:concepts?limit=1000",
  ]);
});
