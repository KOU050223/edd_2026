import { expect, test } from "vitest";
import {
  CONVERSATION_HISTORY_OPT_IN_NOTICE,
  CONVERSATION_TITLE_MAX_LENGTH,
  deriveConversationTitle,
} from "./conversation.js";

test("質問の先頭の空でない行をタイトルにする", () => {
  expect(deriveConversationTitle("\n  この関数は何をする？  \n詳細")).toBe("この関数は何をする？");
});

test("空の質問はタイトルを作らない", () => {
  expect(deriveConversationTitle("")).toBeUndefined();
  expect(deriveConversationTitle("  \n\n")).toBeUndefined();
});

test("上限を超える行は省略記号を付けて切る", () => {
  const long = "あ".repeat(CONVERSATION_TITLE_MAX_LENGTH + 10);
  const title = deriveConversationTitle(long);
  expect(title).toHaveLength(CONVERSATION_TITLE_MAX_LENGTH);
  expect(title?.endsWith("…")).toBe(true);
});

test("ちょうど上限の行はそのまま残す", () => {
  const exact = "あ".repeat(CONVERSATION_TITLE_MAX_LENGTH);
  expect(deriveConversationTitle(exact)).toBe(exact);
});

test("オプトイン文面に目的・保存期間・削除方法が書かれている", () => {
  // docs/data-privacy.md の要件。抜けたまま切り替え UI に出すと
  // 何のために何が残るかを利用者が判断できない。
  expect(CONVERSATION_HISTORY_OPT_IN_NOTICE).toContain("見返せる");
  expect(CONVERSATION_HISTORY_OPT_IN_NOTICE).toContain("削除するまで残り");
  expect(CONVERSATION_HISTORY_OPT_IN_NOTICE).toContain("削除");
});
