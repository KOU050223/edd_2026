/**
 * `RepoMapDraftRepository` のインメモリ実装。テスト用。
 *
 * D1 実装との差異が出ないよう、月と日の切り替わり・枠の判定を SQL 側と一致させてある。
 */

import type {
  AiCallRecord,
  DraftStage,
  DraftStatus,
  RepoMapDraftRepository,
  RepoMapUsage,
  StoredRepoMapDraft,
  StoredSummary,
} from "./repository.js";

interface UsageRow {
  monthlyDrafts: number;
  dayKey: string;
  dailyRebuilds: number;
  monthlyTokens: number;
}

export class InMemoryRepoMapDraftRepository implements RepoMapDraftRepository {
  private readonly drafts = new Map<string, StoredRepoMapDraft>();
  /** テスト用: 記録した AI の呼び出し（確定・期限切れで下書きが消えても残る）。 */
  readonly aiCallRows: { userId: string; draftId: string; call: AiCallRecord }[] = [];
  private readonly summaries = new Map<string, StoredSummary>();
  /** userId -> (monthKey -> 集計)。主キーを D1 と揃える。 */
  private readonly usageRows = new Map<string, Map<string, UsageRow>>();
  /** 退会中の利用者。`reserveDraft` と `create` が例外にする。 */
  private readonly deleting = new Set<string>();

  /**
   * `users` の行の集合を渡すと、D1 の外部キーと同じく、行の無い利用者の書き込みを拒否する。
   * 渡さなければ確かめない（行の用意を気にしないテスト向け）。
   */
  constructor(private readonly users?: ReadonlyMap<string, unknown>) {}

  private requireUser(userId: string): Error | null {
    if (this.users !== undefined && !this.users.has(userId)) {
      return new Error("FOREIGN KEY constraint failed: users row is missing");
    }
    return null;
  }

  /** テスト用: 退会の最中にする。 */
  markDeleting(userId: string): void {
    this.deleting.add(userId);
  }

  usage(params: { userId: string; monthKey: string; dayKey: string }): Promise<RepoMapUsage> {
    return Promise.resolve(this.read(params));
  }

  reserveDraft(params: {
    userId: string;
    monthKey: string;
    dayKey: string;
    updatedAt: string;
    limit: number;
  }): Promise<{ reserved: boolean; usage: RepoMapUsage }> {
    if (this.deleting.has(params.userId)) {
      return Promise.reject(new Error("user deletion is in progress"));
    }
    const missing = this.requireUser(params.userId);
    if (missing !== null) return Promise.reject(missing);
    const current = this.read(params);
    if (current.monthlyDrafts + 1 > params.limit) {
      return Promise.resolve({ reserved: false, usage: current });
    }
    const row = this.usageRows.get(params.userId)?.get(params.monthKey);
    this.write(params.userId, params.monthKey, {
      monthlyDrafts: current.monthlyDrafts + 1,
      // 日の欄は作り直しの回数のもの。下書きを作っても触らない。
      dayKey: row?.dayKey ?? params.dayKey,
      dailyRebuilds: row?.dailyRebuilds ?? 0,
      monthlyTokens: current.monthlyTokens,
    });
    return Promise.resolve({
      reserved: true,
      usage: { ...current, monthlyDrafts: current.monthlyDrafts + 1 },
    });
  }

  releaseDraft(params: { userId: string; monthKey: string; updatedAt: string }): Promise<void> {
    const row = this.usageRows.get(params.userId)?.get(params.monthKey);
    if (row === undefined || row.monthlyDrafts === 0) {
      return Promise.reject(new Error(`repo_map_usage row is missing (user_id=${params.userId})`));
    }
    this.write(params.userId, params.monthKey, { ...row, monthlyDrafts: row.monthlyDrafts - 1 });
    return Promise.resolve();
  }

  create(draft: StoredRepoMapDraft): Promise<void> {
    if (this.deleting.has(draft.userId)) {
      return Promise.reject(new Error("user deletion is in progress"));
    }
    const missing = this.requireUser(draft.userId);
    if (missing !== null) return Promise.reject(missing);
    this.drafts.set(draft.id, structuredClone(draft));
    return Promise.resolve();
  }

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
  ): Promise<boolean> {
    const draft = this.drafts.get(id);
    if (draft === undefined || draft.userId !== userId) return Promise.resolve(false);
    this.drafts.set(id, { ...draft, ...patch });
    return Promise.resolve(true);
  }

  recordAiCalls(params: {
    userId: string;
    draftId: string;
    monthKey: string;
    dayKey: string;
    updatedAt: string;
    calls: readonly AiCallRecord[];
  }): Promise<void> {
    const { userId, draftId, monthKey, dayKey } = params;
    const input = params.calls.reduce((n, c) => n + c.inputTokens, 0);
    const output = params.calls.reduce((n, c) => n + c.outputTokens, 0);
    for (const call of params.calls) this.aiCallRows.push({ userId, draftId, call: { ...call } });
    const draft = this.drafts.get(draftId);
    if (draft !== undefined && draft.userId === userId) {
      this.drafts.set(draftId, {
        ...draft,
        aiCalls: draft.aiCalls + params.calls.length,
        inputTokens: draft.inputTokens + input,
        outputTokens: draft.outputTokens + output,
      });
    }
    const row = this.usageRows.get(userId)?.get(monthKey);
    this.write(userId, monthKey, {
      monthlyDrafts: row?.monthlyDrafts ?? 0,
      dayKey: row?.dayKey ?? dayKey,
      dailyRebuilds: row?.dailyRebuilds ?? 0,
      monthlyTokens: (row?.monthlyTokens ?? 0) + input + output,
    });
    return Promise.resolve();
  }

  getSummaries(params: {
    repoOwner: string;
    repoName: string;
    promptVersion: number;
    blobShas: readonly string[];
  }): Promise<StoredSummary[]> {
    const wanted = new Set(params.blobShas);
    return Promise.resolve(
      [...this.summaries.values()].filter(
        (s) =>
          s.repoOwner === params.repoOwner &&
          s.repoName === params.repoName &&
          s.promptVersion === params.promptVersion &&
          wanted.has(s.blobSha),
      ),
    );
  }

  putSummaries(summaries: readonly StoredSummary[]): Promise<void> {
    for (const summary of summaries) this.putOne(summary);
    return Promise.resolve();
  }

  private putOne(summary: StoredSummary): void {
    const key = [
      summary.repoOwner,
      summary.repoName,
      summary.blobSha,
      summary.role,
      String(summary.bytesLimit),
    ].join("|");
    this.summaries.set(key, { ...summary });
  }

  get(userId: string, id: string): Promise<StoredRepoMapDraft | null> {
    const draft = this.drafts.get(id);
    return Promise.resolve(
      draft !== undefined && draft.userId === userId ? structuredClone(draft) : null,
    );
  }

  list(userId: string, nowIso: string): Promise<StoredRepoMapDraft[]> {
    const out = [...this.drafts.values()]
      .filter((d) => d.userId === userId && d.expiresAt > nowIso)
      .sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id.localeCompare(b.id),
      );
    return Promise.resolve(structuredClone(out));
  }

  delete(userId: string, id: string): Promise<boolean> {
    const draft = this.drafts.get(id);
    if (draft === undefined || draft.userId !== userId) return Promise.resolve(false);
    this.drafts.delete(id);
    return Promise.resolve(true);
  }

  deleteExpired(nowIso: string, limit: number): Promise<number> {
    let deleted = 0;
    for (const [id, draft] of this.drafts) {
      if (deleted >= limit) break;
      if (draft.expiresAt <= nowIso) {
        this.drafts.delete(id);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  private read(params: { userId: string; monthKey: string; dayKey: string }): RepoMapUsage {
    const row = this.usageRows.get(params.userId)?.get(params.monthKey);
    if (row === undefined) return { monthlyDrafts: 0, dailyRebuilds: 0, monthlyTokens: 0 };
    return {
      monthlyDrafts: row.monthlyDrafts,
      dailyRebuilds: row.dayKey === params.dayKey ? row.dailyRebuilds : 0,
      monthlyTokens: row.monthlyTokens,
    };
  }

  private write(userId: string, monthKey: string, row: UsageRow): void {
    let months = this.usageRows.get(userId);
    if (months === undefined) {
      months = new Map();
      this.usageRows.set(userId, months);
    }
    months.set(monthKey, row);
  }
}
