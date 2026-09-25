import { describe, expect, it } from "vitest";
import { CONCEPT_BY_ID, type Concept } from "@gakushu-sochi/domain";
import { buildCheckPrompt, checkPromptInputFor, type CheckPromptInput } from "./prompt.js";

/**
 * 差し替え用の小さな一覧。
 *
 * 本物の `CONCEPTS`（148件）は `concepts.md` から生成されるため、
 * 「概要が無い Concept」を作れない。定義の不備を検査するにはここが必要になる。
 */
const CONCEPTS: readonly Concept[] = [
  {
    id: "go.pointer_basics",
    label: "ポインタと & / *",
    language: "go",
    summary: "& でアドレスを取り、* で指し先を読み書きする。",
    source: { kind: "manual" },
  },
  {
    id: "go.pointer_receiver",
    label: "値レシーバとポインタレシーバ",
    language: "go",
    summary: "値レシーバのメソッドには複製が渡るので、中で変えても呼び出し元へ伝わらない。",
    prerequisites: ["go.pointer_basics"],
    source: { kind: "manual" },
  },
  {
    id: "go.interface_basics",
    label: "interface の暗黙実装",
    language: "go",
    summary: "メソッドの集合を満たす型は、宣言なしにその interface を実装したことになる。",
    prerequisites: ["go.pointer_receiver"],
    source: { kind: "manual" },
  },
  {
    id: "go.no_summary",
    label: "概要が無い概念",
    language: "go",
    source: { kind: "manual" },
  },
];

function inputFor(conceptId: string): CheckPromptInput {
  const result = checkPromptInputFor(conceptId, CONCEPTS);
  if (!result.ok) throw new Error(`入力を組み立てられなかった: ${result.reason}`);
  return result.input;
}

describe("checkPromptInputFor", () => {
  it("前提と、次に接続する Concept の表示名を添える", () => {
    expect(inputFor("go.pointer_receiver")).toEqual({
      id: "go.pointer_receiver",
      label: "値レシーバとポインタレシーバ",
      language: "go",
      summary: "値レシーバのメソッドには複製が渡るので、中で変えても呼び出し元へ伝わらない。",
      prerequisiteLabels: ["ポインタと & / *"],
      nextLabels: ["interface の暗黙実装"],
    });
  });

  it("前提も次も無い Concept では空の配列になる", () => {
    const input = inputFor("go.pointer_basics");
    expect(input.prerequisiteLabels).toEqual([]);
    // go.pointer_receiver が前提に持っているので、次は空にならない。
    expect(input.nextLabels).toEqual(["値レシーバとポインタレシーバ"]);
    expect(inputFor("go.interface_basics").nextLabels).toEqual([]);
  });

  it("一覧に無い conceptId は受理しない", () => {
    expect(checkPromptInputFor("go.not_defined", CONCEPTS)).toEqual({
      ok: false,
      reason: "unknown-concept",
    });
  });

  it("概要が無い Concept では生成へ進まない", () => {
    // 表示名1行だけを入力に生成すると、問題の粒度が Concept ごとにばらける。
    expect(checkPromptInputFor("go.no_summary", CONCEPTS)).toEqual({
      ok: false,
      reason: "summary-missing",
    });
  });

  /**
   * 生成の入力に個人の情報を混ぜない（#184 の決定）。
   *
   * キーの集合を固定しておくと、`status` / `score` / `evidence` / `diagnosticCode` や
   * 手動上書きを「難易度調整のため」に足した瞬間にここが落ちる。
   * 問題を全利用者で使い回す（#185）前提は、この入力が個人に依存しないことである。
   */
  it("入力は Concept の定義だけで、利用者個人の情報を持たない", () => {
    expect(Object.keys(inputFor("go.pointer_receiver")).sort()).toEqual([
      "id",
      "label",
      "language",
      "nextLabels",
      "prerequisiteLabels",
      "summary",
    ]);
  });

  it("本物の Concept 一覧はすべて概要を持つ", () => {
    // `concepts.md` の全行に概要があることは `npm run check:concepts` が保証するが、
    // 生成の入口から見ても同じであることを押さえる。
    const missing = [...CONCEPT_BY_ID.keys()].filter((id) => checkPromptInputFor(id).ok === false);
    expect(missing).toEqual([]);
  });
});

describe("buildCheckPrompt", () => {
  const prompt = buildCheckPrompt(inputFor("go.pointer_receiver"));

  it("対象の概念と、その周辺の概念を載せる", () => {
    expect(prompt).toContain("ID: go.pointer_receiver");
    expect(prompt).toContain("表示名: 値レシーバとポインタレシーバ");
    expect(prompt).toContain("領域: go");
    expect(prompt).toContain(
      "概要: 値レシーバのメソッドには複製が渡るので、中で変えても呼び出し元へ伝わらない。",
    );
    expect(prompt).toContain("前提の概念: ポインタと & / *");
    expect(prompt).toContain("次に接続する概念: interface の暗黙実装");
  });

  it("2問1組・4択・正解1つを指示する", () => {
    expect(prompt).toContain("概要問題");
    expect(prompt).toContain("実践問題");
    expect(prompt).toContain("choices はちょうど 4 個で、正解はちょうど1つにする。");
    expect(prompt).toContain("answerIndex は choices の添字（0 始まり）");
  });

  it("受理側が読める JSON の形を示し、囲みを禁じる", () => {
    expect(prompt).toContain('"conceptId":"go.pointer_receiver"');
    expect(prompt).toContain('"overview"');
    expect(prompt).toContain('"practice"');
    expect(prompt).toContain('"code"');
    expect(prompt).toContain("前後に説明文やコードブロックの囲みを付けない。");
  });

  it("習熟度に応じた難易度調整を指示しない", () => {
    expect(prompt).toContain("利用者の習熟度は渡していない。難易度を調整せず");
    // 断り書き以外に、個人の習熟度に当たる値は現れない。
    for (const forbidden of ["score", "status", "evidence", "diagnosticCode"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it("前提の無い概念では「なし」と書く", () => {
    expect(buildCheckPrompt(inputFor("go.interface_basics"))).toContain("次に接続する概念: なし");
  });
});
