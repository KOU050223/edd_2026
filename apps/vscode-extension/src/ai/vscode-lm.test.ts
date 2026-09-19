import { expect, test, vi } from "vitest";

const { LanguageModelError, selectChatModels } = vi.hoisted(() => {
  class MockLanguageModelError extends Error {
    static NoPermissions = () => undefined;
    static Blocked = () => undefined;
    static NotFound = () => undefined;
  }

  return {
    LanguageModelError: MockLanguageModelError,
    selectChatModels: vi.fn(),
  };
});

vi.mock("vscode", () => ({
  LanguageModelChatMessage: {
    User: vi.fn((text: string) => ({ role: "user", text })),
    Assistant: vi.fn((text: string) => ({ role: "assistant", text })),
  },
  LanguageModelError,
  lm: {
    selectChatModels,
  },
}));

import { VSCodeLMProvider } from "./vscodeLm";
import * as vscode from "vscode";

/** for-await できる最小限の LanguageModelChatResponse を組む。 */
function responseOf(text: string): { text: AsyncIterable<string> } {
  return {
    text: (async function* () {
      yield text;
    })(),
  };
}

test("モデル選択に失敗したときは例外ではなく失敗応答を返す", async () => {
  selectChatModels.mockRejectedValueOnce(new Error("model selection failed"));

  const response = await new VSCodeLMProvider().ask({
    mode: "hint",
    context: {
      code: "const answer = 42;",
      source: "editor",
      contextLevel: 2,
      surroundingCode: "const answer = 42;",
    },
  });

  expect(response).toEqual({
    ok: false,
    error: {
      reason: "unknown",
      detail: "Error: model selection failed",
    },
  });
});

test("languageIdに一致するConceptの一覧をプロンプトに含める", async () => {
  const sendRequest = vi.fn().mockResolvedValue(responseOf("説明文"));
  selectChatModels.mockResolvedValueOnce([
    { id: "gpt-4o-mini", family: "gpt-4o-mini", sendRequest },
  ]);

  await new VSCodeLMProvider().ask({
    mode: "explain",
    context: {
      code: "pi := 3.14",
      source: "editor",
      contextLevel: 2,
      surroundingCode: "pi := 3.14",
      languageId: "go",
    },
  });

  // toMessages() は非公開なので、実際にモデルへ渡された内容（sendRequestの引数）で検証する。
  const messages = sendRequest.mock.calls[0]?.[0] as { text: string }[];
  const prompt = messages.at(-1)?.text ?? "";

  expect(prompt).toContain("go.variable_declaration");
  // 未実装のConcept抽出（実機で確認済みのバグ）の再発防止:
  // IDの一覧を渡さずに「既知のIDだけ入れろ」とだけ指示すると、モデルは
  // 正確なID文字列を知らないため空配列を返しがちになる。
  expect(vi.mocked(vscode.LanguageModelChatMessage.User)).toHaveBeenCalled();
});

test.each(["typescript", "javascript"])(
  "%s の質問には共通の ts Concept 一覧をプロンプトに含める",
  async (languageId) => {
    const sendRequest = vi.fn().mockResolvedValue(responseOf("説明文"));
    selectChatModels.mockResolvedValueOnce([
      { id: "gpt-4o-mini", family: "gpt-4o-mini", sendRequest },
    ]);

    await new VSCodeLMProvider().ask({
      mode: "explain",
      context: {
        code: "const values = [1, 2, 3];",
        source: "editor",
        contextLevel: 2,
        surroundingCode: "const values = [1, 2, 3];",
        languageId,
      },
    });

    const messages = sendRequest.mock.calls[0]?.[0] as { text: string }[];
    const prompt = messages.at(-1)?.text ?? "";

    expect(prompt).toContain("ts.variable_declaration");
    expect(prompt).not.toContain("conceptIds は空配列にしてください");
  },
);

test("languageIdが無ければConcept一覧を含めない", async () => {
  const sendRequest = vi.fn().mockResolvedValue(responseOf("説明文"));
  selectChatModels.mockResolvedValueOnce([
    { id: "gpt-4o-mini", family: "gpt-4o-mini", sendRequest },
  ]);

  await new VSCodeLMProvider().ask({
    mode: "explain",
    context: {
      code: "console.log(1)",
      source: "clipboard",
      contextLevel: 1,
      surroundingCode: "",
    },
  });

  const messages = sendRequest.mock.calls[0]?.[0] as { text: string }[];
  const prompt = messages.at(-1)?.text ?? "";

  // 一覧の見出しそのものが無いことを見る。「既知の概念一覧が無いため空配列に」という
  // フォールバック文言自体に同じ語が含まれるため、見出し（--- 付き）で区別する。
  expect(prompt).not.toContain("--- 既知の概念一覧");
});
