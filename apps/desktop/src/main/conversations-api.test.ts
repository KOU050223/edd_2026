import { describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "./api-request.js";
import {
  getUserSettings,
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
  it("sends the current unrelated settings back with the toggled flag", async () => {
    // PUT は displayName・activityPeriodDays を必須とする。省略すると
    // 「オプトインを切り替えただけで表示名が消えた」になるため、
    // GET で読んだ値をそのまま送り返す。
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ ...remoteSettings, saveConversationHistory: true }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(remoteSettings), { status: 200 });
    });

    const saved = await setSaveConversationHistory(deps(fetchMock), true);

    expect(saved.saveConversationHistory).toBe(true);
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(putCall?.[0]).toBe("https://api.example.com/v1/user-settings");
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      displayName: "学習者",
      activityPeriodDays: 30,
      saveConversationHistory: true,
    });
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
