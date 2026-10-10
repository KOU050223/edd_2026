/**
 * `RepoMapDraftRepository` の D1 実装（#249、migrations/0021_repo_maps.sql）。
 *
 * 月の枠は `ai_usage`（repository/d1.ts の `D1AiUsageRepository`）と同じく、判定と加算を 1 文で行う。
 * 読んでから別の文で足すと、同じ利用者の同時リクエストが隙間に割り込み、枠を超えて作れてしまう。
 */

import { ACCOUNT_DELETION_TOMBSTONE_TTL_MS } from "../repository/types.js";
import type {
  DraftStatus,
  RepoMapDraftRepository,
  RepoMapUsage,
  StoredRepoMapDraft,
} from "./repository.js";

interface UsageRow {
  day_key: string;
  monthly_drafts: number;
  daily_rebuilds: number;
  monthly_tokens: number;
}

interface DraftRow {
  id: string;
  user_id: string;
  repo_owner: string;
  repo_name: string;
  default_branch: string;
  commit_sha: string;
  target_folders: string;
  hint_files: string;
  hint_issues: string;
  status: DraftStatus;
  stage_state: string;
  stage_state_version: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

const DRAFT_COLUMNS = `id, user_id, repo_owner, repo_name, default_branch, commit_sha,
  target_folders, hint_files, hint_issues, status, stage_state, stage_state_version,
  created_at, updated_at, expires_at`;

function toUsage(row: UsageRow | null, dayKey: string): RepoMapUsage {
  if (row === null) return { monthlyDrafts: 0, dailyRebuilds: 0, monthlyTokens: 0 };
  return {
    monthlyDrafts: row.monthly_drafts,
    // 行が持つ日次は day_key の日のもの。日が変わっていれば数え直す。
    dailyRebuilds: row.day_key === dayKey ? row.daily_rebuilds : 0,
    monthlyTokens: row.monthly_tokens,
  };
}

/** 保存した JSON 配列を読む。壊れていたら例外（黙って空にしない）。 */
function parseArray<T>(text: string, what: string): T[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`repo_map_drafts.${what} is not valid JSON`);
  }
  if (!Array.isArray(value)) throw new Error(`repo_map_drafts.${what} is not an array`);
  return value as T[];
}

function toDraft(row: DraftRow): StoredRepoMapDraft {
  return {
    id: row.id,
    userId: row.user_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    defaultBranch: row.default_branch,
    commitSha: row.commit_sha,
    targetFolders: parseArray<string>(row.target_folders, "target_folders"),
    hintFiles: parseArray<string>(row.hint_files, "hint_files"),
    hintIssues: parseArray<number>(row.hint_issues, "hint_issues"),
    status: row.status,
    stageState: row.stage_state,
    stageStateVersion: row.stage_state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export class D1RepoMapDraftRepository implements RepoMapDraftRepository {
  constructor(private readonly db: D1Database) {}

  async usage(params: { userId: string; monthKey: string; dayKey: string }): Promise<RepoMapUsage> {
    const row = await this.db
      .prepare(
        `SELECT day_key, monthly_drafts, daily_rebuilds, monthly_tokens
         FROM repo_map_usage WHERE user_id = ? AND month_key = ?`,
      )
      .bind(params.userId, params.monthKey)
      .first<UsageRow>();
    return toUsage(row, params.dayKey);
  }

  async reserveDraft(params: {
    userId: string;
    monthKey: string;
    dayKey: string;
    updatedAt: string;
    limit: number;
  }): Promise<{ reserved: boolean; usage: RepoMapUsage }> {
    const { userId, monthKey, dayKey, updatedAt, limit } = params;
    const nowMs = Date.now();
    // 判定と加算を 1 文で行う。`DO UPDATE ... WHERE` が偽なら行は更新されず、RETURNING も空になる。
    // 日の欄（day_key・daily_rebuilds）は作り直しの回数のものなので、下書きを作っても触らない。
    const row = await this.db
      .prepare(
        `INSERT INTO repo_map_usage (
           user_id, month_key, monthly_drafts, day_key, daily_rebuilds, monthly_tokens, updated_at
         )
         SELECT ?, ?, 1, ?, 0, 0, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM account_deletions
           WHERE user_id = ? AND started_at_ms > ?
         )
           AND 1 <= ?
         ON CONFLICT (user_id, month_key) DO UPDATE SET
           monthly_drafts = repo_map_usage.monthly_drafts + 1,
           updated_at = excluded.updated_at
         WHERE repo_map_usage.monthly_drafts + 1 <= ?
         RETURNING day_key, monthly_drafts, daily_rebuilds, monthly_tokens`,
      )
      .bind(
        userId,
        monthKey,
        dayKey,
        updatedAt,
        userId,
        nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
        limit,
        limit,
      )
      .first<UsageRow>();
    if (row !== null) return { reserved: true, usage: toUsage(row, dayKey) };

    // 加算されなかった理由の切り分け。上限到達と退会中を同じ扱いにしない（RULE-004）。
    const current = await this.usage({ userId, monthKey, dayKey });
    if (current.monthlyDrafts + 1 > limit) return { reserved: false, usage: current };
    throw new Error("user deletion is in progress");
  }

  async releaseDraft(params: {
    userId: string;
    monthKey: string;
    updatedAt: string;
  }): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE repo_map_usage
         SET monthly_drafts = monthly_drafts - 1, updated_at = ?
         WHERE user_id = ? AND month_key = ? AND monthly_drafts > 0`,
      )
      .bind(params.updatedAt, params.userId, params.monthKey)
      .run();
    if (result.meta.changes === 0) {
      throw new Error(
        `repo_map_usage row is missing (user_id=${params.userId}, month_key=${params.monthKey})`,
      );
    }
  }

  async create(draft: StoredRepoMapDraft): Promise<void> {
    // 退会中の利用者の行を作らない（`D1AiUsageRepository.reserve` と同じ守り方）。
    const result = await this.db
      .prepare(
        `INSERT INTO repo_map_drafts (${DRAFT_COLUMNS})
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM account_deletions
           WHERE user_id = ? AND started_at_ms > ?
         )`,
      )
      .bind(
        draft.id,
        draft.userId,
        draft.repoOwner,
        draft.repoName,
        draft.defaultBranch,
        draft.commitSha,
        JSON.stringify(draft.targetFolders),
        JSON.stringify(draft.hintFiles),
        JSON.stringify(draft.hintIssues),
        draft.status,
        draft.stageState,
        draft.stageStateVersion,
        draft.createdAt,
        draft.updatedAt,
        draft.expiresAt,
        draft.userId,
        Date.now() - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
      )
      .run();
    if (result.meta.changes === 0) throw new Error("user deletion is in progress");
  }

  async get(userId: string, id: string): Promise<StoredRepoMapDraft | null> {
    const row = await this.db
      .prepare(`SELECT ${DRAFT_COLUMNS} FROM repo_map_drafts WHERE id = ? AND user_id = ?`)
      .bind(id, userId)
      .first<DraftRow>();
    return row === null ? null : toDraft(row);
  }

  async list(userId: string, nowIso: string): Promise<StoredRepoMapDraft[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${DRAFT_COLUMNS} FROM repo_map_drafts
         WHERE user_id = ? AND expires_at > ?
         ORDER BY updated_at DESC, id`,
      )
      .bind(userId, nowIso)
      .all<DraftRow>();
    return results.map(toDraft);
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM repo_map_drafts WHERE id = ? AND user_id = ?`)
      .bind(id, userId)
      .run();
    return result.meta.changes > 0;
  }

  async deleteExpired(nowIso: string, limit: number): Promise<number> {
    const result = await this.db
      .prepare(
        `DELETE FROM repo_map_drafts WHERE id IN (
           SELECT id FROM repo_map_drafts WHERE expires_at <= ? LIMIT ?
         )`,
      )
      .bind(nowIso, limit)
      .run();
    return result.meta.changes;
  }
}
