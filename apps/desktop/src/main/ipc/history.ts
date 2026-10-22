// history:* のハンドラ登録（Issue #279 ステップ 3 で index.ts から分離）。
import { dialog } from "electron";

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
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../../shared/ipc.js";
import { handle, send } from "./helpers.js";
import { INVOKE_SCHEMAS } from "./schemas.js";

export function registerHistoryIpc(): void {
  handle(INVOKE_CHANNELS.historyDetect, INVOKE_SCHEMAS["history:detect"], detectHistorySources);
  handle(INVOKE_CHANNELS.historyPickFile, INVOKE_SCHEMAS["history:pick-file"], async () => {
    const options = {
      filters: [{ name: "AI エクスポート (JSON)", extensions: ["json"] }],
      properties: ["openFile" as const],
    };
    const result = appState.popup
      ? await dialog.showOpenDialog(appState.popup, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(
    INVOKE_CHANNELS.historyAnalyze,
    INVOKE_SCHEMAS["history:analyze"],
    async (event, request) =>
      analyzeHistory(request, (progress) => {
        send(event.sender, EVENT_CHANNELS.historyProgress, progress);
      }),
  );
  handle(
    INVOKE_CHANNELS.historyBuildPrompt,
    INVOKE_SCHEMAS["history:build-prompt"],
    buildImportPrompt,
  );
  handle(
    INVOKE_CHANNELS.historyPasteAnalysis,
    INVOKE_SCHEMAS["history:paste-analysis"],
    (_e, text) => pasteAnalysisIntoImport(text),
  );
  handle(INVOKE_CHANNELS.historyApply, INVOKE_SCHEMAS["history:apply"], async (_event, payload) =>
    applyImport(payload),
  );
  handle(INVOKE_CHANNELS.historyList, INVOKE_SCHEMAS["history:list"], () =>
    listImportSessions(apiDeps()),
  );
  handle(INVOKE_CHANNELS.historyUndo, INVOKE_SCHEMAS["history:undo"], (_event, id) =>
    undoImportSession(apiDeps(), id),
  );
  handle(
    INVOKE_CHANNELS.historyDeleteProvider,
    INVOKE_SCHEMAS["history:delete-provider"],
    (_event, provider) => deleteEvidenceByProvider(apiDeps(), provider),
  );
}
