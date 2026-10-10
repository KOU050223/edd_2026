/**
 * 下書きの保存（#249、migrations/0021_repo_maps.sql）。
 *
 * 他の Repository は repository/types.ts に置くが、リポジトリからのマップは自己完結した機能なので
 * ここに置く。D1 実装は `d1.ts`、インメモリ実装（テスト用）は `memory.ts`。
 */

export type DraftStatus = "fetched" | "summarized" | "candidates" | "failed";
export type DraftStage = "fetch" | "summarize" | "candidates";

/** AI の呼び出し 1 回の記録。本文は持たない。 */
export interface AiCallRecord {
  stage: "summarize" | "select" | "candidates" | "tree" | "objectives";
  model: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
}

/** 取得したファイル・Issue の要約の保管（`repo_file_summaries`）。 */
export interface StoredSummary {
  repoOwner: string;
  repoName: string;
  /** ファイルの blob SHA。Issue は `issue:<番号>:<更新日時>`。 */
  blobSha: string;
  role: "glossary" | "doc" | "code" | "issue";
  bytesLimit: number;
  summary: string;
  model: string;
  promptVersion: number;
  createdAt: string;
}

/** 保存する下書き 1 件。段ごとの材料は `stageState`（JSON 文字列）。 */
export interface StoredRepoMapDraft {
  id: string;
  userId: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  commitSha: string;
  targetFolders: string[];
  hintFiles: string[];
  hintIssues: number[];
  status: DraftStatus;
  stageState: string;
  stageStateVersion: number;
  /** `failed` のときに、どの段から続けるか。 */
  failedStage: DraftStage | null;
  failureCode: string | null;
  /** この下書きで使った AI の呼び出しの合計。段ごとの内訳は `repo_map_ai_calls`。 */
  aiCalls: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface RepoMapUsage {
  monthlyDrafts: number;
  /** 日が変わっていれば 0。 */
  dailyRebuilds: number;
  monthlyTokens: number;
}

export interface RepoMapDraftRepository {
  /** 行が無ければ全て 0。 */
  usage(params: { userId: string; monthKey: string; dayKey: string }): Promise<RepoMapUsage>;

  /**
   * 月の枠を 1 つ確保する。確保できなければ加算しない（弾いた分まで枠を消費しない）。
   * 退会中なら例外（`ai_usage` の `reserve` と同じ守り方）。
   */
  reserveDraft(params: {
    userId: string;
    monthKey: string;
    dayKey: string;
    updatedAt: string;
    limit: number;
  }): Promise<{ reserved: boolean; usage: RepoMapUsage }>;

  /** 確保した枠を戻す。下書きの保存に失敗したときだけ使う。 */
  releaseDraft(params: { userId: string; monthKey: string; updatedAt: string }): Promise<void>;

  /** 下書きを保存する。退会中なら例外。 */
  create(draft: StoredRepoMapDraft): Promise<void>;

  /** 持ち主の下書き。期限切れも返す（読み手が判断する）。他人のものは null。 */
  get(userId: string, id: string): Promise<StoredRepoMapDraft | null>;

  /** 持ち主の下書きを、期限が切れていないものだけ新しい順に。 */
  list(userId: string, nowIso: string): Promise<StoredRepoMapDraft[]>;

  /** 段の結果を書く。持ち主の下書きでなければ false。 */
  update(
    userId: string,
    id: string,
    patch: {
      status: DraftStatus;
      stageState: string;
      stageStateVersion: number;
      failedStage: DraftStage | null;
      failureCode: string | null;
      updatedAt: string;
    },
  ): Promise<boolean>;

  /**
   * AI の呼び出しを記録する（呼び出しごとの行・下書きの合計・月のトークン）。
   * 確定・期限切れで下書きが消えても、呼び出しの行は残る。
   */
  recordAiCalls(params: {
    userId: string;
    draftId: string;
    monthKey: string;
    dayKey: string;
    updatedAt: string;
    calls: readonly AiCallRecord[];
  }): Promise<void>;

  /** 同じ (リポジトリ, プロンプトの版) で、`blobShas` に当たる要約。 */
  getSummaries(params: {
    repoOwner: string;
    repoName: string;
    promptVersion: number;
    blobShas: readonly string[];
  }): Promise<StoredSummary[]>;

  /** 要約をまとめて保管する（1 回の書き込み）。同じキーがあれば置き換える。 */
  putSummaries(summaries: readonly StoredSummary[]): Promise<void>;

  /** 持ち主の下書きを消す。無ければ false。 */
  delete(userId: string, id: string): Promise<boolean>;

  /** 期限切れを `limit` 件まで消す（全利用者）。消した件数を返す。 */
  deleteExpired(nowIso: string, limit: number): Promise<number>;
}
