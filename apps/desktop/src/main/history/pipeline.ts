import {
  deriveFamiliarityFromEvidence,
  isProbablyProgrammingRelated,
  normalizeAnalysisResult,
  type AnalysisBudget,
  type AnalysisMode,
  type AnalysisProvider,
  type AnalysisProviderEntry,
  type Concept,
  type ConceptFamiliarity,
  type ConceptId,
  type EvidenceImportedBy,
  type HistoryAnalysisResult,
  type HistoryObservation,
  type HistoryProviderId,
  type HistorySourceAdapter,
  type LearningEvidence,
  type RawConversation,
  type RejectedObservation,
  type UnmappedCandidate,
} from "@gakushu-sochi/domain";

import { AnalysisProviderError } from "./providers.js";
import { conversationDigest, sanitizeConversation, type SanitizedKind } from "./preprocess.js";

/**
 * 履歴インポートの実行パイプライン（Issue #157）。
 *
 * scan → 前処理 → ローカルルール → （必要なら）AI → Normalizer の順に流す。
 * Electron や HTTP に依存せず、全ての依存を引数で受け取るためテストできる。
 *
 * 「正確に分類できなくても続行」が Issue の方針なので、AI の失敗は
 * ここで潰さず warnings へ載せて次へ進む。ただしスキャン自体の失敗や
 * 応答が空になるような致命的な失敗は呼び出し側へ投げる。
 */

/** 1回の AI 分析に渡す会話数。API の MAX_CONVERSATIONS_PER_ANALYSIS と揃える。 */
const CONVERSATIONS_PER_ANALYSIS = 50;
/** 1回のインポートで読む会話の上限。メモリと予算の両方を守る上限。 */
const MAX_CONVERSATIONS_PER_IMPORT = 10_000;

export interface ImportProgress {
  phase: "scanning" | "analyzing" | "normalizing";
  /** 現在スキャン/分析しているソース。 */
  provider?: HistoryProviderId;
  /** AI 分析に使っている Provider の ID（aiProviders 段階のみ）。 */
  analyzerId?: string;
  scannedCount: number;
  /** AI 分析が終わった会話数。 */
  analyzedCount: number;
  totalCount: number;
}

export interface ConceptSummary {
  conceptId: ConceptId;
  label: string;
  count: number;
}

export interface ImportPreview {
  sessionId: string;
  importedBy: EvidenceImportedBy;
  providers: HistoryProviderId[];
  /** 前処理を通過した会話数。 */
  conversationCount: number;
  /** 重複として除いた会話数。 */
  duplicateCount: number;
  /** プログラミング関連と判断されず落とした会話数。 */
  ignoredCount: number;
  /** 前処理で除去したものの種類ごとの件数（email/token/local-path/truncated）。 */
  sanitized: Partial<Record<SanitizedKind, number>>;
  /** ローカルルールで分類できた会話数。 */
  localCoveredCount: number;
  /** AI 分析までたどり着けなかった会話数。 */
  unanalyzedCount: number;
  evidence: LearningEvidence[];
  familiarity: Record<ConceptId, ConceptFamiliarity | undefined>;
  /** 観測数の多い順の Concept 要約（プレビュー用）。 */
  conceptSummaries: ConceptSummary[];
  unmapped: UnmappedCandidate[];
  rejected: RejectedObservation[];
  warnings: string[];
  /** 実際に分析した Provider の ID（出現順）。 */
  analyzersUsed: string[];
  managedCallsUsed: number;
}

export interface ImportRun {
  preview: ImportPreview;
  /**
   * AI 分析に回せなかった（Provider が選べなかった / 予算切れ）会話。
   * prompt-copy fallback で再利用するため保持する。
   * 会話本文を含むため renderer へは送らない。
   */
  pending: Map<HistoryProviderId, RawConversation[]>;
}

export interface ImportPipelineOptions {
  adapters: readonly HistorySourceAdapter[];
  /** 常に使える第一候補（local-rules）。 */
  localProvider: AnalysisProvider;
  /** AI の候補を優先度順に。local は含めない。 */
  aiProviders: readonly AnalysisProviderEntry[];
  mode: AnalysisMode;
  budget: AnalysisBudget;
  concepts: readonly Concept[];
  importedBy: EvidenceImportedBy;
  sessionId: string;
  /** 増分スキャンの起点。前回取り込んだ時刻を渡す。 */
  sinceMs?: number;
  onProgress?: (progress: ImportProgress) => void;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

export async function runImportPipeline(options: ImportPipelineOptions): Promise<ImportRun> {
  const warnings: string[] = [];
  const sanitizedCount: Partial<Record<SanitizedKind, number>> = {};
  const onWarning = (warning: string) => warnings.push(warning);

  // --- scan -------------------------------------------------------------
  const conversationsByProvider = new Map<HistoryProviderId, RawConversation[]>();
  for (const adapter of options.adapters) {
    const conversations: RawConversation[] = [];
    try {
      for await (const conversation of adapter.scan({
        ...(options.sinceMs === undefined ? {} : { sinceMs: options.sinceMs }),
        onWarning,
      })) {
        if (conversations.length >= MAX_CONVERSATIONS_PER_IMPORT) {
          warnings.push(
            `${adapter.provider}: 会話数の上限 ${String(MAX_CONVERSATIONS_PER_IMPORT)} に達したため残りを読み飛ばしました。`,
          );
          break;
        }
        conversations.push(conversation);
      }
    } catch (error) {
      // 1ソースのスキャン失敗で全体を止めないが、黙らず警告に残す。
      warnings.push(
        `${adapter.provider}: 履歴のスキャンに失敗しました: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    if (conversations.length > 0) conversationsByProvider.set(adapter.provider, conversations);
    options.onProgress?.({
      phase: "scanning",
      provider: adapter.provider,
      scannedCount: conversations.length,
      analyzedCount: 0,
      totalCount: conversations.length,
    });
  }

  // --- preprocess ---------------------------------------------------------
  const cleanedByProvider = new Map<HistoryProviderId, RawConversation[]>();
  let duplicateCount = 0;
  let ignoredCount = 0;
  // 同一本文はソースをまたいで重複とみなす（エクスポートと CLI 履歴に
  // 同じ会話が残るケース）。
  const seenDigests = new Set<string>();
  for (const [provider, conversations] of conversationsByProvider) {
    const cleaned: RawConversation[] = [];
    for (const raw of conversations) {
      const { conversation, removedKinds } = sanitizeConversation(raw);
      for (const kind of removedKinds) {
        sanitizedCount[kind] = (sanitizedCount[kind] ?? 0) + 1;
      }
      if (!isProbablyProgrammingRelated(conversation.body)) {
        ignoredCount += 1;
        continue;
      }
      const digest = conversationDigest(conversation);
      if (seenDigests.has(digest)) {
        duplicateCount += 1;
        continue;
      }
      seenDigests.add(digest);
      cleaned.push(conversation);
    }
    cleanedByProvider.set(provider, cleaned);
  }

  const knownConceptIds = options.concepts.map((concept) => concept.id);

  // --- local rules ---------------------------------------------------------
  // ローカルルールは全件を見る。Concept が1つも当たらなかった会話だけを
  // AI 分析へ回す（Issue #157「ローカルで行う処理」）。
  const localEvidence: LearningEvidence[] = [];
  const localUnmapped: UnmappedCandidate[] = [];
  const localRejected: RejectedObservation[] = [];
  const unresolved = new Map<HistoryProviderId, RawConversation[]>();
  let localCoveredCount = 0;

  for (const [provider, conversations] of cleanedByProvider) {
    const localResult = await options.localProvider.analyze({
      conversations,
      knownConceptIds,
    });
    const normalized = normalizeAnalysisResult(localResult, {
      provider,
      importedBy: options.importedBy,
      importSessionId: options.sessionId,
      concepts: options.concepts,
    });
    localEvidence.push(...normalized.evidence);
    localUnmapped.push(...normalized.unmapped);
    localRejected.push(...normalized.rejected);
    // Evidence ID は `${sessionId}:${provider}:${sourceId}`。sourceId 側に
    // ':' が含まれても prefix だけを削れば元に戻る。
    const prefix = `${options.sessionId}:${provider}:`;
    const covered = new Set(normalized.evidence.map((item) => item.id.slice(prefix.length)));
    localCoveredCount += covered.size;
    const remaining = conversations.filter((conversation) => !covered.has(conversation.sourceId));
    if (remaining.length > 0) unresolved.set(provider, remaining);
  }

  // --- AI analysis ----------------------------------------------------------
  const aiEvidence: LearningEvidence[] = [];
  const aiUnmapped: UnmappedCandidate[] = [];
  const aiRejected: RejectedObservation[] = [];
  const analyzersUsed: string[] = [];
  let managedCallsUsed = 0;
  let unanalyzedCount = 0;
  const pending = new Map<HistoryProviderId, RawConversation[]>();
  const totalUnresolved = [...unresolved.values()].reduce((sum, list) => sum + list.length, 0);
  let analyzedCount = 0;

  if (totalUnresolved > 0) {
    // 予算の残りだけ AI を使う。超えた分は unanalyzed として残し、
    // 黙って Managed へ倒さない（Issue #157 / RULE-004）。
    // mode の絞り込み（user-ai では Managed を除く等）は
    // analyzeWithProviders が行う。
    for (const [provider, conversations] of unresolved) {
      const chunks = chunk(conversations, CONVERSATIONS_PER_ANALYSIS);
      for (const conversationsChunk of chunks) {
        const attempt = await analyzeWithProviders(
          options.aiProviders,
          options.mode,
          managedCallsUsed,
          options.budget,
          { conversations: conversationsChunk, knownConceptIds },
          warnings,
        );
        managedCallsUsed += attempt.managedAttempts;
        const result = attempt.result;
        if (result === undefined) {
          unanalyzedCount += conversationsChunk.length;
          const list = pending.get(provider) ?? [];
          pending.set(provider, [...list, ...conversationsChunk]);
          continue;
        }
        analyzedCount += conversationsChunk.length;
        if (!analyzersUsed.includes(result.providerId)) analyzersUsed.push(result.providerId);
        const normalized = normalizeAnalysisResult(result.result, {
          provider,
          importedBy: options.importedBy,
          importSessionId: options.sessionId,
          concepts: options.concepts,
        });
        aiEvidence.push(...normalized.evidence);
        aiUnmapped.push(...normalized.unmapped);
        aiRejected.push(...normalized.rejected);
        if (
          result.result.droppedObservations !== undefined &&
          result.result.droppedObservations > 0
        ) {
          warnings.push(
            `${result.providerId}: 構造の合わない観測を ${String(result.result.droppedObservations)} 件落としました。`,
          );
        }
        options.onProgress?.({
          phase: "analyzing",
          provider,
          analyzerId: result.providerId,
          scannedCount: conversations.length,
          analyzedCount,
          totalCount: totalUnresolved,
        });
      }
    }
  }

  const evidence = [...localEvidence, ...aiEvidence];
  const familiarity = deriveFamiliarityFromEvidence(evidence);
  const conceptSummaries = Object.values(familiarity)
    .filter((entry): entry is ConceptFamiliarity => entry !== undefined)
    .map((entry) => ({
      conceptId: entry.conceptId,
      label:
        options.concepts.find((concept) => concept.id === entry.conceptId)?.label ??
        entry.conceptId,
      count: entry.observationCount,
    }))
    .sort((a, b) => b.count - a.count || (a.conceptId < b.conceptId ? -1 : 1));

  return {
    preview: {
      sessionId: options.sessionId,
      importedBy: options.importedBy,
      providers: [...conversationsByProvider.keys()],
      // 前処理（除去・重複排除・関連性フィルタ）を通過した会話数。
      conversationCount: [...cleanedByProvider.values()].reduce(
        (sum, list) => sum + list.length,
        0,
      ),
      duplicateCount,
      ignoredCount,
      sanitized: sanitizedCount,
      localCoveredCount,
      unanalyzedCount,
      evidence,
      familiarity,
      conceptSummaries,
      unmapped: [...localUnmapped, ...aiUnmapped],
      rejected: [...localRejected, ...aiRejected],
      warnings,
      analyzersUsed,
      managedCallsUsed,
    },
    pending,
  };
}

/**
 * prompt-copy fallback で貼り戻された分析結果を、pending の会話へ
 * 適用して preview を更新する。
 *
 * sourceId から provider を特定して Normalizer に渡す。一覧に無い
 * sourceId は unmapped ではなく rejected 扱いにする（別 Import の
 * 結果を取り込まないため）。
 */
export function mergePastedAnalysis(options: {
  preview: ImportPreview;
  pending: Map<HistoryProviderId, RawConversation[]>;
  result: HistoryAnalysisResult;
  concepts: readonly Concept[];
}): { preview: ImportPreview; remaining: Map<HistoryProviderId, RawConversation[]> } {
  const providerBySourceId = new Map<string, HistoryProviderId>();
  for (const [provider, conversations] of options.pending) {
    for (const conversation of conversations)
      providerBySourceId.set(conversation.sourceId, provider);
  }

  const byProvider = new Map<HistoryProviderId, HistoryObservation[]>();
  const foreign: string[] = [];
  for (const observation of options.result.observations) {
    const provider = providerBySourceId.get(observation.sourceId);
    if (provider === undefined) {
      foreign.push(observation.sourceId);
      continue;
    }
    const list = byProvider.get(provider) ?? [];
    byProvider.set(provider, [...list, observation]);
  }

  const evidence = [...options.preview.evidence];
  const unmapped = [...options.preview.unmapped];
  const rejected = [...options.preview.rejected];
  const consumed = new Set<string>();
  for (const [provider, observations] of byProvider) {
    const normalized = normalizeAnalysisResult(
      { observations },
      {
        provider,
        importedBy: options.preview.importedBy,
        importSessionId: options.preview.sessionId,
        concepts: options.concepts,
      },
    );
    evidence.push(...normalized.evidence);
    unmapped.push(...normalized.unmapped);
    rejected.push(...normalized.rejected);
    const prefix = `${options.preview.sessionId}:${provider}:`;
    for (const item of normalized.evidence) consumed.add(item.id.slice(prefix.length));
  }

  const remaining = new Map<HistoryProviderId, RawConversation[]>();
  for (const [provider, conversations] of options.pending) {
    const rest = conversations.filter(
      (conversation) =>
        !consumed.has(conversation.sourceId) &&
        !observationsCovered(byProvider.get(provider), conversation.sourceId),
    );
    if (rest.length > 0) remaining.set(provider, rest);
  }

  const familiarity = deriveFamiliarityFromEvidence(evidence);
  const conceptSummaries = Object.values(familiarity)
    .filter((entry): entry is ConceptFamiliarity => entry !== undefined)
    .map((entry) => ({
      conceptId: entry.conceptId,
      label:
        options.concepts.find((concept) => concept.id === entry.conceptId)?.label ??
        entry.conceptId,
      count: entry.observationCount,
    }))
    .sort((a, b) => b.count - a.count || (a.conceptId < b.conceptId ? -1 : 1));

  const warnings = [...options.preview.warnings];
  if (foreign.length > 0) {
    warnings.push(
      `この Import に属さない sourceId の観測を ${String(foreign.length)} 件捨てました。`,
    );
  }

  return {
    preview: {
      ...options.preview,
      evidence,
      familiarity,
      conceptSummaries,
      unmapped,
      rejected,
      warnings,
      // unanalyzedCount は「会話の件数」。Evidence の件数と混ぜると
      // 単位が合わないため、残った会話から直接数える。
      unanalyzedCount: [...remaining.values()].reduce((sum, list) => sum + list.length, 0),
    },
    remaining,
  };
}

function observationsCovered(
  observations: readonly HistoryObservation[] | undefined,
  sourceId: string,
): boolean {
  return observations?.some((observation) => observation.sourceId === sourceId) ?? false;
}

interface AnalyzeAttemptResult {
  providerId: string;
  result: Awaited<ReturnType<AnalysisProvider["analyze"]>>;
}

interface AnalyzeOutcome {
  /** 成功した Provider の結果。全滅なら undefined。 */
  result?: AnalyzeAttemptResult;
  /**
   * Managed を呼び出した回数。失敗した呼び出しもサーバー側の
   * 利用量枠を消費しうるため、成否にかかわらず数える。
   */
  managedAttempts: number;
}

/**
 * 候補の AI Provider を順に試す。
 *
 * Provider が unavailable / 実行失敗 / rate_limited なら次へ進む。
 * Managed は予算が残るときだけ使う。全滅なら result は undefined で、
 * 呼び出し側が unanalyzed として数える。
 */
async function analyzeWithProviders(
  entries: readonly AnalysisProviderEntry[],
  mode: AnalysisMode,
  managedCallsUsed: number,
  budget: AnalysisBudget,
  input: Parameters<AnalysisProvider["analyze"]>[0],
  warnings: string[],
): Promise<AnalyzeOutcome> {
  let managedAttempts = 0;
  for (const entry of entries) {
    if (mode === "user-ai" && entry.managed) continue;
    if (mode === "managed" && !entry.managed) continue;
    if (entry.managed && managedCallsUsed + managedAttempts >= budget.managedAiMaxCalls) continue;
    if (!(await entry.provider.isAvailable())) continue;
    // 試行の時点で消費とみなす。失敗しても枠を戻せないため。
    if (entry.managed) managedAttempts += 1;
    try {
      const result = await entry.provider.analyze(input);
      return { result: { providerId: entry.provider.id, result }, managedAttempts };
    } catch (error) {
      // 1 Provider の失敗でインポート全体を止めない。ただし警告に残す。
      const detail =
        error instanceof AnalysisProviderError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      warnings.push(`${entry.provider.id}: 分析に失敗しました: ${detail}`);
      continue;
    }
  }
  return { managedAttempts };
}
