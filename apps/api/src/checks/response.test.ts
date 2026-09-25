import { describe, expect, it } from "vitest";
import { CHECK_LIMITS } from "@gakushu-sochi/domain";
import { parseConceptCheck, readGeneratedText } from "./response.js";

const CONCEPT_ID = "go.pointer_receiver";

/** 受理できる最小限の1問。 */
function question(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "値レシーバのメソッドで状態を変えたとき、呼び出し元の値はどうなるか。",
    choices: ["変わらない", "変わる", "コンパイルできない", "実行時に落ちる"],
    answerIndex: 0,
    explanation: "値レシーバには複製が渡るため、呼び出し元の値は変わらない。",
    ...overrides,
  };
}

function generated(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    conceptId: CONCEPT_ID,
    overview: question(),
    practice: question({ code: "func (c Counter) Add() { c.n++ }" }),
    ...overrides,
  });
}

/** Gemini の `generateContent` の応答（非ストリーミング）を模した封筒。 */
function envelope(
  text: string,
  overrides: { finishReason?: string; totalTokenCount?: unknown; modelVersion?: string } = {},
) {
  return JSON.stringify({
    candidates: [
      {
        content: { parts: [{ text }], role: "model" },
        finishReason: overrides.finishReason ?? "STOP",
      },
    ],
    usageMetadata: { totalTokenCount: overrides.totalTokenCount ?? 1234 },
    modelVersion: overrides.modelVersion ?? "gemini-3.6-flash",
  });
}

describe("readGeneratedText", () => {
  it("本文とモデル名と消費トークンを取り出す", () => {
    expect(readGeneratedText(envelope("{}"))).toEqual({
      ok: true,
      text: "{}",
      modelVersion: "gemini-3.6-flash",
      totalTokens: 1234,
    });
  });

  it("分割された parts を連結する", () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"a":' }, { text: "1}" }] } }],
    });
    const result = readGeneratedText(body);
    expect(result.ok && result.text).toBe('{"a":1}');
  });

  it("消費トークンが取れなければ 0 で埋めず undefined にする", () => {
    // 0 を記録すると、生成のコストが「消費していない」として残る（RULE-004）。
    const result = readGeneratedText(envelope("{}", { totalTokenCount: "many" }));
    expect(result.ok && result.totalTokens).toBeUndefined();
  });

  it("出力上限で切れた応答は拒否する", () => {
    // 途中まで読める JSON を受理すると、切り詰められた問題文が出題される。
    expect(readGeneratedText(envelope('{"conceptId"', { finishReason: "MAX_TOKENS" }))).toEqual({
      ok: false,
      reason: "truncated",
      detail: "出力上限に達した",
    });
  });

  it("安全性フィルタで拒否された応答は理由を残す", () => {
    const body = JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } });
    expect(readGeneratedText(body)).toEqual({ ok: false, reason: "blocked", detail: "SAFETY" });
  });

  it("候補が無い応答は受理しない", () => {
    const result = readGeneratedText(JSON.stringify({ candidates: [] }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("no-text");
  });

  it("本文が空の応答は受理しない", () => {
    const result = readGeneratedText(envelope("   "));
    expect(!result.ok && result.reason).toBe("no-text");
  });

  it("JSON として読めない応答は受理しない", () => {
    const result = readGeneratedText("<html>503</html>");
    expect(!result.ok && result.reason).toBe("not-json");
  });
});

describe("parseConceptCheck", () => {
  it("2問揃った応答を受理する", () => {
    const result = parseConceptCheck(generated(), CONCEPT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.check.conceptId).toBe(CONCEPT_ID);
    expect(result.check.overview.choices).toHaveLength(CHECK_LIMITS.choiceCount);
    expect(result.check.overview.answerIndex).toBe(0);
    expect(result.check.practice.code).toBe("func (c Counter) Add() { c.n++ }");
  });

  it("実践問題が無い応答は受理しない", () => {
    // 2問揃わない組を「取れた分だけ」使わない（#43 の 2問1組）。
    const body = JSON.stringify({ conceptId: CONCEPT_ID, overview: question() });
    const result = parseConceptCheck(body, CONCEPT_ID);
    expect(!result.ok && result.reason).toBe("shape");
  });

  it("例示コードの無い実践問題は受理しない", () => {
    const result = parseConceptCheck(generated({ practice: question() }), CONCEPT_ID);
    expect(!result.ok && result.reason).toBe("shape");
  });

  it("選択肢の数が違う応答は受理しない", () => {
    const body = generated({ overview: question({ choices: ["A", "B", "C"] }) });
    const result = parseConceptCheck(body, CONCEPT_ID);
    expect(!result.ok && result.reason).toBe("shape");
  });

  it("正解が選択肢の範囲外の応答は受理しない", () => {
    const body = generated({ overview: question({ answerIndex: 4 }) });
    const result = parseConceptCheck(body, CONCEPT_ID);
    expect(!result.ok && result.reason).toBe("answer-out-of-range");
  });

  it("正解の添字が負の応答は受理しない", () => {
    const body = generated({ overview: question({ answerIndex: -1 }) });
    const result = parseConceptCheck(body, CONCEPT_ID);
    expect(!result.ok && result.reason).toBe("shape");
  });

  it("同じ選択肢が複数ある応答は受理しない", () => {
    // 正解が1つに定まらない。
    const body = generated({
      practice: question({ code: "x := 1", choices: ["同じ", "同じ ", "B", "C"] }),
    });
    const result = parseConceptCheck(body, CONCEPT_ID);
    expect(!result.ok && result.reason).toBe("duplicate-choices");
  });

  it("上限を超える設問文は受理しない", () => {
    const body = generated({
      overview: question({ prompt: "あ".repeat(CHECK_LIMITS.promptMaxLength + 1) }),
    });
    const result = parseConceptCheck(body, CONCEPT_ID);
    expect(!result.ok && result.reason).toBe("shape");
  });

  it("別の Concept の問題は受理しない", () => {
    const body = generated({ conceptId: "go.slice_append" });
    const result = parseConceptCheck(body, CONCEPT_ID);
    expect(!result.ok && result.reason).toBe("concept-mismatch");
    expect(!result.ok && result.detail).toContain("go.slice_append");
  });

  it("コードブロックで囲まれた応答は剥がさずに拒否する", () => {
    // 上流へ JSON を要求している。囲みが来たなら形式の逸脱であり、
    // 黙って剥がすと契約から外れた応答が通り続ける。
    const result = parseConceptCheck("```json\n" + generated() + "\n```", CONCEPT_ID);
    expect(!result.ok && result.reason).toBe("not-json");
  });

  it("失敗の詳細は理由と一緒に返す", () => {
    const result = parseConceptCheck(generated({ overview: question({ prompt: "" }) }), CONCEPT_ID);
    expect(!result.ok && result.detail).toContain("overview.prompt");
  });
});
