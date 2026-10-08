import { describe, expect, it } from "vitest";
import { CONCEPTS, MOCK_LEARNING_OBJECTIVES } from "@gakushu-sochi/domain";
import { AI_USAGE_LIMITS, estimateInputTokens } from "../contract/ai-usage.js";
import {
  MAX_GENERATION_GOAL_LENGTH,
  MAX_GENERATION_THEME_LENGTH,
  MAX_MAP_TITLE_LENGTH,
  MAX_NODE_LABEL_LENGTH,
  MAX_NODE_SUMMARY_LENGTH,
  MAX_OBJECTIVE_LABEL_LENGTH,
} from "../contract/learning-maps.js";
import { CREATION_CHECKS_MAX_OUTPUT_TOKENS, planCreationCheckBatches } from "./creation-checks.js";
import { MAP_GENERATION_TOKEN_BUDGET } from "./generate.js";
import {
  buildObjectivesPrompt,
  buildSkeletonPrompt,
  GENERATED_SUMMARY_TARGET_LENGTH,
  type MapGenerationRequest,
} from "./generation-prompt.js";

/** 入力の上限いっぱいのテーマと目標。見積もりは UTF-8 のバイト数なので全角で埋める。 */
const LONGEST_REQUEST: MapGenerationRequest = {
  kind: "goal",
  theme: "あ".repeat(MAX_GENERATION_THEME_LENGTH),
  goal: "い".repeat(MAX_GENERATION_GOAL_LENGTH),
  level: "basic",
};

describe("buildSkeletonPrompt", () => {
  it("固定の Concept の候補（項目を持つものすべて）を載せても、入力の上限に収まる", () => {
    const withObjectives = new Set(MOCK_LEARNING_OBJECTIVES.map((item) => item.conceptId));
    const candidates = CONCEPTS.filter((concept) => withObjectives.has(concept.id)).map(
      (concept) => ({ id: concept.id, label: concept.label, status: "learning" as const }),
    );
    expect(candidates.length).toBeGreaterThan(0);

    const prompt = buildSkeletonPrompt({ request: LONGEST_REQUEST, candidates, knownLabels: [] });

    // 候補は手で作ったノードを足すと落とすことがあるが、固定の分だけは全部載る大きさに保つ。
    expect(estimateInputTokens(prompt)).toBeLessThanOrEqual(AI_USAGE_LIMITS.inputTokensPerRequest);
  });

  it("利用者の入力を資料として区切り、候補を ID|表示名|理解度 で並べる", () => {
    const prompt = buildSkeletonPrompt({
      request: { kind: "field", theme: "Kotlin", level: "intro" },
      candidates: [{ id: "go.defer", label: "defer", status: "confirmed" }],
      knownLabels: [{ label: "所有権", status: "learning" }],
    });

    expect(prompt).toContain("<<<テーマ\nKotlin\nテーマ>>>");
    expect(prompt).not.toContain("<<<目標");
    expect(prompt).toContain("go.defer|defer|理解済み");
    expect(prompt).toContain("所有権|学習中");
  });

  it("一本道にせず、独立して学べる概念は同じ前提から枝分かれさせるよう頼む", () => {
    const prompt = buildSkeletonPrompt({
      request: { kind: "field", theme: "Unity", level: "basic" },
      candidates: [],
      knownLabels: [],
    });

    expect(prompt).toContain("同じ前提から枝分かれさせ、一本道にしない");
    // 出力の例も、1つの前提から2つに分かれる形にする（例が一本道だと、AI もそれに倣う）。
    const example = JSON.parse(prompt.split("\n").find((line) => line.startsWith('{"title"'))!) as {
      nodes: { prerequisite?: string }[];
    };
    const children = example.nodes.filter((node) => node.prerequisite === "n1");
    expect(children.length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildObjectivesPrompt", () => {
  it("目安の長さの概要なら、10 ノードを1回の入力に収められる", () => {
    const nodes = Array.from({ length: 10 }, (_, index) => ({
      key: `n${String(index + 1)}`,
      label: "表".repeat(MAX_NODE_LABEL_LENGTH),
      summary: "概".repeat(GENERATED_SUMMARY_TARGET_LENGTH),
    }));

    const prompt = buildObjectivesPrompt({ ...LONGEST_REQUEST, goal: "目標" }, "題名", nodes);

    expect(estimateInputTokens(prompt)).toBeLessThanOrEqual(AI_USAGE_LIMITS.inputTokensPerRequest);
  });
});

describe("planCreationCheckBatches（#247）", () => {
  /** 文字数の上限いっぱいのノード。手で長く直したマップを想定する。 */
  const longest = (id: string) => ({
    input: {
      id,
      label: "表".repeat(MAX_NODE_LABEL_LENGTH),
      language: "あ".repeat(MAX_MAP_TITLE_LENGTH),
      summary: "概".repeat(MAX_NODE_SUMMARY_LENGTH),
      prerequisiteLabels: ["前".repeat(MAX_NODE_LABEL_LENGTH)],
      nextLabels: Array.from({ length: 5 }, () => "次".repeat(MAX_NODE_LABEL_LENGTH)),
    },
    objective: { id: `${id}:k1`, label: "項".repeat(MAX_OBJECTIVE_LABEL_LENGTH) },
  });
  /** AI が作る目安の長さのノード。 */
  const typical = (id: string) => ({
    input: {
      id,
      label: "HTTP ハンドラ",
      language: "Go で Web API",
      summary: "概".repeat(GENERATED_SUMMARY_TARGET_LENGTH),
      prerequisiteLabels: ["HTTP の基本"],
      nextLabels: ["ミドルウェア"],
    },
    objective: { id: `${id}:k1`, label: "ハンドラの登録と呼ばれ方" },
  });
  const ids = (count: number) =>
    Array.from({ length: count }, (_, index) => `mabcdefgh.k${String(index)}`);

  it("目安の長さなら、10 組を2組ずつ5回で頼む", () => {
    const { batches, skipped } = planCreationCheckBatches(ids(10).map(typical), "basic");

    expect(skipped).toBe(0);
    expect(batches.map((batch) => batch.targets.length)).toEqual([2, 2, 2, 2, 2]);
    for (const batch of batches) {
      expect(estimateInputTokens(batch.prompt)).toBeLessThanOrEqual(
        AI_USAGE_LIMITS.inputTokensPerRequest,
      );
    }
  });

  it("2組が入力に収まらなければ1組ずつにし、5 回分を超える分は後ろから落とす", () => {
    const { batches, skipped } = planCreationCheckBatches(ids(10).map(longest), "advanced");

    expect(batches.every((batch) => batch.targets.length === 1)).toBe(true);
    const total = batches.reduce(
      (sum, batch) => sum + estimateInputTokens(batch.prompt) + CREATION_CHECKS_MAX_OUTPUT_TOKENS,
      0,
    );
    expect(total).toBeLessThanOrEqual(MAP_GENERATION_TOKEN_BUDGET);
    // 手前のノードから残る。
    expect(batches.map((batch) => batch.targets[0]!.input.id)).toEqual(
      ids(10).slice(0, batches.length),
    );
    expect(skipped).toBe(10 - batches.length);
  });

  it("1組でも入力に収まらない項目は飛ばし、他の項目は頼む", () => {
    const tooLong = longest("mabcdefgh.big");
    // 子が多いノード: 次に接続する概念の表示名だけで入力の上限を超える。
    tooLong.input.nextLabels = Array.from({ length: 49 }, () => "次".repeat(MAX_NODE_LABEL_LENGTH));

    const { batches, skipped } = planCreationCheckBatches(
      [tooLong, typical("mabcdefgh.k1"), typical("mabcdefgh.k2")],
      "basic",
    );

    expect(skipped).toBe(1);
    expect(batches.flatMap((batch) => batch.targets.map((target) => target.input.id))).toEqual([
      "mabcdefgh.k1",
      "mabcdefgh.k2",
    ]);
  });
});
