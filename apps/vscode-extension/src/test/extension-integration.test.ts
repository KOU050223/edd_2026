import { afterEach, expect, test, vi } from "vitest";
import type { CodeContext, LearningEvent } from "@gakushu-sochi/domain";

type ChatResponse = { markdown: ReturnType<typeof vi.fn>; progress: ReturnType<typeof vi.fn> };
type ChatHandler = (
  request: { prompt: string },
  chatContext: { history: never[] },
  response: ChatResponse,
) => Promise<void>;

const {
  activeTextEditor,
  collectFromEditor,
  executeCommand,
  getConfiguration,
  getOrCreateClientId,
  loadProfile,
  participantHandlers,
  recordEvent,
  registeredCommands,
  syncEvent,
} = vi.hoisted(() => ({
  activeTextEditor: {
    selection: {
      isEmpty: false,
      start: { line: 0, character: 0 },
      end: { line: 0, character: 16 },
    },
    document: { uri: { toString: () => "file:///example.ts" } },
  },
  collectFromEditor: vi.fn(),
  executeCommand: vi.fn(),
  getConfiguration: vi.fn(),
  getOrCreateClientId: vi.fn(),
  loadProfile: vi.fn(),
  participantHandlers: [] as ChatHandler[],
  recordEvent: vi.fn(),
  registeredCommands: new Map<string, () => Promise<void>>(),
  syncEvent: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    activeTextEditor,
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
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
  languages: { getDiagnostics: vi.fn(() => []) },
}));

vi.mock("../ai/vscodeLm", () => ({
  VSCodeLMProvider: class {
    readonly id = "fake";

    async ask() {
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
  readClipboard: vi.fn(),
  readTerminalSelection: vi.fn(),
}));

vi.mock("../learning/store", () => ({
  getOrCreateClientId,
  loadProfile,
  recordEvent,
}));

vi.mock("../learning/sync", () => ({ syncEvent }));

import { activate } from "../extension";

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
  registeredCommands.clear();
  participantHandlers.length = 0;
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

  const context = { subscriptions: [] as unknown[] };
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
    get: (key: string) => (key === "api.baseUrl" ? "https://api.example.com" : "api-token"),
  });
  syncEvent.mockResolvedValueOnce({ ok: true, status: "accepted" });

  const context = { subscriptions: [] as unknown[] };
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
    },
  );
});
