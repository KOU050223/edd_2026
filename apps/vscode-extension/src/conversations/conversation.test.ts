import { expect, test } from "vitest";

import type { CodeContext } from "@gakushu-sochi/domain";

import { buildVscodeConversation } from "./conversation";

const context: CodeContext = {
  code: "const x = 1;",
  source: "editor",
  contextLevel: 2,
  surroundingCode: "const y = 2;",
  languageId: "typescript",
  fileName: "index.ts",
  startLine: 0,
  endLine: 0,
};

const base = {
  id: "session-1",
  context,
  question: "このコードは何をしていますか？",
  answer: "x に 1 を代入しています。",
  occurredAt: "2026-01-01T00:00:00.000Z",
  answeredAt: "2026-01-01T00:00:05.000Z",
  clientId: "client-1",
};

test("context・user・assistant の3件をメタ情報付きで組み立てる", () => {
  expect(buildVscodeConversation(base)).toEqual({
    id: "session-1",
    origin: "vscode",
    clientId: "client-1",
    title: "このコードは何をしていますか？",
    language: "typescript",
    fileName: "index.ts",
    occurredAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    complete: true,
    messages: [
      { role: "context", text: "const x = 1;", at: "2026-01-01T00:00:00.000Z" },
      {
        role: "user",
        text: "このコードは何をしていますか？",
        at: "2026-01-01T00:00:00.000Z",
      },
      { role: "assistant", text: "x に 1 を代入しています。", at: "2026-01-01T00:00:05.000Z" },
    ],
  });
});

test("周辺コード・定義・diagnostics は履歴へ含めない", () => {
  // 設計上、保存する文脈は選択テキスト（CodeContext.code）だけ。
  // AI が実際に見た周辺コードまで保存すると、保存量とセンシティブ度が
  // 跳ね上がるため（docs/conversation-history.md）。
  const rich: CodeContext = {
    ...context,
    surroundingCode: "SECRET_SURROUNDING",
    definitions: [{ fileName: "dep.ts", code: "SECRET_DEFINITION", startLine: 0 }],
  };
  const conversation = buildVscodeConversation({ ...base, context: rich });
  const serialized = JSON.stringify(conversation);

  expect(serialized).not.toContain("SECRET_SURROUNDING");
  expect(serialized).not.toContain("SECRET_DEFINITION");
});

test("code とメタ情報が取れない経路では context メッセージを省略する", () => {
  const lv1: CodeContext = {
    code: "",
    source: "clipboard",
    contextLevel: 1,
    surroundingCode: "",
  };
  const conversation = buildVscodeConversation({ ...base, context: lv1 });

  // code が空の経路では context メッセージを作らない（契約は本文1文字以上）。
  expect(conversation.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(conversation.language).toBeUndefined();
  expect(conversation.fileName).toBeUndefined();
});

test("質問が空白だけの場合は選択テキストからタイトルを取る", () => {
  const conversation = buildVscodeConversation({ ...base, question: "   " });

  // messages には入力のまま残し、タイトルだけ代替から取る。
  expect(conversation.title).toBe("const x = 1;");
});
