/**
 * `LearningEventRepository` の D1 実装。
 *
 * SQL とドメイン型の変換をここに閉じ込める。`conceptIds` が JSON 文字列であること、
 * 発生時刻が2列であることは、この外へ漏らさない。
 */

import type { LearningEvent, LearningEventType, EventOrigin } from "@gakushu-sochi/domain";
import {
  USER_SETTINGS_VERSION,
  isActivityPeriodDays,
  type UserSettings,
  type UserSettingsInput,
} from "../contract/user-settings.js";
import { ACCOUNT_DELETION_TOMBSTONE_TTL_MS } from "./types.js";
import type {
  AiUsage,
  AiUsageRepository,
  AppendResult,
  IdentityRepository,
  LearningEventRepository,
  MasteryOverride,
  MasteryOverrideRepository,
  StoredEventInput,
  UserSettingsRepository,
} from "./types.js";

/** learning_events の1行。SELECT する列と対応させる。 */
interface EventRow {
  id: string;
  occurred_at: string;
  type: string;
  origin: string;
  concept_ids: string;
  language: string | null;
  diagnostic_code: string | null;
  session_id: string | null;
}

async function hasActiveDeletion(db: D1Database, userId: string, nowMs: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS active
       FROM account_deletions
       WHERE user_id = ? AND started_at_ms > ?`,
    )
    .bind(userId, nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS)
    .first<{ active: number }>();
  return row !== null;
}

/**
 * D1 の行を `LearningEvent` へ戻す。
 *
 * `concept_ids` のパースに失敗したら例外にする。空配列へ丸めると、
 * そのイベントが習熟度の導出から黙って消え、Learning Map が理由の分からない形で
 * 欠ける。書き込み時に JSON 化しているので通常は起きず、起きたなら DB の破損である。
 */
function toLearningEvent(row: EventRow): LearningEvent {
  let conceptIds: unknown;
  try {
    conceptIds = JSON.parse(row.concept_ids);
  } catch (cause) {
    throw new Error(`learning_events.concept_ids is not valid JSON (id=${row.id})`, { cause });
  }
  if (!Array.isArray(conceptIds) || conceptIds.some((id) => typeof id !== "string")) {
    throw new Error(`learning_events.concept_ids is not string[] (id=${row.id})`);
  }

  return {
    id: row.id,
    occurredAt: row.occurred_at,
    // 型は書き込み時に契約側（learningEventSchema の picklist）で検証済み。
    type: row.type as LearningEventType,
    origin: row.origin as EventOrigin,
    conceptIds,
    ...(row.language === null ? {} : { language: row.language }),
    ...(row.diagnostic_code === null ? {} : { diagnosticCode: row.diagnostic_code }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
  };
}

export class D1LearningEventRepository implements LearningEventRepository {
  constructor(private readonly db: D1Database) {}

  async append(userId: string, inputs: readonly StoredEventInput[]): Promise<AppendResult[]> {
    if (inputs.length === 0) {
      return [];
    }

    const nowMs = Date.now();
    if (await hasActiveDeletion(this.db, userId, nowMs)) {
      throw new Error("user deletion is in progress");
    }

    const statement = this.db.prepare(
      `INSERT INTO learning_events (
         id, user_id, occurred_at, occurred_at_ms, type, origin, concept_ids,
         language, diagnostic_code, session_id, client_id, received_at_ms
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM account_deletions
         WHERE user_id = ? AND started_at_ms > ?
       )
       ON CONFLICT (user_id, id) DO NOTHING`,
    );

    const bound = inputs.map(({ event, clientId, receivedAtMs }) =>
      statement.bind(
        event.id,
        userId,
        event.occurredAt,
        // 契約側で Date.parse できることを検証済みのため NaN にはならない。
        Date.parse(event.occurredAt),
        event.type,
        event.origin,
        JSON.stringify(event.conceptIds),
        event.language ?? null,
        event.diagnosticCode ?? null,
        event.sessionId ?? null,
        clientId,
        receivedAtMs,
        userId,
        nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
      ),
    );

    // batch は SQL トランザクションであり、1文でも失敗すると全件がロールバックされる
    // （ローカル D1 で確認済み: FK 違反を1件混ぜると、同じバッチの正常な行も残らない）。
    // ここでは想定内の失敗は ON CONFLICT DO NOTHING で吸収され、残る失敗は
    // 呼び出し前に ensureUserAndDevice を通していない場合の FK 違反のような
    // 実装の誤りだけになる。部分的に書けた状態を作らないため、その場合は
    // バッチ全体を失敗させたままにする。
    const results = await this.db.batch(bound);

    if (await hasActiveDeletion(this.db, userId, nowMs)) {
      throw new Error("user deletion is in progress");
    }

    return inputs.map((input, index) => {
      const changes = results[index]?.meta?.changes;

      // changes が取れなかった場合は既定値で埋めない。0 として扱うと
      // 「全件重複」と応答しながら実際には書き込む状態になり、クライアントは
      // 送信キューを空にしてよいと判断してしまう。握りつぶさず落とす。
      if (typeof changes !== "number") {
        throw new Error(
          `D1 batch result has no meta.changes (index=${index}, id=${input.event.id})`,
        );
      }

      // 書き込まれた行が0なら、同じ ID が既にあったということ。
      // 主キーが (user_id, id) なので、これは常に「このユーザーの再送」を意味し、
      // 他ユーザーの同じ文字列との衝突ではない。
      return { id: input.event.id, duplicate: changes === 0 };
    });
  }

  async listByUser(userId: string): Promise<LearningEvent[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, occurred_at, type, origin, concept_ids, language, diagnostic_code, session_id
         FROM learning_events
         WHERE user_id = ?
         ORDER BY occurred_at_ms ASC, id ASC`,
      )
      .bind(userId)
      .all<EventRow>();

    return results.map(toLearningEvent);
  }

  async countByUser(userId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS count FROM learning_events WHERE user_id = ?`)
      .bind(userId)
      .first<{ count: number }>();

    return row?.count ?? 0;
  }
}

/** `IdentityRepository` の D1 実装。 */
export class D1IdentityRepository implements IdentityRepository {
  constructor(private readonly db: D1Database) {}

  async ensureUser(params: { userId: string; nowMs: number }): Promise<void> {
    const result = await this.db
      .prepare(
        `INSERT INTO users (id, created_at_ms)
         SELECT ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM account_deletions
           WHERE user_id = ? AND started_at_ms > ?
         )
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        params.userId,
        params.nowMs,
        params.userId,
        params.nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
      )
      .run();
    if (
      result.meta.changes === 0 &&
      (await hasActiveDeletion(this.db, params.userId, params.nowMs))
    ) {
      throw new Error("user deletion is in progress");
    }
  }

  async ensureUserAndDevice(params: {
    userId: string;
    clientId: string;
    nowMs: number;
  }): Promise<void> {
    const { userId, clientId, nowMs } = params;

    if (await hasActiveDeletion(this.db, userId, nowMs)) {
      throw new Error("user deletion is in progress");
    }

    // users を先に入れる。devices と learning_events の両方が users(id) を
    // 参照しているため、順序を逆にすると外部キー制約で落ちる。
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO users (id, created_at_ms)
           SELECT ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM account_deletions
             WHERE user_id = ? AND started_at_ms > ?
           )
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(userId, nowMs, userId, nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS),
      this.db
        .prepare(
          `INSERT INTO devices (user_id, client_id, created_at_ms, last_seen_at_ms)
           SELECT ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM account_deletions
             WHERE user_id = ? AND started_at_ms > ?
           )
           ON CONFLICT (user_id, client_id) DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms`,
        )
        .bind(userId, clientId, nowMs, nowMs, userId, nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS),
    ]);
    if (await hasActiveDeletion(this.db, userId, nowMs)) {
      throw new Error("user deletion is in progress");
    }
  }

  async startUserDeletion(userId: string, startedAtMs: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO account_deletions (user_id, started_at_ms)
         VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET started_at_ms = excluded.started_at_ms`,
      )
      .bind(userId, startedAtMs)
      .run();
  }

  async deleteUser(userId: string): Promise<void> {
    // 1文で足りる。learning_events と devices は users(id) を
    // ON DELETE CASCADE で参照している（migrations/0001_initial.sql）。
    // 子テーブルを個別に消しに行くと、順序を間違えたときに部分的に消えた
    // 状態を作る。
    await this.db.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
  }
}

export class D1MasteryOverrideRepository implements MasteryOverrideRepository {
  constructor(private readonly db: D1Database) {}

  async listByUser(userId: string): Promise<Record<string, MasteryOverride>> {
    const { results } = await this.db
      .prepare("SELECT concept_id, status, updated_at FROM mastery_overrides WHERE user_id = ?")
      .bind(userId)
      .all<{ concept_id: string; status: string; updated_at: string }>();
    const overrides: Record<string, MasteryOverride> = {};
    for (const row of results) {
      if (
        (row.status !== "unobserved" && row.status !== "learning" && row.status !== "confirmed") ||
        Number.isNaN(Date.parse(row.updated_at))
      ) {
        throw new Error(`mastery_overrides contains invalid data (concept_id=${row.concept_id})`);
      }
      overrides[row.concept_id] = {
        status: row.status as MasteryOverride["status"],
        updatedAt: row.updated_at,
      };
    }
    return overrides;
  }

  async put(
    userId: string,
    conceptId: string,
    status: MasteryOverride["status"] | null,
    updatedAt: string,
  ): Promise<Record<string, MasteryOverride>> {
    if (status === null) {
      await this.db
        .prepare("DELETE FROM mastery_overrides WHERE user_id = ? AND concept_id = ?")
        .bind(userId, conceptId)
        .run();
    } else {
      const nowMs = Date.now();
      const result = await this.db
        .prepare(
          `INSERT INTO mastery_overrides (user_id, concept_id, status, updated_at)
           SELECT ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM account_deletions
             WHERE user_id = ? AND started_at_ms > ?
           )
           ON CONFLICT (user_id, concept_id) DO UPDATE SET
             status = excluded.status,
             updated_at = excluded.updated_at`,
        )
        .bind(
          userId,
          conceptId,
          status,
          updatedAt,
          userId,
          nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
        )
        .run();
      if (result.meta.changes === 0 && (await hasActiveDeletion(this.db, userId, nowMs))) {
        throw new Error("user deletion is in progress");
      }
    }
    return this.listByUser(userId);
  }
}

export class D1UserSettingsRepository implements UserSettingsRepository {
  constructor(private readonly db: D1Database) {}

  async get(userId: string): Promise<UserSettings | null> {
    const row = await this.db
      .prepare(
        "SELECT display_name, activity_period_days, updated_at FROM user_settings WHERE user_id = ?",
      )
      .bind(userId)
      .first<{ display_name: string | null; activity_period_days: number; updated_at: string }>();
    if (row === null) return null;
    // 読めない行を既定値へ丸めない。丸めると、利用者が保存した設定が
    // 黙って別の値に化ける（.agents/rules/rules.md RULE-004）。
    // 書き込み時に CHECK 制約を通しているので、ここが失敗したなら DB の破損である。
    if (!isActivityPeriodDays(row.activity_period_days) || Number.isNaN(Date.parse(row.updated_at)))
      throw new Error(`user_settings contains invalid data (user_id=${userId})`);
    return {
      version: USER_SETTINGS_VERSION,
      displayName: row.display_name,
      activityPeriodDays: row.activity_period_days,
      updatedAt: row.updated_at,
    };
  }

  async put(userId: string, input: UserSettingsInput, updatedAt: string): Promise<UserSettings> {
    // 退会中のユーザーの行を作らない。`mastery_overrides` と同じ守り方で、
    // 削除の最中に users 行が復活する窓を塞ぐ（repository/types.ts の
    // `startUserDeletion` の説明を参照）。
    const nowMs = Date.now();
    const result = await this.db
      .prepare(
        `INSERT INTO user_settings (user_id, display_name, activity_period_days, updated_at)
         SELECT ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM account_deletions
           WHERE user_id = ? AND started_at_ms > ?
         )
         ON CONFLICT (user_id) DO UPDATE SET
           display_name = excluded.display_name,
           activity_period_days = excluded.activity_period_days,
           updated_at = excluded.updated_at`,
      )
      .bind(
        userId,
        input.displayName,
        input.activityPeriodDays,
        updatedAt,
        userId,
        nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
      )
      .run();
    if (result.meta.changes === 0 && (await hasActiveDeletion(this.db, userId, nowMs))) {
      throw new Error("user deletion is in progress");
    }
    return { version: USER_SETTINGS_VERSION, ...input, updatedAt };
  }
}

/** ai_usage の1行。 */
interface AiUsageRow {
  day_key: string;
  monthly_requests: number;
  daily_requests: number;
  monthly_tokens: number;
}

/**
 * `AiUsageRepository` の D1 実装（Issue #89 / Auth/10）。
 *
 * 期間の切り替わりは SQL 側で処理する。行を読んでから
 * アプリ側で判定して書き戻すと、同じユーザーの同時リクエストで
 * 読みと書きの間に割り込まれ、回数を数え落とす。
 * **加算は1文で行い、読みと書きを分けない。**
 */
export class D1AiUsageRepository implements AiUsageRepository {
  constructor(private readonly db: D1Database) {}

  async get(params: { userId: string; monthKey: string; dayKey: string }): Promise<AiUsage> {
    const row = await this.db
      .prepare(
        `SELECT day_key, monthly_requests, daily_requests, monthly_tokens
         FROM ai_usage WHERE user_id = ? AND month_key = ?`,
      )
      .bind(params.userId, params.monthKey)
      .first<AiUsageRow>();
    return toAiUsage(row, params.dayKey);
  }

  async reserve(params: {
    userId: string;
    monthKey: string;
    dayKey: string;
    updatedAt: string;
    limits: { dailyRequests: number; monthlyRequests: number };
  }): Promise<{ reserved: boolean; usage: AiUsage }> {
    const { userId, monthKey, dayKey, updatedAt, limits } = params;
    // 退会中のユーザーの行を作らない。`user_settings` と同じ守り方で、
    // 削除の最中に users 行が復活する窓を塞ぐ（repository/types.ts の
    // `startUserDeletion` の説明を参照）。
    const nowMs = Date.now();
    // 判定と加算を1文で行う。読んでから別の文で足すと、同じ利用者の同時
    // リクエストがその隙間に割り込み、弾いた分まで枠を消費する。
    // `DO UPDATE ... WHERE` が偽なら行は更新されず、RETURNING も空になる。
    const row = await this.db
      .prepare(
        `INSERT INTO ai_usage (
           user_id, month_key, day_key, monthly_requests, daily_requests, monthly_tokens, updated_at
         )
         SELECT ?, ?, ?, 1, 1, 0, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM account_deletions
           WHERE user_id = ? AND started_at_ms > ?
         )
         ON CONFLICT (user_id, month_key) DO UPDATE SET
           monthly_requests = ai_usage.monthly_requests + 1,
           -- 日が変わっていれば、その日の1回目として数え直す。
           daily_requests = CASE
             WHEN ai_usage.day_key = excluded.day_key THEN ai_usage.daily_requests + 1
             ELSE 1
           END,
           day_key = excluded.day_key,
           updated_at = excluded.updated_at
         WHERE ai_usage.monthly_requests < ?
           AND (ai_usage.day_key <> excluded.day_key OR ai_usage.daily_requests < ?)
         RETURNING day_key, monthly_requests, daily_requests, monthly_tokens`,
      )
      .bind(
        userId,
        monthKey,
        dayKey,
        updatedAt,
        userId,
        nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
        limits.monthlyRequests,
        limits.dailyRequests,
      )
      .first<AiUsageRow>();

    if (row !== null) return { reserved: true, usage: toAiUsage(row, dayKey) };

    // ここから先は「加算されなかった」理由の切り分けである。RETURNING が空に
    // なる経路は2つあり、**上限到達と退会中を同じ扱いにしない**（RULE-004）。
    const current = await this.get({ userId, monthKey, dayKey });
    const atLimit =
      current.monthlyRequests >= limits.monthlyRequests ||
      current.dailyRequests >= limits.dailyRequests;
    if (atLimit) return { reserved: false, usage: current };

    // 上限に達していないのに加算されていないなら、INSERT が
    // WHERE NOT EXISTS で弾かれている。つまり退会処理の最中である。
    throw new Error("user deletion is in progress");
  }

  async addTokens(params: {
    userId: string;
    monthKey: string;
    dayKey: string;
    tokens: number;
    updatedAt: string;
  }): Promise<void> {
    const { userId, monthKey, tokens, updatedAt } = params;
    // 加算対象の行は `reserve` が既に作っている。ここで行を作らないのは、
    // 回数を数えていない消費が記録されると、回数とトークンの辻褄が合わなくなるため。
    const result = await this.db
      .prepare(
        `UPDATE ai_usage
         SET monthly_tokens = monthly_tokens + ?, updated_at = ?
         WHERE user_id = ? AND month_key = ?`,
      )
      .bind(tokens, updatedAt, userId, monthKey)
      .run();
    if (result.meta.changes === 0) {
      throw new Error(`ai_usage row is missing (user_id=${userId}, month_key=${monthKey})`);
    }
  }
}

/** ai_usage の行を `AiUsage` へ戻す。行が無ければ全て 0。 */
function toAiUsage(row: AiUsageRow | null, dayKey: string): AiUsage {
  if (row === null) return { monthlyRequests: 0, dailyRequests: 0, monthlyTokens: 0 };
  return {
    monthlyRequests: row.monthly_requests,
    // 行が持つ日次は `day_key` の日のものである。日が変わっていれば 0 として扱う。
    dailyRequests: row.day_key === dayKey ? row.daily_requests : 0,
    monthlyTokens: row.monthly_tokens,
  };
}
