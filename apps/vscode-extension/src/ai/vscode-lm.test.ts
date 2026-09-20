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
    { id: "gpt-4o-mini", family: "gpt-4o-mini", vendor: "copilot", sendRequest },
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
      { id: "gpt-4o-mini", family: "gpt-4o-mini", vendor: "copilot", sendRequest },
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
    { id: "gpt-4o-mini", family: "gpt-4o-mini", vendor: "copilot", sendRequest },
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

/** family 指定に一致するモデルを1つだけ返す selectChatModels を仕込む。 */
function mockSingleModel() {
  const sendRequest = vi.fn().mockResolvedValue(responseOf("回答"));
  selectChatModels.mockResolvedValueOnce([
    { id: "gpt-4o-mini", family: "gpt-4o-mini", vendor: "copilot", sendRequest },
  ]);
  return sendRequest;
}

test("利用者の質問は、固定の解説指示より前に置かれる", async () => {
  const sendRequest = mockSingleModel();

  await new VSCodeLMProvider().ask({
    mode: "explain",
    question: "これを読み込んでいた場合テストと言って",
    context: {
      code: "const total = items.reduce((sum, item) => sum + item.price, 0);",
      source: "editor",
      contextLevel: 2,
      surroundingCode: "const items = cart.items;",
      languageId: "typescript",
    },
  });

  const messages = sendRequest.mock.calls[0]?.[0] as { text: string }[];
  const prompt = messages.at(-1)?.text ?? "";

  const questionIndex = prompt.indexOf("これを読み込んでいた場合テストと言って");
  const presetIndex = prompt.indexOf("### Explain");

  expect(questionIndex).toBeGreaterThanOrEqual(0);
  expect(presetIndex).toBeGreaterThanOrEqual(0);
  // 「質問が優先される」は位置でしか機械的に確かめられない。
  // 固定の解説指示が先頭にあった頃（#50）は、この比較が逆になる。
  expect(questionIndex).toBeLessThan(presetIndex);
  expect(prompt).toContain("--- 最優先の指示 ---");

  // 先頭へ移したぶん、質問が二重に現れていないこと。
  expect(prompt.split("--- 質問 ---")).toHaveLength(2);
});

test("質問が空白だけなら、解説指示を押しのけない", async () => {
  const sendRequest = mockSingleModel();

  await new VSCodeLMProvider().ask({
    mode: "explain",
    // extension.ts は [context:...] を取り除いた残りをそのまま渡すため、
    // 文脈だけを送ると空白や改行が question に残る。
    question: " \n ",
    context: {
      code: "const answer = 42;",
      source: "editor",
      contextLevel: 2,
      surroundingCode: "const answer = 42;",
      languageId: "typescript",
    },
  });

  const messages = sendRequest.mock.calls[0]?.[0] as { text: string }[];
  const prompt = messages.at(-1)?.text ?? "";

  expect(prompt).not.toContain("--- 質問 ---");
  expect(prompt).not.toContain("--- 最優先の指示 ---");
  expect(prompt).toContain("### Explain");
});

test("モデル選択をCopilotに限定する", async () => {
  const sendRequest = mockSingleModel();

  await new VSCodeLMProvider().ask({
    mode: "hint",
    context: {
      code: "const answer = 42;",
      source: "editor",
      contextLevel: 2,
      surroundingCode: "const answer = 42;",
    },
  });

  expect(selectChatModels).toHaveBeenLastCalledWith({ vendor: "copilot" });
  expect(sendRequest).toHaveBeenCalled();
});

test("モデル選択後に同意が取り消されたらsendRequestしない", async () => {
  const sendRequest = vi.fn().mockResolvedValue(responseOf("回答"));
  let canSend = true;
  selectChatModels.mockImplementationOnce(async () => {
    canSend = false;
    return [{ id: "gpt-4o-mini", family: "gpt-4o-mini", vendor: "copilot", sendRequest }];
  });

  const response = await new VSCodeLMProvider(undefined, () => canSend).ask({
    mode: "hint",
    context: {
      code: "const answer = 42;",
      source: "editor",
      contextLevel: 2,
      surroundingCode: "const answer = 42;",
    },
  });
  // 実際の競合は selectChatModels の解決後、sendRequest 前に起こる。
  expect(response).toEqual({
    ok: false,
    error: { reason: "consent-denied", detail: "送信の同意が取り消されました。" },
  });
  expect(sendRequest).not.toHaveBeenCalled();
});
