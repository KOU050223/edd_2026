// IPC を越えてやり取りする DTO の型（Issue #279 ステップ 3）。
// main 側の実装型を shared が import すると、renderer 用の型検査が
// Node の世界（history/providers → node:child_process）まで入り込むため、
// IPC に載る型はここを正本にする。main 側はここから import する。
//
// **このファイルは electron も Node も import しない**（renderer からも読むため）。
// 許される import は `@gakushu-sochi/domain` の型と `src/shared` 内だけ
// （eslint.config.mjs の no-restricted-imports で強制）。
import type {
  AnalysisMode,
  ConceptFamiliarity,
  ConceptId,
  EvidenceImportedBy,
  HistoryProviderId,
  HistorySourceDetection,
  LearningEvidence,
  RejectedObservation,
  UnmappedCandidate,
} from "@gakushu-sochi/domain";

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

// persona の上限は domain が正本（PERSONA_MAX_LENGTH）。ここを緩めると、
// 保存できるのに送信すると必ず 400 で弾かれる設定を利用者に作らせることになる。
export interface DesktopSettings {
  apiBaseUrl: string;
  shortcut: string;
  model: string;
  temperature: number;
  maxTokens: number;
  restoreClipboard: boolean;
  launchAtLogin: boolean;
  /** 応答の人物像・口調（自由記述）。空文字は未設定。 */
  persona: string;
  /**
   * 「質問履歴の保存」オプトインのローカルキャッシュ（Issue #204）。
   *
   * 正はサーバーの `user_settings.saveConversationHistory`。本文を送る前の
   * プリチェックに使うだけで、キャッシュが true でもサーバー側が無効なら
   * `PUT /v1/conversations` は 403 で拒否される（docs/conversation-history.md）。
   * ここが true に偽装されても本文の保存は増えず、古い true のまま残ると
   * 無意味な送信が毎回失敗するため、403 が返ったら false へ戻す。
   */
  saveConversationHistory: boolean;
}

/** `settings:get` が返す形。ローカル設定＋トークン保持の有無。 */
export interface SettingsState extends DesktopSettings {
  hasRefreshToken: boolean;
}

/** `consent:*` が返す形。`grantedAt` は未同意なら undefined。 */
export interface ConsentStatus {
  granted: boolean;
  grantedAt: string | undefined;
}

/** 「質問履歴の保存」オプトインの形（Issue #204）。サーバーの値が正。 */
export interface ConversationHistoryOptIn {
  saveConversationHistory: boolean;
}

// ---------------------------------------------------------------------------
// 質問履歴（Issue #199）
// ---------------------------------------------------------------------------

/**
 * `GET /v1/conversations` の応答要素
 * （apps/api/src/contract/conversations.ts の `ConversationSummary` と対応）。
 * 本文（`messages`）は一覧には含まれない。
 */
export interface ConversationSummary {
  id: string;
  origin: string;
  clientId?: string;
  title?: string;
  language?: string;
  fileName?: string;
  occurredAt: string;
  updatedAt: string;
  messageCount: number;
  complete: boolean;
}

export interface ListConversationsResult {
  conversations: ConversationSummary[];
  /** 末尾まで読んだら `null`。 */
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// 履歴インポート（Issue #157）
// ---------------------------------------------------------------------------

/** `history:analyze` の引数（Issue #157）。 */
export interface HistoryAnalyzeRequest {
  providers?: HistoryProviderId[];
  filePath?: string;
  fileProvider?: HistoryProviderId;
  mode?: AnalysisMode;
  sinceMs?: number;
}

/** `history:apply` の引数。 */
export interface HistoryApplyRequest {
  excludeConceptIds?: unknown;
}

export interface ImportSessionView {
  id: string;
  status: string;
  importedBy: string;
  providers: HistoryProviderId[];
  conversationCount: number;
  ignoredCount: number;
  evidenceCount: number;
  conceptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateImportSessionResult extends ImportSessionView {
  alreadyExisted: boolean;
}

/** 前処理で除去したものの種類。UI 上の「除去: N件」表示や監査のために種類名だけを数える。 */
export type SanitizedKind = "email" | "token" | "local-path" | "truncated";

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

/** renderer へ返す分析プレビュー。evidence（概念IDのみ）と pending（本文）は渡さない。 */
export type ImportPreviewView = Omit<ImportPreview, "evidence"> & { evidenceCount: number };

/** `history:analyze` / `history:paste-analysis` が返す形。 */
export interface ImportAnalyzeView extends ImportPreviewView {
  /** AI 分析へ回す素材が残っている会話数。 */
  pendingCount: number;
  /** プロンプトをコピーする導線を出せるか。 */
  canCopyPrompt: boolean;
}

/** `history:detect` が返す形。 */
export interface HistoryDetectResult {
  sources: ({ provider: HistoryProviderId } & HistorySourceDetection)[];
  analyzers: { id: string; available: boolean }[];
}

// ---------------------------------------------------------------------------
// イベント系（main → renderer）の payload
// ---------------------------------------------------------------------------

export interface SelectionEvent {
  selection: string;
  error?: string;
}

export interface AuthState {
  hasRefreshToken: boolean;
}
