// history:* のハンドラ登録（Issue #279 ステップ 3 で index.ts から分離）。
import { dialog } from "electron";

import type { HistoryProviderId } from "@gakushu-sochi/domain";

import { apiDeps } from "../api-deps.js";
import { appState } from "../app-state.js";
import { deleteEvidenceByProvider, listImportSessions, undoImportSession } from "../history/api.js";
import {
  analyzeHistory,
  applyImport,
  buildImportPrompt,
  detectHistorySources,
  pasteAnalysisIntoImport,
} from "../history/import.js";
import { EVENT_CHANNELS, INVOKE_CHANNELS, type HistoryAnalyzeRequest } from "../../shared/ipc.js";
import { handle, send } from "./helpers.js";

const HISTORY_PROVIDERS: readonly string[] = [
  "codex",
  "chatgpt",
  "claude-code",
  "claude",
  "copilot",
  "cursor",
  "gemini",
  "vscode",
];

export function registerHistoryIpc(): void {
  handle(INVOKE_CHANNELS.historyDetect, detectHistorySources);
  handle(INVOKE_CHANNELS.historyPickFile, async () => {
    const options = {
      filters: [{ name: "AI エクスポート (JSON)", extensions: ["json"] }],
      properties: ["openFile" as const],
    };
    const result = appState.popup
      ? await dialog.showOpenDialog(appState.popup, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(INVOKE_CHANNELS.historyAnalyze, async (event, request: HistoryAnalyzeRequest) =>
    analyzeHistory(request, (progress) => {
      send(event.sender, EVENT_CHANNELS.historyProgress, progress);
    }),
  );
  handle(INVOKE_CHANNELS.historyBuildPrompt, buildImportPrompt);
  handle(INVOKE_CHANNELS.historyPasteAnalysis, (_event, text: unknown) =>
    pasteAnalysisIntoImport(text),
  );
  handle(INVOKE_CHANNELS.historyApply, async (_event, payload) => applyImport(payload));
  handle(INVOKE_CHANNELS.historyList, () => listImportSessions(apiDeps()));
  handle(INVOKE_CHANNELS.historyUndo, (_event, id: unknown) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("取り消す Import の ID が指定されていません。");
    }
    return undoImportSession(apiDeps(), id);
  });
  handle(INVOKE_CHANNELS.historyDeleteProvider, (_event, provider: unknown) => {
    if (typeof provider !== "string" || !HISTORY_PROVIDERS.includes(provider)) {
      throw new Error("削除する履歴ソースが不正です。");
    }
    return deleteEvidenceByProvider(apiDeps(), provider as HistoryProviderId);
  });
}
