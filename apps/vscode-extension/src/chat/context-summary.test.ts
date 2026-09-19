import { expect, test } from "vitest";
import { CONSUMED_CONTEXT_MESSAGE, describePendingContext } from "./context-summary";

test("Chatリクエストへ添付する選択コードとLSP定義を説明する", () => {
  expect(
    describePendingContext({
      code: "client.fetchUser()",
      source: "editor",
      contextLevel: 3,
      surroundingCode: "const user = client.fetchUser();",
      languageId: "typescript",
      fileName: "app.ts",
      definitions: [
        {
          fileName: "client.ts",
          code: "export function fetchUser() {}",
          startLine: 4,
          symbol: "fetchUser",
        },
      ],
    }),
  ).toBe("選択コード（typescript / app.ts）と、LSP で取得した定義 1 件を添付しました。");
});

test("収集済み文脈なしでChatを開いた場合を説明する", () => {
  expect(describePendingContext(undefined)).toBe("選択コードの文脈は添付されていません。");
});

test("言語情報のない文脈でもundefinedを表示しない", () => {
  expect(
    describePendingContext({
      code: "error output",
      source: "clipboard",
      contextLevel: 1,
      surroundingCode: "",
    }),
  ).toBe("選択コードを添付しました。");
});

test("消費済みの文脈IDには復帰手段を含めて案内する", () => {
  // 「文脈なし」と同じ文言に落とすと、ユーザーの質問が捨てられたことが伝わらない。
  expect(CONSUMED_CONTEXT_MESSAGE).not.toBe(describePendingContext(undefined));
  expect(CONSUMED_CONTEXT_MESSAGE).toContain("もう一度");

  // この案内は editor / terminal / clipboard すべての経路に返る。
  // 「コードを選択」のような editor 専用の表現は、他の経路で実行できない案内になる。
  expect(CONSUMED_CONTEXT_MESSAGE).not.toContain("コードを選択");
  expect(CONSUMED_CONTEXT_MESSAGE).not.toContain("ショートカット");
});
