/**
 * 下書きの保存（#249、migrations/0021_repo_maps.sql）。
 *
 * 他の Repository は repository/types.ts に置くが、リポジトリからのマップは自己完結した機能なので
 * ここに置く。D1 実装は `d1.ts`、インメモリ実装（テスト用）は `memory.ts`。
 */

export type DraftStatus = "fetched" | "summarized" | "candidates" | "failed";

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

  /** 持ち主の下書きを消す。無ければ false。 */
  delete(userId: string, id: string): Promise<boolean>;

  /** 期限切れを `limit` 件まで消す（全利用者）。消した件数を返す。 */
  deleteExpired(nowIso: string, limit: number): Promise<number>;
}
