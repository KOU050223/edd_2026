import { expect, test } from "vitest";
import { InMemoryLearningMapRepository } from "../repository/memory.js";
import { loadHistoryTarget } from "./history-target.js";
import { buildHistoryAnalysisPrompt } from "./history-prompt.js";
import { estimateInputTokens } from "../contract/ai-usage.js";

async function create(
  maps: InMemoryLearningMapRepository,
  id: string,
  summary: string,
  objective: string,
) {
  await maps.create("user-a", {
    id,
    nowIso: "2026-10-10T00:00:00.000Z",
    nowMs: 0,
    maxMaps: 20,
    content: {
      title: id,
      description: "",
      nodes: [
        { kind: "own", conceptId: "m11111111.n1111111", label: "エラー処理", summary },
        { kind: "reference", conceptId: "go.defer" },
      ],
      edges: [],
    },
    objectives: [
      { id: `${id}:o1`, conceptId: "m11111111.n1111111", label: objective, source: "manual" },
    ],
  });
}

test("自分のマップの現行定義だけを取得し、他人には公開しない", async () => {
  const maps = new InMemoryLearningMapRepository();
  await create(maps, "m11111111", "エラーを戻り値で返す", "失敗時に伝える");

  const target = await loadHistoryTarget(maps, "user-a", "m11111111");

  expect(target!.concepts.map((concept) => concept.id)).toEqual(["m11111111.n1111111", "go.defer"]);
  expect(target!.concepts[0]!.summary).toBe("エラーを戻り値で返す");
  expect(await loadHistoryTarget(maps, "user-b", "m11111111")).toBeNull();
});

test("同じ ID の同じ内容は共有し、異なる理解項目は保留して他の Concept を進める", async () => {
  const maps = new InMemoryLearningMapRepository();
  await create(maps, "m11111111", "エラーを戻り値で返す", "失敗時に伝える");
  await create(maps, "m22222222", "エラーを戻り値で返す", "失敗時に伝える");
  const same = await loadHistoryTarget(maps, "user-a", "m22222222");
  expect(same!.warnings).toEqual([]);
  expect(same!.concepts).toHaveLength(2);
  await create(maps, "m33333333", "エラーを戻り値で返す", "例外を投げる");

  const conflict = await loadHistoryTarget(maps, "user-a", "m11111111");

  expect(conflict!.concepts.map((concept) => concept.id)).toEqual(["go.defer"]);
  expect(conflict!.warnings[0]).toContain("異なる学習内容");
});

test("説明が変わった Concept だけ指紋が変わる", async () => {
  const maps = new InMemoryLearningMapRepository();
  await create(maps, "m11111111", "元の説明", "項目");
  const before = await loadHistoryTarget(maps, "user-a", "m11111111");
  await create(maps, "m11111111", "変更後の説明", "項目");
  const after = await loadHistoryTarget(maps, "user-a", "m11111111");

  expect(after!.concepts[0]!.fingerprint).not.toBe(before!.concepts[0]!.fingerprint);
  expect(after!.concepts[1]!.fingerprint).toBe(before!.concepts[1]!.fingerprint);
});

test("補足の理解項目は同名候補だけに渡し、通常は名前・分野・説明で解析する", () => {
  const definition = {
    id: "go.defer",
    label: "defer",
    summary: "遅延実行",
    area: "go",
    fingerprint: "hash",
    objectives: ["通常は送らない項目"],
  };
  const prompt = buildHistoryAnalysisPrompt([], [definition.id], [definition]);
  const ambiguous = buildHistoryAnalysisPrompt(
    [],
    [definition.id, "other.defer"],
    [definition, { ...definition, id: "other.defer", objectives: ["区別する項目"] }],
  );

  expect(prompt).toContain("遅延実行");
  expect(prompt).not.toContain("通常は送らない項目");
  expect(ambiguous).toContain("区別する項目");
  expect(estimateInputTokens(buildHistoryAnalysisPrompt([], [], []))).toBeLessThan(6_000);
});
