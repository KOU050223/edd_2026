// 履歴インポートの実行フロー（Issue #157 / Issue #279 ステップ 3 で index.ts から分離）。
// Electron の API には consent-dialog 経由でだけ触れ、残りは history/ の純粋モジュールへ流す。
import { randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";

import {
  CONCEPTS,
  type AnalysisMode,
  type EvidenceImportedBy,
  type HistoryProviderId,
  type RawConversation,
} from "@gakushu-sochi/domain";

import { apiDeps } from "../api-deps.js";
import { ensureConsent } from "../consent-dialog.js";
import type {
  CreateImportSessionResult,
  HistoryAnalyzeRequest,
  HistoryApplyRequest,
  ImportAnalyzeView,
  ImportPreview,
  ImportProgress,
} from "../../shared/types.js";
import { createImportSession } from "./api.js";
import { parseExcludedConceptIds, prepareApplyEvidence } from "./apply.js";
import { createLocalRuleProvider } from "./local-rules.js";
import { mergePastedAnalysis, runImportPipeline } from "./pipeline.js";
import {
  CLI_SPECS,
  buildAnalysisPrompt,
  createCliAnalysisProvider,
  createManagedAnalysisProvider,
  createSpawnRunner,
  parseAnalysisOutput,
} from "./providers.js";
import { createAutoAdapters, createExportFileAdapter, type ScanFs } from "./sources.js";

/** fs.promises を Adapter の ScanFs 面へ合わせる。 */
const historyFs: ScanFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  readFile: (file) => readFile(file, "utf8"),
  stat: (file) => stat(file),
};

/** Managed AI へ回す分析の1回のインポートあたりの予算。 */
const IMPORT_BUDGET = { managedAiMaxCalls: 10 };

/**
 * 分析済みだが未適用の Import。renderer には本文を渡さないため、
 * prompt-copy fallback と apply の素材を main 側だけに保持する。
 * `analyze` ごとに上書きし、古い結果が後から適用されないようにする。
 */
interface PendingImport {
  preview: ImportPreview;
  pending: Map<HistoryProviderId, RawConversation[]>;
}
let pendingImport: PendingImport | undefined;

/** renderer へ返すプレビュー。evidence（概念IDのみ）と pending（本文）は落とす。 */
function previewForRenderer(preview: ImportPreview) {
  const { evidence, ...rest } = preview;
  return { ...rest, evidenceCount: evidence.length };
}

function buildAnalysisEntries() {
  const runner = createSpawnRunner();
  const deps = apiDeps();
  return [
    ...CLI_SPECS.map((spec) => ({
      provider: createCliAnalysisProvider(spec, runner),
      managed: false,
    })),
    {
      provider: createManagedAnalysisProvider({
        baseUrl: deps.baseUrl,
        getAccessToken: deps.getAccessToken,
        fetch,
      }),
      managed: true,
    },
  ];
}

export async function detectHistorySources() {
  const sources = [];
  for (const adapter of createAutoAdapters(historyFs)) {
    sources.push({ provider: adapter.provider, ...(await adapter.detect()) });
  }
  const analyzers = [];
  for (const entry of buildAnalysisEntries()) {
    analyzers.push({ id: entry.provider.id, available: await entry.provider.isAvailable() });
  }
  return { sources, analyzers };
}

export async function analyzeHistory(
  request: HistoryAnalyzeRequest,
  onProgress: (progress: ImportProgress) => void,
) {
  // 履歴本文が AI（CLI / Managed）へ出る経路なので、同意の記録があるときだけ走らせる。
  if (!(await ensureConsent())) {
    throw new Error("送信の同意が得られなかったため、インポートを中止しました。");
  }
  const adapters = createAutoAdapters(historyFs).filter((adapter) =>
    (request.providers ?? []).includes(adapter.provider),
  );
  if (request.filePath !== undefined && request.fileProvider !== undefined) {
    adapters.push(
      createExportFileAdapter(request.fileProvider, { fs: historyFs, filePath: request.filePath }),
    );
  }
  if (adapters.length === 0) {
    throw new Error("取り込む履歴ソースが選ばれていません。");
  }
  const mode: AnalysisMode = request.mode ?? "auto";
  const importedBy: EvidenceImportedBy = request.filePath === undefined ? "desktop" : "file";
  const run = await runImportPipeline({
    adapters,
    localProvider: createLocalRuleProvider(CONCEPTS),
    aiProviders: buildAnalysisEntries(),
    mode,
    budget: IMPORT_BUDGET,
    concepts: CONCEPTS,
    importedBy,
    sessionId: randomBytes(16).toString("base64url"),
    ...(request.sinceMs === undefined ? {} : { sinceMs: request.sinceMs }),
    onProgress,
  });
  pendingImport = { preview: run.preview, pending: run.pending };
  return {
    ...previewForRenderer(run.preview),
    pendingCount: [...run.pending.values()].reduce((sum, list) => sum + list.length, 0),
    canCopyPrompt: [...run.pending.values()].some((list) => list.length > 0),
  };
}

export function buildImportPrompt(): string {
  if (pendingImport === undefined) {
    throw new Error("先に履歴の分析を実行してください。");
  }
  // API の1回あたりの会話数上限と揃える（apps/api MAX_CONVERSATIONS_PER_ANALYSIS）。
  const conversations = [...pendingImport.pending.values()].flat().slice(0, 50);
  if (conversations.length === 0) {
    throw new Error("分析待ちの会話がありません。");
  }
  return buildAnalysisPrompt({
    conversations,
    knownConceptIds: CONCEPTS.map((concept) => concept.id),
  });
}

export function pasteAnalysisIntoImport(text: unknown): ImportAnalyzeView {
  if (pendingImport === undefined) {
    throw new Error("先に履歴の分析を実行してください。");
  }
  if (typeof text !== "string") throw new Error("分析結果のテキストを貼ってください。");
  const merged = mergePastedAnalysis({
    preview: pendingImport.preview,
    pending: pendingImport.pending,
    result: parseAnalysisOutput(text),
    concepts: CONCEPTS,
  });
  pendingImport = { preview: merged.preview, pending: merged.remaining };
  return {
    ...previewForRenderer(merged.preview),
    pendingCount: [...merged.remaining.values()].reduce((sum, list) => sum + list.length, 0),
    canCopyPrompt: [...merged.remaining.values()].some((list) => list.length > 0),
  };
}

export async function applyImport(
  payload: HistoryApplyRequest | undefined,
): Promise<CreateImportSessionResult> {
  if (pendingImport === undefined) {
    throw new Error("適用できる分析結果がありません。先に履歴の分析を実行してください。");
  }
  const evidence = prepareApplyEvidence(
    pendingImport.preview.evidence,
    parseExcludedConceptIds(payload),
  );
  const result = await createImportSession(apiDeps(), {
    id: pendingImport.preview.sessionId,
    importedBy: pendingImport.preview.importedBy,
    providers: pendingImport.preview.providers,
    conversationCount: pendingImport.preview.conversationCount,
    ignoredCount: pendingImport.preview.ignoredCount,
    // サーバー側の上限（apps/api MAX_UNMAPPED_CANDIDATES=200）と揃える。
    unmappedCandidates: pendingImport.preview.unmapped.slice(0, 200),
    evidence,
  });
  // 適用後に残しておくと、同じ preview の二重適用や stale な
  // prompt への貼り戻しが起きる。適用したら破棄する。
  pendingImport = undefined;
  return result;
}
