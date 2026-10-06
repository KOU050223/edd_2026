import { describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "./api-request.js";
import {
  deleteConversation,
  getConversation,
  getUserSettings,
  listConversations,
  putConversation,
  setSaveConversationHistory,
} from "./conversations-api.js";
import { buildConversation } from "./conversation.js";

const deps = (fetch: typeof fetch) => ({
  baseUrl: "https://api.example.com/v1",
  getAccessToken: () => Promise.resolve("token"),
  fetch,
});

const remoteSettings = {
  version: 1,
  displayName: "学習者",
  activityPeriodDays: 30,
  saveConversationHistory: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("setSaveConversationHistory", () => {
  it("sends only the toggled flag so other fields are not overwritten", async () => {
    // GET → PUT の全文送り返しだと、読み取りと書き込みの間に別端末が
    // 変更した項目を古い値で上書きする。省略項目はサーバーが現状維持する。
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ...remoteSettings, saveConversationHistory: true }), {
          status: 200,
        }),
    );

    const saved = await setSaveConversationHistory(deps(fetchMock), true);

    expect(saved.saveConversationHistory).toBe(true);
    // 切り替えたい項目だけを送り、GET で先行読み取りはしない。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/user-settings");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ saveConversationHistory: true });
  });
});

describe("getUserSettings", () => {
  it("rejects a malformed 200 response instead of treating it as disabled", async () => {
    // 形が違う応答を既定値へ黙って落とすと、オンなのにオフと表示される
    // 偽の安心を利用者へ与える（RULE-004）。
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    );

    await expect(getUserSettings(deps(fetchMock))).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe("putConversation", () => {
  it("PUTs the conversation to /conversations/:id", async () => {
    const conversation = buildConversation({
      id: "conv-1",
      userQuestion: "q?",
      question: "q?",
      selection: "const x = 1;",
      answer: "a",
      occurredAt: "2026-01-01T00:00:00.000Z",
      answeredAt: "2026-01-01T00:00:01.000Z",
      complete: true,
    });
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ saved: true }), { status: 200 }),
    );

    const result = await putConversation(deps(fetchMock), conversation);

    expect(result.saved).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/conversations/conv-1",
      expect.objectContaining({ method: "PUT", redirect: "error" }),
    );
  });

  it("surfaces a 403 as ApiRequestError so the caller can drop the stale cache", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: "conversation_history_disabled" }), { status: 403 }),
    );
    const conversation = buildConversation({
      id: "conv-1",
      userQuestion: "q?",
      question: "q?",
      selection: "s",
      answer: "a",
      occurredAt: "2026-01-01T00:00:00.000Z",
      answeredAt: "2026-01-01T00:00:01.000Z",
      complete: true,
    });

    const error = await putConversation(deps(fetchMock), conversation).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(403);
  });
});

const summary = {
  id: "conv-1",
  origin: "desktop",
  title: "エラーの意味は？",
  occurredAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  messageCount: 3,
  complete: true,
};

describe("listConversations", () => {
  it("requests the first page without a cursor and returns the page", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ conversations: [summary], nextCursor: "100_conv-1" }), {
          status: 200,
        }),
    );

    const page = await listConversations(deps(fetchMock));

    expect(page.conversations).toHaveLength(1);
    expect(page.nextCursor).toBe("100_conv-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/conversations",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("passes the server-issued cursor back verbatim", async () => {
    // カーソルの符号は API 側の実装詳細。デスクトップは解釈も自作もしない。
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ conversations: [], nextCursor: null }), { status: 200 }),
    );

    await listConversations(deps(fetchMock), "999_id/with+chars");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://api.example.com/v1/conversations?cursor=${encodeURIComponent("999_id/with+chars")}`,
    );
  });

  it("rejects a malformed 200 instead of showing an empty history", async () => {
    // 形が違う応答を空一覧へ黙って落とすと、保存済みの履歴が
    // 「まだ質問履歴がありません」と誤表示される（RULE-004）。
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ conversations: [{ id: 1 }], nextCursor: null }), {
          status: 200,
        }),
    );

    await expect(listConversations(deps(fetchMock))).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe("getConversation", () => {
  it("returns the conversation detail for the id", async () => {
    const conversation = buildConversation({
      id: "conv-1",
      userQuestion: "q?",
      question: "q?",
      selection: "const x = 1;",
      answer: "a",
      occurredAt: "2026-01-01T00:00:00.000Z",
      answeredAt: "2026-01-01T00:00:01.000Z",
      complete: true,
    });
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(conversation), { status: 200 }),
    );

    const result = await getConversation(deps(fetchMock), "conv-1");

    expect(result.id).toBe("conv-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/conversations/conv-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("surfaces a 404 so the renderer can report the deleted conversation", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: "conversation not found" }), { status: 404 }),
    );

    const error = await getConversation(deps(fetchMock), "gone").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(404);
  });
});

describe("deleteConversation", () => {
  it("DELETEs the conversation and returns the deleted count", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ deletedCount: 1 }), { status: 200 }),
    );

    const result = await deleteConversation(deps(fetchMock), "conv-1");

    expect(result.deletedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/conversations/conv-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
