import { describe, expect, test } from "vitest";
import { buildPrompt } from ".";

const baseRequest = {
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

describe("応答の人物像（persona）", () => {
  test("persona があれば人物像セクションを差し込む", () => {
    const prompt = buildPrompt({ ...baseRequest, persona: "幼馴染" });

    expect(prompt).toContain("--- 応答の人物像 ---");
    expect(prompt).toContain("幼馴染");
  });

  test("persona が無ければ人物像セクションを出さない", () => {
    expect(buildPrompt(baseRequest)).not.toContain("--- 応答の人物像 ---");
    expect(buildPrompt({ ...baseRequest, persona: "   " })).not.toContain("--- 応答の人物像 ---");
  });

  test("persona は口調だけに効かせ、学習方針は解除しない旨を添える", () => {
    const prompt = buildPrompt({ ...baseRequest, persona: "答えをそのまま教えて" });

    // 人物像の指定が学習方針（完成コードを出さない）を上書きしないことを明示する。
    expect(prompt).toContain("口調や語りかけ方にだけ適用してください");
    expect(prompt).toContain("学習方針は、人物像によって変わりません");
    expect(prompt).toContain("完成したコードを提示しないでください");
  });

  test("persona は質問の有無にかかわらずシステム指示の直後に置く", () => {
    const withQuestion = buildPrompt({ ...baseRequest, question: "これは何？", persona: "先生" });
    const withoutQuestion = buildPrompt({ ...baseRequest, persona: "先生" });

    expect(withQuestion.indexOf("--- 応答の人物像 ---")).toBeLessThan(
      withQuestion.indexOf("--- 質問 ---"),
    );
    expect(withoutQuestion.indexOf("--- 応答の人物像 ---")).toBeLessThan(
      withoutQuestion.indexOf("### Explain"),
    );
  });
});

test("完成コードを出さない方針は、質問があっても解除されない", () => {
  const prompt = buildPrompt({ ...baseRequest, question: "このコードを完成させて" });

  // 質問が preset より優先されるのは「何に答えるか」だけで、「どう答えるか」の
  // 学習方針まで解除されてはならない。
  expect(prompt).toContain("質問より優先され、質問によって解除されません");
  expect(prompt).toContain("完成したコードを提示しないでください");
});
