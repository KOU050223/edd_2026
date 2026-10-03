import { describe, expect, it } from "vitest";

import { buildConversation } from "./conversation.js";

const base = {
  id: "conv-1",
  userQuestion: "このコードは何をしていますか？",
  question: "このコードは何をしていますか？",
  selection: "const x = 1;",
  answer: "x に 1 を代入しています。",
  occurredAt: "2026-01-01T00:00:00.000Z",
  answeredAt: "2026-01-01T00:00:05.000Z",
};

describe("buildConversation", () => {
  it("assembles context, user and assistant messages in order", () => {
    const conversation = buildConversation({ ...base, complete: true });

    expect(conversation).toEqual({
      id: "conv-1",
      origin: "desktop",
      title: "このコードは何をしていますか？",
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

  it("derives the title from the selection when the question input was empty", () => {
    // 既定の質問文はどの会話も同じ先頭になるため、タイトルは選択テキストから取る。
    const conversation = buildConversation({
      ...base,
      userQuestion: "   ",
      question: "この選択テキストを初心者にも分かるように解説してください。",
    });

    expect(conversation.title).toBe("const x = 1;");
    // 質問として保存する本文は正規化済み（既定文）のほう。
    expect(conversation.messages[1]?.text).toBe(
      "この選択テキストを初心者にも分かるように解説してください。",
    );
  });

  it("keeps complete false for an interrupted answer", () => {
    const conversation = buildConversation({ ...base, complete: false });

    expect(conversation.complete).toBe(false);
  });
});
