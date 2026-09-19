import { describe, expect, test } from "vitest";
import { buildPrompt } from ".";

const baseRequest = {
  mode: "explain" as const,
  context: {
    code: "const total = items.reduce((sum, item) => sum + item.price, 0);",
    source: "editor" as const,
    contextLevel: 3 as const,
    surroundingCode: "const items = cart.items;",
    languageId: "typescript",
    fileName: "cart.ts",
    startLine: 12,
    endLine: 12,
    definitions: [{ fileName: "item.ts", code: "interface Item { price: number }", startLine: 0 }],
  },
};

describe("buildPrompt", () => {
  test("Explainは完成コードを提示せず、理解のための説明を指示する", () => {
    const prompt = buildPrompt(baseRequest);

    expect(prompt).toContain("完成したコードを提示しない");
    expect(prompt).toContain("なぜそうなるのか");
    expect(prompt).toContain("--- 選択箇所 ---");
    expect(prompt).toContain("--- 参照した定義 ---");
  });

  test("Hintは段階を保持せず、会話履歴を踏まえた次の一手だけを示す", () => {
    const prompt = buildPrompt({
      ...baseRequest,
      mode: "hint",
      history: [{ role: "assistant", text: "変数の型を確認してください。" }],
    });

    expect(prompt).toContain("会話履歴");
    expect(prompt).toContain("次に試す一手だけ");
    expect(prompt).not.toContain("Hint 1");
    expect(prompt).not.toContain("Hint 2");
    expect(prompt).not.toContain("### Answer");
  });

  test("DiagnosticsがあればError Explainを選び、原因・確認箇所・次の一手を求める", () => {
    const prompt = buildPrompt({
      ...baseRequest,
      diagnostics: ["Type 'string' is not assignable to type 'number'."],
    });

    expect(prompt).toContain("エラーを解説する");
    expect(prompt).toContain("なぜエラーになるか");
    expect(prompt).toContain("どこを確認すべきか");
    expect(prompt).toContain("次に試すこと");
  });

  test("Lv1とコードではない入力では、前提不足を明示して断定を避ける", () => {
    const prompt = buildPrompt({
      mode: "explain",
      question: "goroutine",
      context: {
        code: "goroutine",
        source: "clipboard",
        contextLevel: 1,
        surroundingCode: "",
      },
    });

    expect(prompt).toContain("コードとは限らない");
    expect(prompt).toContain("前後の文脈や位置情報がありません");
    expect(prompt).toContain("断定せず");
  });
});
