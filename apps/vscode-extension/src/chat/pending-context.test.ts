import { expect, test } from "vitest";
import { PendingChatContext } from "./pending-context";

test("Chatを開く前に収集した文脈をParticipantのリクエストまで保持する", () => {
  const pending = new PendingChatContext();
  const context = {
    code: "client.fetchUser()",
    source: "editor" as const,
    contextLevel: 3 as const,
    surroundingCode: "const user = client.fetchUser();",
    languageId: "typescript",
    definitions: [
      {
        fileName: "client.ts",
        code: "export function fetchUser() {}",
        startLine: 4,
        symbol: "fetchUser",
      },
    ],
  };

  const id = pending.set(context);

  expect(pending.take(id)?.context).toBe(context);
});

test("文脈を消費して後続の無関係なChatリクエストへ再利用しない", () => {
  const pending = new PendingChatContext();
  const context = {
    code: "value",
    source: "editor" as const,
    contextLevel: 2 as const,
    surroundingCode: "const value = 1;",
  };
  const id = pending.set(context);

  expect(pending.take(id)?.context).toBe(context);
  expect(pending.take(id)).toBeUndefined();
});

test("Chatを2回開いた場合も文脈を別々に保持する", () => {
  const pending = new PendingChatContext();
  const first = {
    code: "first",
    source: "editor" as const,
    contextLevel: 2 as const,
    surroundingCode: "",
  };
  const second = {
    code: "second",
    source: "editor" as const,
    contextLevel: 2 as const,
    surroundingCode: "",
  };
  const firstId = pending.set(first);
  const secondId = pending.set(second);

  expect(pending.take(firstId)?.context).toBe(first);
  expect(pending.take(secondId)?.context).toBe(second);
});

test("Chatを開けなかった文脈は破棄して残さない", () => {
  const pending = new PendingChatContext();
  const context = {
    code: "secret-token",
    source: "clipboard" as const,
    contextLevel: 1 as const,
    surroundingCode: "",
  };
  const id = pending.set(context);

  pending.discard(id);

  // 送信されなかった内容がセッション中に残り続けないこと。
  expect(pending.take(id)).toBeUndefined();
});

test("破棄しても他の文脈には影響しない", () => {
  const pending = new PendingChatContext();
  const kept = {
    code: "kept",
    source: "editor" as const,
    contextLevel: 2 as const,
    surroundingCode: "",
  };
  const discarded = {
    code: "discarded",
    source: "editor" as const,
    contextLevel: 2 as const,
    surroundingCode: "",
  };
  const keptId = pending.set(kept);
  const discardedId = pending.set(discarded);

  pending.discard(discardedId);

  expect(pending.take(keptId)?.context).toBe(kept);
});

test("選択時に取得したDiagnosticsを同じChatリクエストまで保持する", () => {
  const pending = new PendingChatContext();
  const context = {
    code: "const value: number = 'text';",
    source: "editor" as const,
    contextLevel: 2 as const,
    surroundingCode: "",
  };
  const diagnostics = ["Type 'string' is not assignable to type 'number'."];

  const id = pending.set(context, diagnostics);

  expect(pending.take(id)).toEqual({ context, diagnostics });
});
