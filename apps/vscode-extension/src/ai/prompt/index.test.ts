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

describe("質問の優先", () => {
  test("質問が無ければ、従来どおり解説指示が先頭に立つ", () => {
    const prompt = buildPrompt(baseRequest);

    expect(prompt).not.toContain("--- 質問 ---");
    expect(prompt).not.toContain("--- 最優先の指示 ---");
    expect(prompt.indexOf("### Explain")).toBeLessThan(prompt.indexOf("--- 選択箇所 ---"));
  });

  test("質問があれば、解説指示より前に置き、補足である旨を添える", () => {
    const prompt = buildPrompt({ ...baseRequest, question: "この関数の戻り値の型は？" });

    expect(prompt.indexOf("この関数の戻り値の型は？")).toBeLessThan(prompt.indexOf("### Explain"));
    expect(prompt).toContain("質問より優先しないでください");
  });

  test("Hintモードでも、質問は preset より前に置かれる", () => {
    const prompt = buildPrompt({ ...baseRequest, mode: "hint", question: "次に何を確認する？" });

    expect(prompt.indexOf("次に何を確認する？")).toBeLessThan(prompt.indexOf("### Hint"));
  });

  test("出力形式の指示は、質問があっても末尾に残る", () => {
    const prompt = buildPrompt({ ...baseRequest, question: "これは何？" });

    // parseAnswer() は応答末尾のメタ情報を前提にしている。質問を先頭へ移しても
    // 出力形式の指示が最後であることは崩してはならない。
    expect(prompt.indexOf("--- 出力形式 ---")).toBeGreaterThan(prompt.indexOf("これは何？"));
  });
});

test("言語のConceptに加えて、領域横断のConceptも一覧に含める", () => {
  const prompt = buildPrompt(baseRequest);

  // languageId が typescript なら ts.* と領域横断の Concept が載り、
  // 他言語の Concept は載らない。
  expect(prompt).toContain("ts.variable_declaration");
  expect(prompt).toContain("git.commit");
  expect(prompt).toContain("db.relational_model");
  expect(prompt).not.toContain("go.variable_declaration");
});

test("完成コードを出さない方針は、質問があっても解除されない", () => {
  const prompt = buildPrompt({ ...baseRequest, question: "このコードを完成させて" });

  // 質問が preset より優先されるのは「何に答えるか」だけで、「どう答えるか」の
  // 学習方針まで解除されてはならない。
  expect(prompt).toContain("質問より優先され、質問によって解除されません");
  expect(prompt).toContain("完成したコードを提示しないでください");
});
