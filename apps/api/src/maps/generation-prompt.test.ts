import { describe, expect, it } from "vitest";
import { CONCEPTS, MOCK_LEARNING_OBJECTIVES } from "@gakushu-sochi/domain";
import { AI_USAGE_LIMITS, estimateInputTokens } from "../contract/ai-usage.js";
import {
  MAX_GENERATION_GOAL_LENGTH,
  MAX_GENERATION_THEME_LENGTH,
  MAX_NODE_LABEL_LENGTH,
} from "../contract/learning-maps.js";
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
