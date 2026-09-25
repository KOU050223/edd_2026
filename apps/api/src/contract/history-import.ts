/**
 * 外部 AI 履歴からの学習引き継ぎ（Issue #157）の外部契約。
 *
 * - `POST /v1/import-sessions`: 正規化済みの Evidence を Import Session として保存する。
 * - `GET /v1/import-sessions` / `GET /v1/import-sessions/:id`: 一覧と詳細。
 * - `DELETE /v1/import-sessions/:id`: Undo。Evidence を消し Session を undone にする。
 * - `GET /v1/learning-evidence` / `GET /v1/learning-evidence:export`:
 *   「なぜこの状態か」の出典表示とエクスポート。
 * - `DELETE /v1/learning-evidence?provider=...`: ソース単位の削除。
 * - `POST /v1/ai/history-analysis`: Managed AI による履歴分析。既存の
 *   Managed AI 利用枠（contract/ai-usage.ts）を共有する。
 *
 * 契約はこのアプリに置く（apps/api/AGENTS.md）。packages/domain の型は
 * 利用してよいが、この型を他パッケージから参照させない。
 */

import * as v from "valibot";
import {
  CONCEPT_ID_PATTERN,
  isIsoDateTime,
  type EvidenceImportedBy,
  type EvidenceKind,
  type HistoryProviderId,
  type LearningEvidence,
  type UnmappedCandidate,
} from "@gakushu-sochi/domain";

/**
 * 受け入れる履歴ソース・経路・種別。packages/domain の対応する型と一致させる。
 * learning-event.ts と同じく、ズレたらコンパイルが止まるよう両方向の検査を置く。
 */
const HISTORY_PROVIDERS = [
  "codex",
  "chatgpt",
  "claude-code",
  "claude",
  "copilot",
  "cursor",
  "gemini",
  "vscode",
] as const;

const IMPORTED_BY = ["desktop", "agent", "file", "connector"] as const;

const EVIDENCE_KINDS = [
  "question",
  "debugging",
  "explanation",
  "implementation",
  "verification",
] as const;

function assertNever<T extends never>(): void {
  void 0 as T | void;
}

assertNever<Exclude<HistoryProviderId, (typeof HISTORY_PROVIDERS)[number]>>();
assertNever<Exclude<(typeof HISTORY_PROVIDERS)[number], HistoryProviderId>>();
assertNever<Exclude<EvidenceImportedBy, (typeof IMPORTED_BY)[number]>>();
assertNever<Exclude<(typeof IMPORTED_BY)[number], EvidenceImportedBy>>();
assertNever<Exclude<EvidenceKind, (typeof EVIDENCE_KINDS)[number]>>();
assertNever<Exclude<(typeof EVIDENCE_KINDS)[number], EvidenceKind>>();

const MAX_ID_LENGTH = 128;
/** Evidence ID は `${sessionId}:${provider}:${sourceId}` の連結なので長めに取る。 */
const MAX_EVIDENCE_ID_LENGTH = 512;
/** 1回の Import で受け付ける Evidence の上限。 */
export const MAX_EVIDENCE_PER_IMPORT = 5_000;
/** 1回の分析リクエストで受け付ける会話の上限。 */
export const MAX_CONVERSATIONS_PER_ANALYSIS = 50;
/** 1会話あたりの本文の上限。クライアント側でも切り詰めるが、サーバーでも受けない。 */
export const MAX_CONVERSATION_BODY_LENGTH = 8_000;
/** unmapped 候補の保存上限。Ignored の内訳として必要な分だけ残す。 */
export const MAX_UNMAPPED_CANDIDATES = 200;

const isoDateTimeSchema = v.pipe(
  v.string(),
  v.check(isIsoDateTime, "must be an ISO 8601 date-time with a UTC or numeric offset"),
);

const conceptIdSchema = v.pipe(
  v.string(),
  v.regex(CONCEPT_ID_PATTERN, "conceptId must match <prefix>.<concept>"),
);

/**
 * 正規化済みの LearningEvidence。
 *
 * `v.strictObject` にするのは learning-event.ts と同じ理由である。
 * Evidence に会話本文を置く場所は無く、クライアントが本文を送ってきた
 * 場合は剥がして受理するのではなく拒否する。
 */
export const learningEvidenceSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_EVIDENCE_ID_LENGTH)),
  // Concept の無い Evidence は Map に載らず判断材料にならないため受けない。
  conceptIds: v.pipe(v.array(conceptIdSchema), v.minLength(1), v.maxLength(16)),
  source: v.strictObject({
    provider: v.picklist(HISTORY_PROVIDERS),
    importedBy: v.picklist(IMPORTED_BY),
  }),
  kind: v.picklist(EVIDENCE_KINDS),
  observedAt: v.optional(isoDateTimeSchema),
  // NaN は 0〜1 の検査を素通りするため finite も要求する。
  confidence: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  importSessionId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LENGTH))),
  externalRefHash: v.optional(v.pipe(v.string(), v.maxLength(MAX_ID_LENGTH))),
});

export type LearningEvidenceInput = v.InferOutput<typeof learningEvidenceSchema>;

/**
 * `POST /v1/import-sessions` のリクエスト。
 *
 * `id` はクライアントが採番する。Normalizer が Evidence の ID に
 * 埋め込むため、サーバー側で採番すると Evidence 側と辻褄が合わない。
 * 冪等性（同じ `id` の再送を重複作成しない）もこの ID で担保する。
 */
export const createImportSessionSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LENGTH)),
  importedBy: v.picklist(IMPORTED_BY),
  providers: v.pipe(v.array(v.picklist(HISTORY_PROVIDERS)), v.minLength(1), v.maxLength(16)),
  conversationCount: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000)),
  ignoredCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  unmappedCandidates: v.optional(
    v.array(
      v.strictObject({
        sourceId: v.pipe(v.string(), v.maxLength(MAX_EVIDENCE_ID_LENGTH)),
        candidate: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      }),
    ),
  ),
  evidence: v.pipe(v.array(learningEvidenceSchema), v.maxLength(MAX_EVIDENCE_PER_IMPORT)),
});

export type CreateImportSessionRequest = v.InferOutput<typeof createImportSessionSchema>;

/** 一覧に返す Import Session の要約。 */
export interface ImportSessionView {
  id: string;
  status: string;
  importedBy: EvidenceImportedBy;
  providers: HistoryProviderId[];
  conversationCount: number;
  ignoredCount: number;
  evidenceCount: number;
  conceptCount: number;
  createdAt: string;
  updatedAt: string;
}

/** `GET /v1/import-sessions/:id` の詳細。Evidence を含めて返す。 */
export interface ImportSessionDetail extends ImportSessionView {
  evidence: LearningEvidence[];
  unmappedCandidates: UnmappedCandidate[];
}

export interface CreateImportSessionResponse extends ImportSessionView {
  /** 同じ ID で再送された場合に true。2回目以降は何も書き足さない。 */
  alreadyExisted: boolean;
}

/** `DELETE /v1/import-sessions/:id` の応答。 */
export interface UndoImportSessionResponse {
  id: string;
  status: "undone";
  /** この Undo で消した Evidence の件数。既に undone なら 0。 */
  deletedEvidenceCount: number;
}

/** `GET /v1/learning-evidence` の応答。 */
export interface ListLearningEvidenceResponse {
  evidence: LearningEvidence[];
}

/** `DELETE /v1/learning-evidence?provider=...` の応答。 */
export interface DeleteLearningEvidenceResponse {
  deletedCount: number;
  /** Evidence が残らなくなり undone に倒れた Session の件数。 */
  sessionsMarkedUndone: number;
}

/** `GET /v1/learning-evidence:export` の応答。 */
export interface LearningEvidenceExport {
  version: 1;
  exportedAt: string;
  sessions: ImportSessionView[];
  evidence: LearningEvidence[];
}

// ---------------------------------------------------------------------------
// Managed AI による履歴分析（POST /v1/ai/history-analysis）
// ---------------------------------------------------------------------------

/**
 * 分析に渡す会話。RawConversation と同じ形だが、HTTP 境界のスキーマとして
 * 個別に定義する。本文は前処理済み（個人情報・パス除去、長さ上限）のものを
 * 受け、サーバーは保存しない。上流への送信が終われば破棄される。
 */
export const analysisConversationSchema = v.strictObject({
  sourceId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_EVIDENCE_ID_LENGTH)),
  observedAt: v.optional(isoDateTimeSchema),
  title: v.optional(v.pipe(v.string(), v.maxLength(500))),
  body: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_CONVERSATION_BODY_LENGTH)),
  externalRefHash: v.optional(v.pipe(v.string(), v.maxLength(MAX_ID_LENGTH))),
});

export const historyAnalysisRequestSchema = v.strictObject({
  conversations: v.pipe(
    v.array(analysisConversationSchema),
    v.minLength(1),
    v.maxLength(MAX_CONVERSATIONS_PER_ANALYSIS),
  ),
  knownConceptIds: v.pipe(v.array(conceptIdSchema), v.maxLength(2_000)),
});

export type HistoryAnalysisRequest = v.InferOutput<typeof historyAnalysisRequestSchema>;

/**
 * 上流の AI が返した1件の観測。構造が合わない要素は棄却し、
 * `droppedObservations` で件数を応答へ返す（RULE-004。黙って捨てない）。
 */
export const historyObservationSchema = v.strictObject({
  sourceId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_EVIDENCE_ID_LENGTH)),
  conceptCandidates: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  kind: v.picklist(EVIDENCE_KINDS),
  observedAt: v.optional(isoDateTimeSchema),
  confidence: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  externalRefHash: v.optional(v.pipe(v.string(), v.maxLength(MAX_ID_LENGTH))),
});

/** `POST /v1/ai/history-analysis` の応答。 */
export interface HistoryAnalysisResponse {
  observations: v.InferOutput<typeof historyObservationSchema>[];
  /** 構造の合わなかった観測を落とした件数。0 なら省略しない。 */
  droppedObservations: number;
}
