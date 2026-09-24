import { afterEach, expect, test, vi } from "vitest";
import type { AIRequest, CodeContext, LearningEvent } from "@gakushu-sochi/domain";
import { buildPrompt } from "../ai/prompt";

type ChatResponse = { markdown: ReturnType<typeof vi.fn>; progress: ReturnType<typeof vi.fn> };
type ChatHandler = (
  request: { prompt: string },
  chatContext: { history: never[] },
  response: ChatResponse,
) => Promise<void>;

const {
  activeTextEditor,
  askedRequests,
  confirmSend,
  collectFromEditor,
  deleteServerLearningData,
  showErrorMessage,
  showInformationMessage,
  showWarningMessage,
  executeCommand,
  getConfiguration,
  getDiagnostics,
  getOrCreateClientId,
  loadProfile,
  participantHandlers,
  readClipboard,
  recordEvent,
  registeredCommands,
  showInputBox,
  showQuickPick,
  syncEvent,
  outputChannel,
} = vi.hoisted(() => ({
  activeTextEditor: {
    selection: {
      isEmpty: false,
      start: { line: 0, character: 0 },
      end: { line: 0, character: 16 },
    },
    document: { uri: { toString: () => "file:///example.ts" } },
  },
  askedRequests: [] as AIRequest[],
  confirmSend: vi.fn(),
  collectFromEditor: vi.fn(),
  deleteServerLearningData: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  executeCommand: vi.fn(),
  getConfiguration: vi.fn(),
  getDiagnostics: vi.fn((): unknown[] => []),
  getOrCreateClientId: vi.fn(),
  loadProfile: vi.fn(),
  participantHandlers: [] as ChatHandler[],
  readClipboard: vi.fn(),
  recordEvent: vi.fn(),
  registeredCommands: new Map<string, () => Promise<void>>(),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  syncEvent: vi.fn(),
  outputChannel: {
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock("vscode", () => ({
  window: {
    activeTextEditor,
    createOutputChannel: vi.fn(() => outputChannel),
    showErrorMessage,
    showInformationMessage,
    showInputBox,
    showQuickPick,
    showWarningMessage,
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: {
    executeCommand,
    registerCommand: vi.fn((name: string, command: () => Promise<void>) => {
      registeredCommands.set(name, command);
      return { dispose: vi.fn() };
    }),
  },
  chat: {
    createChatParticipant: vi.fn((_id: string, handler: ChatHandler) => {
      participantHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
  },
  workspace: { getConfiguration },
  languages: { getDiagnostics },
}));

vi.mock("../ai/vscodeLm", () => ({
  VSCodeLMProvider: class {
    readonly id = "fake";

    async ask(request: AIRequest) {
      askedRequests.push(request);
      return {
        ok: true,
        answer: {
          mode: "explain",
          text: "変数宣言についての回答",
          conceptIds: ["ts.variable_declaration"],
          model: "fake",
        },
      };
    }
  },
}));

vi.mock("../context/collector", () => ({
  collectFromEditor,
  collectFromText: vi.fn((text: string, source: string) => ({
    code: text,
    source,
    contextLevel: 1,
    surroundingCode: "",
  })),
}));

vi.mock("../context/clipboard", () => ({
  readClipboard,
  readTerminalSelection: vi.fn(),
}));

vi.mock("../ui/confirm", () => ({ confirmSend }));

// 解説済みエラーの読み書きとローカルコピーの削除は実物を使い、
// 再発判定と削除の追従を globalState ごしに確かめる。
vi.mock("../learning/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../learning/store")>();
  return {
    getOrCreateClientId,
    loadProfile,
    recordEvent,
    clearLocalLearningData: actual.clearLocalLearningData,
    getAppliedHistoryResetAtMs: actual.getAppliedHistoryResetAtMs,
    loadExplainedErrors: actual.loadExplainedErrors,
    markHistoryResetApplied: actual.markHistoryResetApplied,
    saveExplainedErrors: actual.saveExplainedErrors,
  };
});

vi.mock("../learning/sync", () => ({ syncEvent, deleteServerLearningData }));

import { activate } from "../extension";
import { CONSENT_KEY } from "../consent/consent";
import {
  applyEvent,
  CONSENT_NOTICE_VERSION,
  createEmptyProfile,
  type LearnerProfile,
} from "@gakushu-sochi/domain";

/**
 * activate() に渡す最小の ExtensionContext。
 *
 * globalState を持たせるのは、#119 の同意がここに記録されるため。
 * 同意の有無で送信が止まることを、実際の保存先ごしに確かめる。
 */
function createExtensionContext(consented: boolean, secrets: Map<string, string> = new Map()) {
  const state = new Map<string, unknown>();
  if (consented) {
    state.set(CONSENT_KEY, {
      version: CONSENT_NOTICE_VERSION,
      grantedAt: "2026-09-21T00:00:00.000Z",
    });
  }
  return {
    subscriptions: [] as unknown[],
    globalState: {
      get: (key: string) => state.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
      },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
  };
}

const CONTEXT: CodeContext = {
  code: "const value = 1",
  source: "editor",
  contextLevel: 3,
  surroundingCode: "const value = 1",
  languageId: "typescript",
  fileName: "example.ts",
  startLine: 0,
  endLine: 0,
  definitions: [],
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  getDiagnostics.mockImplementation(() => []);
  registeredCommands.clear();
  participantHandlers.length = 0;
  askedRequests.length = 0;
});

test("クリップボード本文を送信前に出力パネルへ表示しない", async () => {
  readClipboard.mockResolvedValueOnce({ ok: true, text: "秘密のクリップボード本文" });
  confirmSend.mockResolvedValueOnce(true);
  executeCommand.mockResolvedValueOnce(undefined);
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });

  const context = createExtensionContext(true);
  activate(context as never);

  await registeredCommands.get("gakushuSochi.askClipboard")?.();

  expect(outputChannel.appendLine).not.toHaveBeenCalledWith(
    expect.stringContaining("秘密のクリップボード本文"),
  );
  expect(outputChannel.show).not.toHaveBeenCalled();
});

test("選択したコードの文脈をChatの質問から回答記録まで引き継ぐ", async () => {
  collectFromEditor.mockResolvedValueOnce(CONTEXT);
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });
  recordEvent.mockImplementation(async (_context, _profile, event: LearningEvent) => {
    return { events: [event], mastery: {} };
  });
  getConfiguration.mockReturnValue({
    get: (key: string, fallback: string) => {
      if (key === "api.baseUrl") return "";
      return fallback;
    },
  });

  const context = createExtensionContext(true);
  activate(context as never);

  await registeredCommands.get("gakushuSochi.askSelection")?.();

  const chatOpen = executeCommand.mock.calls.find(
    ([command]) => command === "workbench.action.chat.open",
  );
  expect(chatOpen?.[1]).toEqual(
    expect.objectContaining({
      query: expect.stringContaining("@gakushu-sochi [context:"),
      isPartialQuery: true,
    }),
  );

  const prompt = `${chatOpen?.[1].query.replace("@gakushu-sochi ", "")}このコードのConceptは？`;
  const response = { markdown: vi.fn(), progress: vi.fn() };
  await participantHandlers[0]?.({ prompt }, { history: [] }, response);

  expect(response.markdown).toHaveBeenCalledWith("変数宣言についての回答");
  expect(recordEvent).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      type: "answer_viewed",
      origin: "vscode",
      conceptIds: ["ts.variable_declaration"],
      language: "typescript",
    }),
    expect.any(Function),
  );
});

test("回答に含まれるConceptをAPI同期内容へ引き継ぐ", async () => {
  collectFromEditor.mockResolvedValueOnce(CONTEXT);
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });
  recordEvent.mockImplementation(async (_context, _profile, event: LearningEvent) => {
    return { events: [event], mastery: {} };
  });
  getOrCreateClientId.mockResolvedValueOnce("client-1");
  getConfiguration.mockReturnValue({
    get: (key: string, fallback?: string) =>
      key === "api.baseUrl" ? "https://api.example.com" : fallback,
  });
  syncEvent.mockResolvedValueOnce({ ok: true, status: "accepted" });

  const context = createExtensionContext(true);
  activate(context as never);
  await registeredCommands.get("gakushuSochi.askSelection")?.();

  const chatOpen = executeCommand.mock.calls.find(
    ([command]) => command === "workbench.action.chat.open",
  );
  const response = { markdown: vi.fn(), progress: vi.fn() };
  await participantHandlers[0]?.(
    { prompt: `${chatOpen?.[1].query.replace("@gakushu-sochi ", "")}分類してください` },
    { history: [] },
    response,
  );

  expect(syncEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      conceptIds: ["ts.variable_declaration"],
      language: "typescript",
    }),
    {
      apiBaseUrl: "https://api.example.com",
      apiToken: expect.any(Function),
      clientId: "client-1",
      canSend: expect.any(Function),
    },
  );
});

// --- #119: 同意するまで送らない -------------------------------------------------

test("同意していなければ、選択したコードを収集も送信もしない", async () => {
  // 「同意しない」を押した状態。
  showWarningMessage.mockResolvedValueOnce("同意しない");
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });

  const context = createExtensionContext(false);
  activate(context as never);

  await registeredCommands.get("gakushuSochi.askSelection")?.();

  // 収集すらしない。集めた時点で周辺コードや定義参照が動くため、
  // 「送らないなら集めない」を境界にする。
  expect(collectFromEditor).not.toHaveBeenCalled();
  expect(
    executeCommand.mock.calls.some(([command]) => command === "workbench.action.chat.open"),
  ).toBe(false);
  expect(syncEvent).not.toHaveBeenCalled();
});

test("同意していなければ、クリップボードの本文を送信しない", async () => {
  readClipboard.mockResolvedValueOnce({ ok: true, text: "秘密のクリップボード本文" });
  showWarningMessage.mockResolvedValueOnce(undefined); // ダイアログを閉じただけ
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });

  const context = createExtensionContext(false);
  activate(context as never);

  await registeredCommands.get("gakushuSochi.askClipboard")?.();

  // 同意が無い時点で止まるので、本文プレビューの確認にも進まない。
  expect(confirmSend).not.toHaveBeenCalled();
  expect(
    executeCommand.mock.calls.some(([command]) => command === "workbench.action.chat.open"),
  ).toBe(false);
});

test("同意したうえで初めて、選択したコードの送信へ進む", async () => {
  showWarningMessage.mockResolvedValueOnce("同意して続ける");
  collectFromEditor.mockResolvedValueOnce(CONTEXT);
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });

  const context = createExtensionContext(false);
  activate(context as never);

  await registeredCommands.get("gakushuSochi.askSelection")?.();

  expect(collectFromEditor).toHaveBeenCalled();
  expect(
    executeCommand.mock.calls.some(([command]) => command === "workbench.action.chat.open"),
  ).toBe(true);
  // 同意は記録されるので、2回目はもう聞かれない。
  expect(showWarningMessage).toHaveBeenCalledTimes(1);

  collectFromEditor.mockResolvedValueOnce(CONTEXT);
  await registeredCommands.get("gakushuSochi.askSelection")?.();
  expect(showWarningMessage).toHaveBeenCalledTimes(1);
});

test("同意を取り消すと、次の送信から止まる", async () => {
  collectFromEditor.mockResolvedValueOnce(CONTEXT);
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });

  const context = createExtensionContext(true);
  activate(context as never);

  await registeredCommands.get("gakushuSochi.askSelection")?.();
  expect(collectFromEditor).toHaveBeenCalledTimes(1);

  await registeredCommands.get("gakushuSochi.revokeConsent")?.();

  // 取り消し後は、再度同意を求められる（= 保存済みの同意が消えている）。
  showWarningMessage.mockResolvedValueOnce("同意しない");
  await registeredCommands.get("gakushuSochi.askSelection")?.();

  expect(collectFromEditor).toHaveBeenCalledTimes(1);
});

test("文脈を積んだ後に同意を取り消したら、AIへ送らない", async () => {
  collectFromEditor.mockResolvedValueOnce(CONTEXT);
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });

  const context = createExtensionContext(true);
  activate(context as never);

  await registeredCommands.get("gakushuSochi.askSelection")?.();
  const chatOpen = executeCommand.mock.calls.find(
    ([command]) => command === "workbench.action.chat.open",
  );

  // Chat を開いてから、回答が返る前に取り消す。
  await registeredCommands.get("gakushuSochi.revokeConsent")?.();

  const response = { markdown: vi.fn(), progress: vi.fn() };
  await participantHandlers[0]?.(
    { prompt: `${chatOpen?.[1].query.replace("@gakushu-sochi ", "")}このコードは？` },
    { history: [] },
    response,
  );

  expect(response.progress).not.toHaveBeenCalled();
  expect(response.markdown).toHaveBeenCalledWith(expect.stringContaining("同意"));
  expect(recordEvent).not.toHaveBeenCalled();
});

test("同意を取り消すと、学習イベントをAPIへ同期しない", async () => {
  collectFromEditor.mockResolvedValueOnce(CONTEXT);
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });
  recordEvent.mockImplementation(async (_context, _profile, event: LearningEvent) => ({
    events: [event],
    mastery: {},
  }));
  getConfiguration.mockReturnValue({
    get: (key: string, fallback?: string) =>
      key === "api.baseUrl" ? "https://api.example.com" : fallback,
  });

  const context = createExtensionContext(true);
  activate(context as never);

  await registeredCommands.get("gakushuSochi.askSelection")?.();
  const chatOpen = executeCommand.mock.calls.find(
    ([command]) => command === "workbench.action.chat.open",
  );
  const contextMarker = chatOpen?.[1].query.replace("@gakushu-sochi ", "");

  // 文脈は同意済みのうちに積み、Chat 応答の直前に取り消す……のではなく、
  // ここでは「同意したまま回答し、その後の同期だけ止まる」経路を切り分けて確かめたいので、
  // 回答は通し、persistEvent の直前に取り消しが入る状況を作る。
  recordEvent.mockImplementationOnce(async (_context, _profile, event: LearningEvent) => {
    await registeredCommands.get("gakushuSochi.revokeConsent")?.();
    return { events: [event], mastery: {} };
  });

  const response = { markdown: vi.fn(), progress: vi.fn() };
  await participantHandlers[0]?.(
    { prompt: `${contextMarker}このコードは？` },
    { history: [] },
    response,
  );

  expect(response.markdown).toHaveBeenCalledWith("変数宣言についての回答");
  expect(syncEvent).not.toHaveBeenCalled();
});

// --- 診断/02 #76: 同じエラーの再発を error_recurred として記録する -------------

/** 選択範囲（0:0〜0:16）に重なる Diagnostic を1件だけ持つ状態にする。 */
function diagnosticsOnSelection(code: number, message: string, severity: number = 0) {
  const diagnostic = {
    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
    severity,
    message,
    source: "ts",
    code,
  };
  getDiagnostics.mockImplementation(() => [
    [{ toString: () => "file:///example.ts" }, [diagnostic]],
  ]);
}

/** 選択範囲について質問し、回答まで進める。 */
async function askAboutSelection(): Promise<void> {
  collectFromEditor.mockResolvedValueOnce(CONTEXT);
  executeCommand.mockClear();
  await registeredCommands.get("gakushuSochi.askSelection")?.();
  const chatOpen = executeCommand.mock.calls.find(
    ([command]) => command === "workbench.action.chat.open",
  );
  const response = { markdown: vi.fn(), progress: vi.fn() };
  await participantHandlers[0]?.(
    { prompt: `${chatOpen?.[1].query.replace("@gakushu-sochi ", "")}このエラーは？` },
    { history: [] },
    response,
  );
  expect(response.markdown).toHaveBeenCalledWith("変数宣言についての回答");
}

/** recordEvent を domain の applyEvent で動かし、最後に記録された Profile を返せるようにする。 */
function recordWithDomain(initial: LearnerProfile): () => LearnerProfile {
  let latest = initial;
  loadProfile.mockReturnValueOnce(initial);
  recordEvent.mockImplementation(
    async (_context, profile: LearnerProfile, event: LearningEvent) => {
      latest = applyEvent(profile, event);
      return latest;
    },
  );
  getConfiguration.mockReturnValue({ get: (_key: string, fallback: string) => fallback });
  return () => latest;
}

function recordedTypes(): string[] {
  return recordEvent.mock.calls.map((call) => (call[2] as LearningEvent).type);
}

test("同じエラーを2回解説させるとerror_recurredを記録する", async () => {
  recordWithDomain(createEmptyProfile("2026-09-21T00:00:00.000Z"));
  activate(createExtensionContext(true) as never);

  diagnosticsOnSelection(2345, "Argument of type 'string' is not assignable to 'number'.");
  await askAboutSelection();
  expect(recordedTypes()).not.toContain("error_recurred");

  // 同じコードなら、型名が変わっても同じエラーとして扱う。
  diagnosticsOnSelection(2345, "Argument of type 'boolean' is not assignable to 'User'.");
  await askAboutSelection();

  expect(recordEvent).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({
      type: "error_recurred",
      origin: "vscode",
      conceptIds: ["ts.variable_declaration"],
      language: "typescript",
      diagnosticCode: "ts:2345",
    }),
    expect.any(Function),
  );
  expect(recordedTypes().filter((type) => type === "error_recurred")).toHaveLength(1);
});

test("別のエラーではerror_recurredを記録しない", async () => {
  recordWithDomain(createEmptyProfile("2026-09-21T00:00:00.000Z"));
  activate(createExtensionContext(true) as never);

  diagnosticsOnSelection(2345, "Argument of type 'string' is not assignable to 'number'.");
  await askAboutSelection();
  diagnosticsOnSelection(2322, "Type 'string' is not assignable to type 'number'.");
  await askAboutSelection();

  expect(recordedTypes()).not.toContain("error_recurred");
});

test("Diagnosticsが無い質問では再発を判定しない", async () => {
  recordWithDomain(createEmptyProfile("2026-09-21T00:00:00.000Z"));
  activate(createExtensionContext(true) as never);

  await askAboutSelection();
  await askAboutSelection();

  expect(recordedTypes()).not.toContain("error_recurred");
});

test("error_recurredの記録で、該当Conceptがconfirmedから外れる", async () => {
  let confirmed = createEmptyProfile("2026-09-21T00:00:00.000Z");
  for (const id of ["s1", "s2"]) {
    confirmed = applyEvent(confirmed, {
      id,
      occurredAt: "2026-09-21T00:00:00.000Z",
      type: "solved_independently",
      origin: "vscode",
      conceptIds: ["ts.variable_declaration"],
    });
  }
  expect(confirmed.mastery["ts.variable_declaration"]?.status).toBe("confirmed");
  const latestProfile = recordWithDomain(confirmed);
  activate(createExtensionContext(true) as never);

  diagnosticsOnSelection(2345, "Argument of type 'string' is not assignable to 'number'.");
  await askAboutSelection();
  // 解説を見ただけでは confirmed のまま。
  expect(latestProfile().mastery["ts.variable_declaration"]?.status).toBe("confirmed");

  await askAboutSelection();
  expect(latestProfile().mastery["ts.variable_declaration"]?.status).toBe("learning");
});

// --- #44: 人格設定（persona）の境界 -------------------------------------------

test("人格設定をChat経由のAIRequestへ載せる", async () => {
  recordWithDomain(createEmptyProfile("2026-09-21T00:00:00.000Z"));
  getConfiguration.mockReturnValue({
    get: (key: string, fallback: string) => (key === "ai.persona" ? "幼馴染" : fallback),
  });
  activate(createExtensionContext(true) as never);

  await askAboutSelection();

  expect(askedRequests[0]?.persona).toBe("幼馴染");
});

test("上限を超える人格設定は適用せず、理由を出力パネルへ記録する", async () => {
  // settings.json の直接編集では manifest の maxLength を超えた値が来る。
  recordWithDomain(createEmptyProfile("2026-09-21T00:00:00.000Z"));
  getConfiguration.mockReturnValue({
    get: (key: string, fallback: string) => (key === "ai.persona" ? "あ".repeat(501) : fallback),
  });
  activate(createExtensionContext(true) as never);

  await askAboutSelection();

  // 黙って切り詰めず、適用をやめて理由を記録する（RULE-004）。
  expect(askedRequests[0]?.persona).toBeUndefined();
  expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("人格設定"));
});

test("文字列でない人格設定は適用せず、理由を出力パネルへ記録する", async () => {
  // settings.json の直接編集では manifest の型を外れた値が来る。
  recordWithDomain(createEmptyProfile("2026-09-21T00:00:00.000Z"));
  getConfiguration.mockReturnValue({
    get: (key: string, fallback: unknown) => (key === "ai.persona" ? 42 : fallback),
  });
  activate(createExtensionContext(true) as never);

  await askAboutSelection();

  expect(askedRequests[0]?.persona).toBeUndefined();
  expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("人格設定"));
});

// --- #161: Hint・Information の Diagnostic で Error Explain に切り替えない ------

test("Hintだけが重なる選択ではError ExplainではなくExplainで回答させる", async () => {
  recordWithDomain(createEmptyProfile("2026-09-21T00:00:00.000Z"));
  activate(createExtensionContext(true) as never);

  // TypeScript は未使用変数を Hint（DiagnosticSeverity.Hint = 3）で出す。
  diagnosticsOnSelection(6133, "'userName' is declared but its value is never read.", 3);
  await askAboutSelection();

  const prompt = buildPrompt(askedRequests[0] as AIRequest);
  expect(prompt).toContain("### Explain");
  expect(prompt).not.toContain("### Error Explain");
  expect(prompt).not.toContain("is declared but its value is never read");
});

test("Errorが重なる選択では従来どおりError Explainで回答させる", async () => {
  recordWithDomain(createEmptyProfile("2026-09-21T00:00:00.000Z"));
  activate(createExtensionContext(true) as never);

  diagnosticsOnSelection(2345, "Argument of type 'string' is not assignable to 'number'.", 0);
  await askAboutSelection();

  const prompt = buildPrompt(askedRequests[0] as AIRequest);
  expect(prompt).toContain("### Error Explain");
  expect(prompt).toContain("Argument of type 'string' is not assignable to 'number'.");
});

// --- AI/04 #55: BYOK 経路への切り替え -----------------------------------------

/** BYOK 経路で質問し、Chat の応答オブジェクトを返す。 */
async function askByok(): Promise<ChatResponse> {
  collectFromEditor.mockResolvedValueOnce(CONTEXT);
  executeCommand.mockClear();
  await registeredCommands.get("gakushuSochi.askSelection")?.();
  const chatOpen = executeCommand.mock.calls.find(
    ([command]) => command === "workbench.action.chat.open",
  );
  const response = { markdown: vi.fn(), progress: vi.fn() };
  await participantHandlers[0]?.(
    { prompt: `${chatOpen?.[1].query.replace("@gakushu-sochi ", "")}このコードは？` },
    { history: [] },
    response,
  );
  return response;
}

/** ai.provider=byok の設定を持つ getConfiguration の偽物。 */
function byokConfiguration() {
  return {
    get: (key: string, fallback?: string) => {
      if (key === "ai.provider") return "byok";
      if (key === "api.baseUrl") return "";
      return fallback;
    },
  };
}

test("ai.provider が byok なら、SecretStorage のキーで直接 AI 提供元を呼ぶ", async () => {
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });
  recordEvent.mockImplementation(async (_context, _profile, event: LearningEvent) => ({
    events: [event],
    mastery: {},
  }));
  getConfiguration.mockReturnValue(byokConfiguration());
  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "BYOK の回答" }] }), {
        status: 200,
      });
    }),
  );

  const secrets = new Map([["gakushuSochi.byok.apiKey.anthropic", "sk-ant-test"]]);
  activate(createExtensionContext(true, secrets) as never);
  const response = await askByok();

  // vscode.lm（偽の VSCodeLMProvider）ではなく、BYOK の HTTP 経路へ行く。
  expect(askedRequests).toHaveLength(0);
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  expect((fetchCalls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
  expect(response.markdown).toHaveBeenCalledWith("BYOK の回答");
});

test("SecretStorage が読めないときも、例外を投げず失敗を案内する", async () => {
  // OS の資格情報ストアがロック中などで secrets.get が reject しうる。
  // provider.ask の外で例外が出ると失敗描画を通らないため、値として返す。
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });
  getConfiguration.mockReturnValue(byokConfiguration());
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const context = createExtensionContext(true);
  context.secrets.get = async () => {
    throw new Error("keychain is locked");
  };
  activate(context as never);
  const response = await askByok();

  expect(fetchMock).not.toHaveBeenCalled();
  expect(askedRequests).toHaveLength(0);
  expect(response.markdown).toHaveBeenCalledWith(expect.stringContaining("資格情報ストア"));
});

test("BYOK のキー保存で提供元を切り替えると、前の提供元の上書き設定を既定へ戻す", async () => {
  // OpenAI 互換の baseUrl を残したまま anthropic のキーを保存すると、
  // そのキーが前の提供元の URL へ送られてしまう。切り替え時に戻すのが正しい。
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });
  const updates: [string, unknown][] = [];
  getConfiguration.mockReturnValue({
    get: (key: string, fallback?: string) => {
      if (key === "byok.vendor") return "openai";
      if (key === "byok.baseUrl") return "https://openrouter.ai/api";
      if (key === "api.baseUrl") return "";
      return fallback;
    },
    update: async (key: string, value: unknown) => {
      updates.push([key, value]);
    },
  });
  showQuickPick.mockResolvedValueOnce({ label: "anthropic" });
  showInputBox.mockResolvedValueOnce("sk-ant-new");

  const secrets = new Map<string, string>();
  activate(createExtensionContext(true, secrets) as never);
  await registeredCommands.get("gakushuSochi.setByokApiKey")?.();

  expect(secrets.get("gakushuSochi.byok.apiKey.anthropic")).toBe("sk-ant-new");
  expect(updates).toContainEqual(["byok.vendor", "anthropic"]);
  expect(updates).toContainEqual(["byok.baseUrl", undefined]);
  expect(updates).toContainEqual(["byok.model", undefined]);
});

test("ai.provider が byok でもキーが未設定なら、送信せず設定コマンドへ案内する", async () => {
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });
  getConfiguration.mockReturnValue(byokConfiguration());
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  activate(createExtensionContext(true) as never);
  const response = await askByok();

  expect(fetchMock).not.toHaveBeenCalled();
  expect(askedRequests).toHaveLength(0);
  expect(response.markdown).toHaveBeenCalledWith(expect.stringContaining("API キーが未設定"));
});

// --- #124: 学習データの削除 -----------------------------------------------------

const LEARNER_PROFILE_KEY = "gakushuSochi.learnerProfile";
const APPLIED_RESET_KEY = "gakushuSochi.appliedHistoryResetAtMs";

test("削除コマンドはサーバー削除の成功後にローカルのコピーを消す", async () => {
  // docs/architecture.md「クライアント側に残るコピー」: サーバー側の成功を
  // 確かめてから globalState を空にする。
  showWarningMessage.mockResolvedValueOnce("削除する");
  deleteServerLearningData.mockResolvedValueOnce({
    ok: true,
    deletedCount: 2,
    resetAtMs: 5_000,
  });
  getConfiguration.mockReturnValue({
    get: (key: string, fallback?: string) =>
      key === "api.baseUrl" ? "https://api.example.com" : fallback,
  });
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });

  const context = createExtensionContext(true);
  await context.globalState.update(LEARNER_PROFILE_KEY, {
    version: 1,
    events: [{}],
    mastery: {},
  });
  activate(context as never);

  await registeredCommands.get("gakushuSochi.deleteLearningData")?.();

  expect(deleteServerLearningData).toHaveBeenCalledWith({
    apiBaseUrl: "https://api.example.com",
    apiToken: expect.any(Function),
  });
  expect(context.globalState.get(LEARNER_PROFILE_KEY)).toBeUndefined();
  // 自分が呼んだ削除を「他端末から見えた削除」として二度処理しないよう記録する。
  expect(context.globalState.get(APPLIED_RESET_KEY)).toBe(5_000);
  expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("削除しました"));
});

test("サーバー側の削除に失敗したらローカルのコピーは残し、失敗を伝える", async () => {
  // 手元だけ消える「消えたように見える」状態を作らない。
  showWarningMessage.mockResolvedValueOnce("削除する");
  deleteServerLearningData.mockResolvedValueOnce({ ok: false, reason: "HTTP 500" });
  getConfiguration.mockReturnValue({
    get: (key: string, fallback?: string) =>
      key === "api.baseUrl" ? "https://api.example.com" : fallback,
  });
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });

  const context = createExtensionContext(true);
  await context.globalState.update(LEARNER_PROFILE_KEY, {
    version: 1,
    events: [{}],
    mastery: {},
  });
  activate(context as never);

  await registeredCommands.get("gakushuSochi.deleteLearningData")?.();

  expect(context.globalState.get(LEARNER_PROFILE_KEY)).toBeDefined();
  expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("削除できませんでした"));
});

test("削除の確認でキャンセルしたらサーバーもローカルも触らない", async () => {
  showWarningMessage.mockResolvedValueOnce(undefined);
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });

  const context = createExtensionContext(true);
  await context.globalState.update(LEARNER_PROFILE_KEY, {
    version: 1,
    events: [{}],
    mastery: {},
  });
  activate(context as never);

  await registeredCommands.get("gakushuSochi.deleteLearningData")?.();

  expect(deleteServerLearningData).not.toHaveBeenCalled();
  expect(context.globalState.get(LEARNER_PROFILE_KEY)).toBeDefined();
});

test("他端末がサーバー側を削除したら、同期応答の削除時刻でローカルも消える", async () => {
  // 削除を呼んだのは別の端末。この端末は次回の同期で削除時刻を受け取り、
  // ローカルのコピーを消す。
  collectFromEditor.mockResolvedValueOnce(CONTEXT);
  loadProfile.mockReturnValueOnce(createEmptyProfile("2026-09-21T00:00:00.000Z"));
  recordEvent.mockImplementation(async (_context, profile: LearnerProfile, event: LearningEvent) =>
    applyEvent(profile, event),
  );
  getOrCreateClientId.mockResolvedValueOnce("client-1");
  getConfiguration.mockReturnValue({
    get: (key: string, fallback?: string) =>
      key === "api.baseUrl" ? "https://api.example.com" : fallback,
  });
  syncEvent.mockResolvedValueOnce({
    ok: true,
    status: "accepted",
    historyResetAtMs: 5_000,
    droppedByReset: false,
  });

  const context = createExtensionContext(true);
  await context.globalState.update(LEARNER_PROFILE_KEY, {
    version: 1,
    events: [{}],
    mastery: {},
  });
  activate(context as never);

  await askAboutSelection();

  // 削除への追従が記録され、コピーは消えている。
  expect(context.globalState.get(APPLIED_RESET_KEY)).toBe(5_000);
  expect(context.globalState.get(LEARNER_PROFILE_KEY)).toBeUndefined();
  // 直前に受理されたイベントは削除の後にサーバーへ書かれているため、
  // 消したあとの空のプロファイルへ記録し直して齟齬しないようにする。
  const lastCall = recordEvent.mock.calls.at(-1);
  expect((lastCall?.[1] as LearnerProfile).events).toEqual([]);
});

test("削除境界に吞まれたイベントは、追従しても記録し直さない", async () => {
  // droppedByReset のイベントはサーバーへ保存されていない。追従後に
  // 記録し直すと「サーバーが削除境界の内側に倒したイベント」が
  // ローカルにだけ復活する（Issue #124 レビュー）。
  collectFromEditor.mockResolvedValueOnce(CONTEXT);
  loadProfile.mockReturnValueOnce(createEmptyProfile("2026-09-21T00:00:00.000Z"));
  recordEvent.mockImplementation(async (_context, profile: LearnerProfile, event: LearningEvent) =>
    applyEvent(profile, event),
  );
  getOrCreateClientId.mockResolvedValueOnce("client-1");
  getConfiguration.mockReturnValue({
    get: (key: string, fallback?: string) =>
      key === "api.baseUrl" ? "https://api.example.com" : fallback,
  });
  syncEvent.mockResolvedValueOnce({
    ok: true,
    status: "accepted",
    historyResetAtMs: 5_000,
    droppedByReset: true,
  });

  const context = createExtensionContext(true);
  activate(context as never);

  await askAboutSelection();

  // 削除への追従自体は行われる。
  expect(context.globalState.get(APPLIED_RESET_KEY)).toBe(5_000);
  // recordEvent は persistEvent 冒頭の1回だけ。追従後の記録し直しは無い。
  expect(recordEvent).toHaveBeenCalledTimes(1);
});

test("削除の実行中にコマンドを再度呼んでも二重には走らない", async () => {
  // RULE-007: 実行中の再入は状態で止める。
  showWarningMessage.mockResolvedValue("削除する");
  let resolveDelete: ((outcome: unknown) => void) | undefined;
  deleteServerLearningData.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveDelete = resolve;
      }),
  );
  getConfiguration.mockReturnValue({
    get: (key: string, fallback?: string) =>
      key === "api.baseUrl" ? "https://api.example.com" : fallback,
  });
  loadProfile.mockReturnValueOnce({ events: [], mastery: {} });

  const context = createExtensionContext(true);
  activate(context as never);

  const command = registeredCommands.get("gakushuSochi.deleteLearningData");
  const first = command?.();
  // 1回目がサーバー削除の応答を待っている間に2回目を呼ぶ。
  const second = command?.();
  await second;

  expect(deleteServerLearningData).toHaveBeenCalledTimes(1);
  expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("実行中"));

  resolveDelete?.({ ok: true, deletedCount: 0, resetAtMs: 5_000 });
  await first;
});
