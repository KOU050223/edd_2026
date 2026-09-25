import { describe, expect, it } from "vitest";

import type { RawConversation } from "@gakushu-sochi/domain";

import {
  MAX_BODY_CHARS,
  conversationDigest,
  dedupeConversations,
  sanitizeConversation,
} from "./preprocess.js";

function conv(body: string, ref = "ref-1"): RawConversation {
  return { sourceId: "s1", externalRefHash: ref, observedAtMs: 1000, body };
}

describe("sanitizeConversation", () => {
  it("leaves clean text untouched", () => {
    const { conversation, removedKinds } = sanitizeConversation(conv("go fmt ./..."));
    expect(conversation.body).toBe("go fmt ./...");
    expect(removedKinds).toEqual([]);
  });

  it("masks email addresses", () => {
    const { conversation, removedKinds } = sanitizeConversation(
      conv("contact me at taro@example.com please"),
    );
    expect(conversation.body).toBe("contact me at <email> please");
    expect(removedKinds).toEqual(["email"]);
  });

  it("masks API keys and bearer tokens", () => {
    const { conversation, removedKinds } = sanitizeConversation(
      conv(`key is sk-abcdefghijklmnopqrstuvwxyz123456 and ghp_abcdefghijklmnop123456`),
    );
    expect(conversation.body).not.toContain("sk-abc");
    expect(conversation.body).not.toContain("ghp_");
    expect(removedKinds).toContain("token");
  });

  it("masks absolute local paths but keeps relative ones", () => {
    const { conversation, removedKinds } = sanitizeConversation(
      conv("edit /Users/taro/project/main.go not ./main.go"),
    );
    expect(conversation.body).toBe("edit <path> not ./main.go");
    expect(removedKinds).toContain("local-path");
  });

  it("masks Windows absolute paths", () => {
    const { conversation } = sanitizeConversation(conv("open C:\\Users\\taro\\main.go"));
    expect(conversation.body).toBe("open <path>");
  });

  it("truncates bodies beyond the limit", () => {
    const { conversation, removedKinds } = sanitizeConversation(
      conv("x".repeat(MAX_BODY_CHARS + 1)),
    );
    expect(conversation.body).toHaveLength(MAX_BODY_CHARS);
    expect(removedKinds).toContain("truncated");
  });

  it("masks sensitive text in titles as well", () => {
    const { conversation, removedKinds } = sanitizeConversation({
      ...conv("goroutine について教えて"),
      title: "question from taro@example.com",
    });
    expect(conversation.title).toBe("question from <email>");
    expect(removedKinds).toContain("email");
  });

  it("keeps the title field absent when the raw conversation has none", () => {
    const { conversation } = sanitizeConversation(conv("go fmt ./..."));
    expect("title" in conversation).toBe(false);
  });
});

describe("dedupeConversations", () => {
  it("drops later conversations with the same body ignoring case and whitespace", () => {
    const { conversations, duplicateCount } = dedupeConversations([
      conv("  Hello World ", "a"),
      conv("hello world", "b"),
      conv("different", "c"),
    ]);
    expect(duplicateCount).toBe(1);
    expect(conversations.map((c) => c.externalRefHash)).toEqual(["a", "c"]);
  });

  it("keeps conversations that differ only by reference", () => {
    const { conversations, duplicateCount } = dedupeConversations([
      conv("same", "a"),
      conv("same", "a"),
    ]);
    expect(duplicateCount).toBe(1);
    expect(conversations).toHaveLength(1);
  });

  it("produces a stable digest for identical bodies", () => {
    expect(conversationDigest(conv("abc"))).toBe(conversationDigest(conv(" abc ")));
  });
});
