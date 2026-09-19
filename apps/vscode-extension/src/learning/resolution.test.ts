import { expect, test } from "vitest";
import { shouldRecordSolvedIndependently } from "./resolution";

test("初回応答がresolvedを返しても自力解決イベントを記録しない", () => {
  expect(
    shouldRecordSolvedIndependently([], {
      resolution: "resolved",
      conceptIds: ["go.error_handling"],
    }),
  ).toBe(false);
});

test("会話履歴がありresolvedかつConceptがあれば自力解決イベントを記録する", () => {
  expect(
    shouldRecordSolvedIndependently(
      [{ role: "assistant", text: "エラー処理を確認してください。" }],
      { resolution: "resolved", conceptIds: ["go.error_handling"] },
    ),
  ).toBe(true);
});
