import { expect, test } from "vitest";
import { ApiError } from "./api.js";
import {
  deleteAllConversations,
  deleteConversation,
  exportConversationsFileName,
  fetchConversation,
  fetchConversations,
  fetchConversationsExport,
  isConversation,
  listConversationsUrl,
  originLabel,
} from "./conversations.js";

const validSummary = {
  id: "conv-1",
  origin: "vscode",
  title: "配列の並び替えについて",
  language: "typescript",
  fileName: "sort.ts",
  occurredAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:01:00.000Z",
  messageCount: 3,
  complete: true,
};

const validConversation = {
  id: "conv-1",
  origin: "vscode",
  title: "配列の並び替えについて",
  language: "typescript",
  fileName: "sort.ts",
  occurredAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:01:00.000Z",
  complete: true,
  messages: [
    { role: "context", text: "const a = [3, 1, 2];", at: "2026-09-30T12:00:00.000Z" },
    { role: "user", text: "このコードを説明して", at: "2026-09-30T12:00:01.000Z" },
    { role: "assistant", text: "これは配列の宣言です", at: "2026-09-30T12:01:00.000Z" },
  ],
};

test("一覧の URL は cursor をそのままクエリへ載せる", () => {
  expect(listConversationsUrl()).toBe("/api/v1/conversations");
  expect(listConversationsUrl("1700000000000_conv-1")).toBe(
    "/api/v1/conversations?cursor=1700000000000_conv-1",
  );
  // cursor に含まれうる文字はエンコードする。API 側の区切り `_` は壊さない。
  expect(listConversationsUrl("1_a?b=c")).toBe("/api/v1/conversations?cursor=1_a%3Fb%3Dc");
});

test("一覧は契約どおりの応答を返す", async () => {
  await expect(
    fetchConversations(
      async () =>
        Response.json({ conversations: [validSummary], nextCursor: "1700000000000_conv-1" }),
      0,
    ),
  ).resolves.toEqual({ conversations: [validSummary], nextCursor: "1700000000000_conv-1" });
});

test.each([
  ["conversations が無い", { nextCursor: null }],
  [
    "summary の形が違う",
    { conversations: [{ ...validSummary, messageCount: "3" }], nextCursor: null },
  ],
  ["nextCursor が数値", { conversations: [], nextCursor: 1 }],
])("一覧で 2xx でも形が違えば失敗として扱う（%s）", async (_label, body) => {
  await expect(fetchConversations(async () => Response.json(body), 0)).rejects.toEqual(
    new ApiError("unavailable"),
  );
});

test("詳細は契約どおりの応答を返す", async () => {
  let requested: unknown;
  const result = await fetchConversation(
    async (input) => {
      requested = input;
      return Response.json(validConversation);
    },
    0,
    "conv-1",
  );
  expect(requested).toBe("/api/v1/conversations/conv-1");
  expect(result).toEqual(validConversation);
});

test("詳細の id は URL エンコードして送る", async () => {
  let requested: unknown;
  await fetchConversation(
    async (input) => {
      requested = input;
      return Response.json(validConversation);
    },
    0,
    "a/b?c",
  );
  expect(requested).toBe("/api/v1/conversations/a%2Fb%3Fc");
});

test("詳細が 404 なら not_found として返す", async () => {
  await expect(
    fetchConversation(
      async () => Response.json({ error: "conversation not found" }, { status: 404 }),
      0,
      "x",
    ),
  ).rejects.toEqual(new ApiError("not_found"));
});

test("会話の形を検証し、role が不正なメッセージを受け入れない", () => {
  expect(isConversation(validConversation)).toBe(true);
  expect(
    isConversation({
      ...validConversation,
      messages: [{ role: "system", text: "x", at: "2026-09-30T12:00:00.000Z" }],
    }),
  ).toBe(false);
  expect(isConversation({ ...validConversation, messages: "none" })).toBe(false);
});

test("エクスポートは契約どおりの応答を返す", async () => {
  const body = {
    version: 1,
    exportedAt: "2026-09-30T13:00:00.000Z",
    conversations: [validConversation],
  };
  await expect(fetchConversationsExport(async () => Response.json(body), 0)).resolves.toEqual(body);
});

test("エクスポートで 2xx でも形が違えば失敗として扱う", async () => {
  await expect(
    fetchConversationsExport(
      async () => Response.json({ version: 1, exportedAt: "x", conversations: [{ bad: true }] }),
      0,
    ),
  ).rejects.toEqual(new ApiError("unavailable"));
});

test("1件削除は DELETE で対象の会話を消し、件数を返す", async () => {
  let requested: unknown;
  let method: unknown;
  const count = await deleteConversation(async (input, init) => {
    requested = input;
    method = init?.method;
    return Response.json({ deletedCount: 1 });
  }, "conv-1");

  expect(requested).toBe("/api/v1/conversations/conv-1");
  expect(method).toBe("DELETE");
  expect(count).toBe(1);
});

test("全件削除は DELETE で履歴の API を呼ぶ", async () => {
  let requested: unknown;
  await deleteAllConversations(async (input) => {
    requested = input;
    return Response.json({ deletedCount: 7 });
  });
  expect(requested).toBe("/api/v1/conversations");
});

test("削除で 2xx でも応答の形が違えば失敗として扱う", async () => {
  await expect(
    deleteAllConversations(async () => Response.json({ deleted: true })),
  ).rejects.toEqual(new ApiError("unavailable"));
});

test("保存元の表示名は既知の値を日本語へ、知らない値はそのまま出す", () => {
  expect(originLabel("desktop")).toBe("デスクトップ");
  expect(originLabel("vscode")).toBe("VS Code");
  expect(originLabel("cli")).toBe("CLI");
  expect(originLabel("unknown-client")).toBe("unknown-client");
});

test("ダウンロードのファイル名は日付を含む", () => {
  expect(exportConversationsFileName(new Date("2026-10-03T12:34:56.000Z"))).toBe(
    "gakushu-sochi-conversations-2026-10-03.json",
  );
});
