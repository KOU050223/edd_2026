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
  // buildNoModelGuidance() が案内を版で書き分けるため、モックにも version が要る。
  version: "1.122.0",
  lm: {
    selectChatModels,
  },
}));

import { VSCodeLMProvider } from "./vscodeLm";
import { buildNoModelGuidance } from "./model-selection";
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

test("languageIdが無くても、言語に依らない領域のConceptは一覧に含める", async () => {
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

  // git や db のような領域の Concept は languageId に対応付かないため、
  // languageId が無い入力（クリップボード経由など）でも一覧へ載せる。
  // 言語の Concept は当てはめ先が分からないので載せない。
  expect(prompt).toContain("--- 既知の概念一覧");
  expect(prompt).toContain("git.commit");
  expect(prompt).not.toContain("ts.variable_declaration");
  expect(prompt).not.toContain("conceptIds は空配列にしてください");
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

test("モデル選択を vendor で絞り込まない", async () => {
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

  // #121: vendor: "copilot" で絞ると Copilot 未契約の利用者は必ず空になり、
  // BYOK で登録済みのモデルがあっても届かない。優先順位は selectModel() が持つ。
  expect(selectChatModels).toHaveBeenLastCalledWith();
  expect(sendRequest).toHaveBeenCalled();
});

test("Copilot が無くても BYOK のモデルがあれば質問できる", async () => {
  const sendRequest = vi.fn().mockResolvedValue(responseOf("回答"));
  selectChatModels.mockResolvedValueOnce([
    { id: "claude-fable-5.1", family: "claude-fable-5.1", vendor: "anthropic", sendRequest },
  ]);

  const response = await new VSCodeLMProvider().ask({
    mode: "hint",
    context: {
      code: "const answer = 42;",
      source: "editor",
      contextLevel: 2,
      surroundingCode: "const answer = 42;",
    },
  });

  expect(response.ok).toBe(true);
  expect(sendRequest).toHaveBeenCalled();
});

test("モデルが1つも無ければ、使える経路への案内を添えて失敗を返す", async () => {
  selectChatModels.mockResolvedValueOnce([]);

  const response = await new VSCodeLMProvider().ask({
    mode: "hint",
    context: {
      code: "const answer = 42;",
      source: "editor",
      contextLevel: 2,
      surroundingCode: "const answer = 42;",
    },
  });

  // 失敗を成功に化けさせない（RULE-004）。そのうえで次の一手を渡す。
  expect(response.ok).toBe(false);
  if (response.ok) {
    throw new Error("expected a failure response");
  }
  expect(response.error.reason).toBe("model-unavailable");
  expect(response.error.detail).toBe(buildNoModelGuidance("1.122.0"));
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
