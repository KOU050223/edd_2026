/**
 * `LearningEventRepository` の D1 実装。
 *
 * SQL とドメイン型の変換をここに閉じ込める。`conceptIds` が JSON 文字列であること、
 * 発生時刻が2列であることは、この外へ漏らさない。
 */

import {
  CHECK_LEVELS,
  CHECK_SCOPES,
  checkTargetOf,
  type CheckLevel,
  type CheckScope,
  type ConsentRecord,
  type PersonalConceptCheck,
} from "@gakushu-sochi/domain";
import type {
  Conversation,
  ConversationMessage,
  ConversationOrigin,
  EvidenceImportedBy,
  EvidenceKind,
  EventOrigin,
  HistoryProviderId,
  LearningEvent,
  LearningEventType,
  LearningEvidence,
  UnmappedCandidate,
} from "@gakushu-sochi/domain";
import type { AreaCompletion } from "../contract/area-completions.js";
import {
  USER_SETTINGS_VERSION,
  isActivityPeriodDays,
  type UserSettings,
  type UserSettingsInput,
} from "../contract/user-settings.js";
import { parseConceptCheck } from "../checks/response.js";
import { toMapSourceView } from "../maps/import.js";
import { ACCOUNT_DELETION_TOMBSTONE_TTL_MS } from "./types.js";
import type { ImportSessionView } from "../contract/history-import.js";
import type { ConversationSummary } from "../contract/conversations.js";
import type {
  LearningMapSummary,
  LearningMapVisibility,
  LearningObjectiveSource,
  MapVersionMeta,
  MapVersionSummary,
  OwnSharedMapSummary,
  SharedMapSummary,
  ShareScope,
} from "../contract/learning-maps.js";
import { PLANS, type Plan } from "../contract/ai-usage.js";
import type {
  AiUsage,
  AiUsageRepository,
  AppendResult,
  AreaCompletionRepository,
  AuditLogEntry,
  AuditLogRepository,
  CheckGenerationConsentRepository,
  ConceptCheckRepository,
  ConversationListParams,
  ConversationRepository,
  IdentityRepository,
  ImportSessionRepository,
  LearningEventRepository,
  LearningEvidenceRepository,
  LearningMapRepository,
  MasteryOverride,
  MasteryOverrideRepository,
  CheckOrigin,
  PersonalCheckRepository,
  StoredConceptCheck,
  StoredCreationChecks,
  StoredEventInput,
  StoredImportSessionInput,
  StoredLearningMap,
  StoredLearningObjective,
  StoredMapContent,
  StoredMapNode,
  StoredMapSource,
  StoredMapVersion,
  StoredOwnMapNode,
  StoredSharedMap,
  MapSourceInput,
  UserPlanRepository,
  UserSettingsRepository,
  FixedMapCreatorRepository,
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
  objective_ids: string | null;
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
 * JSON 配列の列のパースに失敗したら例外にする（{@link parseStringArrayColumn}）。
 * 書き込み時に JSON 化しているので通常は起きず、起きたなら DB の破損である。
 */
function toLearningEvent(row: EventRow): LearningEvent {
  const conceptIds = parseStringArrayColumn("concept_ids", row.concept_ids, row.id);

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
    // NULL は「項目の情報を持たないイベント」（0011 より前のイベントを含む）。
    // 空配列とは区別して戻す。
    ...(row.objective_ids === null
      ? {}
      : { objectiveIds: parseStringArrayColumn("objective_ids", row.objective_ids, row.id) }),
  };
}

/**
 * learning_events の JSON 配列の列を `string[]` へ戻す。
 *
 * パースに失敗したら例外にする。空配列へ丸めると、そのイベントが習熟度の導出から
 * 黙って消え、Learning Map が理由の分からない形で欠ける。
 */
function parseStringArrayColumn(column: string, value: string, eventId: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error(`learning_events.${column} is not valid JSON (id=${eventId})`, { cause });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`learning_events.${column} is not string[] (id=${eventId})`);
  }
  return parsed as string[];
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
         language, diagnostic_code, session_id, objective_ids, client_id, received_at_ms
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM account_deletions
         WHERE user_id = ? AND started_at_ms > ?
       )
       -- 履歴の削除より前に受け取ったイベントは書かない。同じ文の中で判定するので、
       -- 読んでから書くまでの間に DELETE が割り込む隙間が無い。
       AND NOT EXISTS (
         SELECT 1 FROM learning_history_resets
         WHERE user_id = ? AND reset_at_ms >= ?
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
        event.objectiveIds === undefined ? null : JSON.stringify(event.objectiveIds),
        clientId,
        receivedAtMs,
        userId,
        nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
        userId,
        receivedAtMs,
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

    // 書かれなかった行が「重複」なのか「履歴の削除に含まれた」なのかを分けるために読む。
    // バッチの後に読むので、バッチ中に割り込んだ削除も拾える。
    const reset = await this.db
      .prepare(`SELECT reset_at_ms FROM learning_history_resets WHERE user_id = ?`)
      .bind(userId)
      .first<{ reset_at_ms: number }>();

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

      // 削除より前に受け取ったイベントは、受理したうえで削除に含まれた扱いにする。
      // 重複と答えないのは、既に保存済みだったかのように見せないため。
      // droppedByReset で区別を返すのは、クライアントが削除への追従後に
      // このイベントをローカルへ記録し直さないための根拠になるため（Issue #124）。
      if (changes === 0 && reset !== null && reset.reset_at_ms >= input.receivedAtMs) {
        return { id: input.event.id, duplicate: false, droppedByReset: true };
      }

      // 書き込まれた行が0なら、同じ ID が既にあったということ。
      // 主キーが (user_id, id) なので、これは常に「このユーザーの再送」を意味し、
      // 他ユーザーの同じ文字列との衝突ではない。
      return { id: input.event.id, duplicate: changes === 0, droppedByReset: false };
    });
  }

  async listByUser(userId: string): Promise<LearningEvent[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, occurred_at, type, origin, concept_ids, language, diagnostic_code, session_id,
                objective_ids
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

  async deleteByUser(userId: string, resetAtMs: number): Promise<number> {
    // 削除時刻の記録とイベントの削除を1つのトランザクションにする。
    // 片方だけ成功すると、競合を塞げないか、塞いだのに消えていないかのどちらかになる。
    // 時刻は巻き戻さない。遅れて届いた古い削除要求で境界を後退させないため。
    const [, result] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO learning_history_resets (user_id, reset_at_ms) VALUES (?, ?)
           ON CONFLICT (user_id) DO UPDATE
           SET reset_at_ms = MAX(reset_at_ms, excluded.reset_at_ms)`,
        )
        .bind(userId, resetAtMs),
      this.db.prepare(`DELETE FROM learning_events WHERE user_id = ?`).bind(userId),
    ]);

    // 件数が取れなければ既定値で埋めない。0 と答えると「消すものが無かった」と
    // 「消せたか分からない」の区別が消える（RULE-004）。
    const changes = result?.meta?.changes;
    if (typeof changes !== "number") {
      throw new Error("D1 delete result has no meta.changes");
    }
    return changes;
  }

  async latestResetAtMs(userId: string): Promise<number | null> {
    const row = await this.db
      .prepare(`SELECT reset_at_ms FROM learning_history_resets WHERE user_id = ?`)
      .bind(userId)
      .first<{ reset_at_ms: number }>();
    return row?.reset_at_ms ?? null;
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
        `SELECT display_name, activity_period_days, save_conversation_history, updated_at
         FROM user_settings WHERE user_id = ?`,
      )
      .bind(userId)
      .first<{
        display_name: string | null;
        activity_period_days: number;
        save_conversation_history: number;
        updated_at: string;
      }>();
    if (row === null) return null;
    // 読めない行を既定値へ丸めない。丸めると、利用者が保存した設定が
    // 黙って別の値に化ける（.agents/rules/rules.md RULE-004）。
    // 書き込み時に CHECK 制約を通しているので、ここが失敗したなら DB の破損である。
    if (
      !isActivityPeriodDays(row.activity_period_days) ||
      !is0or1(row.save_conversation_history) ||
      Number.isNaN(Date.parse(row.updated_at))
    )
      throw new Error(`user_settings contains invalid data (user_id=${userId})`);
    return {
      version: USER_SETTINGS_VERSION,
      displayName: row.display_name,
      activityPeriodDays: row.activity_period_days,
      saveConversationHistory: row.save_conversation_history === 1,
      updatedAt: row.updated_at,
    };
  }

  async put(userId: string, input: UserSettingsInput, updatedAt: string): Promise<UserSettings> {
    // 退会中のユーザーの行を作らない。`mastery_overrides` と同じ守り方で、
    // 削除の最中に users 行が復活する窓を塞ぐ（repository/types.ts の
    // `startUserDeletion` の説明を参照）。
    const nowMs = Date.now();
    // 「省略=現状維持」をこの1文の中で解決する。提供された列だけを書き換える
    // upsert にすれば、読み取り→書き込みの間に別端末が保存した値を
    // 古い値で上書きしない（項目ごとの更新が不可分になる）。
    // INSERT 側（まだ行が無い初回）では省略項目へ既定値を使う。
    const result = await this.db
      .prepare(
        `INSERT INTO user_settings (
           user_id, display_name, activity_period_days, save_conversation_history, updated_at
         )
         SELECT ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM account_deletions
           WHERE user_id = ? AND started_at_ms > ?
         )
         ON CONFLICT (user_id) DO UPDATE SET
           display_name = CASE WHEN ? THEN excluded.display_name
                               ELSE user_settings.display_name END,
           activity_period_days = CASE WHEN ? THEN excluded.activity_period_days
                                       ELSE user_settings.activity_period_days END,
           save_conversation_history = CASE WHEN ? THEN excluded.save_conversation_history
                                          ELSE user_settings.save_conversation_history END,
           updated_at = excluded.updated_at`,
      )
      .bind(
        userId,
        input.displayName ?? null,
        input.activityPeriodDays ?? 30,
        input.saveConversationHistory === undefined ? 0 : input.saveConversationHistory ? 1 : 0,
        updatedAt,
        userId,
        nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
        input.displayName === undefined ? 0 : 1,
        input.activityPeriodDays === undefined ? 0 : 1,
        input.saveConversationHistory === undefined ? 0 : 1,
      )
      .run();
    if (result.meta.changes === 0 && (await hasActiveDeletion(this.db, userId, nowMs))) {
      throw new Error("user deletion is in progress");
    }
    // 省略項目を含む保存後の値を返すため、書いた行を読み直す。
    const saved = await this.get(userId);
    if (saved === null) {
      throw new Error(`user_settings row missing after put (user_id=${userId})`);
    }
    return saved;
  }
}

/** INTEGER で保存する 0/1 フラグの読み取り検査。 */
function is0or1(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

/** conversations の1行。SELECT する列と対応させる。 */
interface ConversationRow {
  id: string;
  origin: string;
  client_id: string | null;
  title: string | null;
  language: string | null;
  file_name: string | null;
  messages: string;
  message_count: number;
  complete: number;
  occurred_at: string;
  occurred_at_ms: number;
  updated_at: string;
  updated_at_ms: number;
}

const CONVERSATION_COLUMNS = `id, origin, client_id, title, language, file_name,
  messages, message_count, complete, occurred_at, occurred_at_ms, updated_at, updated_at_ms`;

/** 一覧が読む列。本文（messages）と並び替え専用の _ms 列は要約に要らない。 */
interface ConversationSummaryRow {
  id: string;
  origin: string;
  client_id: string | null;
  title: string | null;
  language: string | null;
  file_name: string | null;
  message_count: number;
  complete: number;
  occurred_at: string;
  updated_at: string;
}

// 一覧は各行の本文を読まない。messages は1会話あたり契約上限 256,000 文字まで
// あり、100 件ページの取得が最大数十 MB になるのを防ぐ。
const CONVERSATION_SUMMARY_COLUMNS = `id, origin, client_id, title, language, file_name,
  message_count, complete, occurred_at, updated_at`;

/**
 * D1 の行を `Conversation` へ戻す。
 *
 * `messages` のパースに失敗したら例外にする。空配列へ丸めると、消えた履歴が
 * 件数だけは残る「壊れた一覧」になる。書き込み時に契約側で検証済みなので、
 * ここが失敗したなら DB の破損である（toLearningEvent と同じ方針）。
 */
function toConversation(row: ConversationRow): Conversation {
  let messages: unknown;
  try {
    messages = JSON.parse(row.messages);
  } catch (cause) {
    throw new Error(`conversations.messages is not valid JSON (id=${row.id})`, { cause });
  }
  if (
    !Array.isArray(messages) ||
    messages.some(
      (message) =>
        typeof message !== "object" ||
        message === null ||
        typeof message.role !== "string" ||
        typeof message.text !== "string" ||
        typeof message.at !== "string",
    )
  ) {
    throw new Error(`conversations.messages is not ConversationMessage[] (id=${row.id})`);
  }

  return {
    id: row.id,
    // 書き込み時に契約側の picklist で検証済み。
    origin: row.origin as ConversationOrigin,
    ...(row.client_id === null ? {} : { clientId: row.client_id }),
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.language === null ? {} : { language: row.language }),
    ...(row.file_name === null ? {} : { fileName: row.file_name }),
    occurredAt: row.occurred_at,
    updatedAt: row.updated_at,
    complete: row.complete === 1,
    messages: messages as ConversationMessage[],
  };
}

function toConversationSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    id: row.id,
    origin: row.origin,
    ...(row.client_id === null ? {} : { clientId: row.client_id }),
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.language === null ? {} : { language: row.language }),
    ...(row.file_name === null ? {} : { fileName: row.file_name }),
    occurredAt: row.occurred_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    complete: row.complete === 1,
  };
}

/**
 * `ConversationRepository` の D1 実装（Issue #204）。
 */
export class D1ConversationRepository implements ConversationRepository {
  constructor(private readonly db: D1Database) {}

  async upsert(
    userId: string,
    conversation: Conversation,
    receivedAtMs: number,
  ): Promise<{ saved: boolean }> {
    // 既存のほうが新しい会話を古いスナップショットで巻き戻さないため、
    // 更新は届いた updated_at_ms が既存以上のときだけに絞る。
    // INSERT か UPDATE か・書けたかは changes で判定する。
    // オプトインの検査もこの1文の中で行う。ルート側の事前 403 だけだと、
    // 設定の読み取りとこの書き込みの間に別端末がオプトインを外しても
    // 本文が保存される（設定の再検査を書き込みと不可分にする）。
    const nowMs = Date.now();
    const result = await this.db
      .prepare(
        `INSERT INTO conversations (
           id, user_id, origin, client_id, title, language, file_name,
           messages, message_count, complete,
           occurred_at, occurred_at_ms, updated_at, updated_at_ms, received_at_ms
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM account_deletions
           WHERE user_id = ? AND started_at_ms > ?
         )
         AND EXISTS (
           SELECT 1 FROM user_settings
           WHERE user_id = ? AND save_conversation_history = 1
         )
         ON CONFLICT (user_id, id) DO UPDATE SET
           origin = excluded.origin,
           client_id = excluded.client_id,
           title = excluded.title,
           language = excluded.language,
           file_name = excluded.file_name,
           messages = excluded.messages,
           message_count = excluded.message_count,
           complete = excluded.complete,
           occurred_at = excluded.occurred_at,
           occurred_at_ms = excluded.occurred_at_ms,
           updated_at = excluded.updated_at,
           updated_at_ms = excluded.updated_at_ms,
           received_at_ms = excluded.received_at_ms
         WHERE excluded.updated_at_ms >= conversations.updated_at_ms
           AND (SELECT save_conversation_history FROM user_settings
                WHERE user_id = conversations.user_id) = 1`,
      )
      .bind(
        conversation.id,
        userId,
        conversation.origin,
        conversation.clientId ?? null,
        conversation.title ?? null,
        conversation.language ?? null,
        conversation.fileName ?? null,
        JSON.stringify(conversation.messages),
        conversation.messages.length,
        conversation.complete ? 1 : 0,
        conversation.occurredAt,
        // 契約側で Date.parse できることを検証済みのため NaN にはならない。
        Date.parse(conversation.occurredAt),
        conversation.updatedAt,
        Date.parse(conversation.updatedAt),
        receivedAtMs,
        userId,
        nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
        userId,
      )
      .run();

    if (result.meta.changes === 0 && (await hasActiveDeletion(this.db, userId, nowMs))) {
      throw new Error("user deletion is in progress");
    }
    return { saved: result.meta.changes > 0 };
  }

  async listByUser(userId: string, params: ConversationListParams): Promise<ConversationSummary[]> {
    // カーソルの有無で2通りの文に分ける。片方の文に NULL 許容の条件を織り込むと、
    // 比較が NULL で偽になる扱いを読み手が追う必要がある。
    const rows = params.cursor
      ? await this.db
          .prepare(
            `SELECT ${CONVERSATION_SUMMARY_COLUMNS} FROM conversations
             WHERE user_id = ?
               AND (updated_at_ms < ? OR (updated_at_ms = ? AND id > ?))
             ORDER BY updated_at_ms DESC, id ASC
             LIMIT ?`,
          )
          .bind(
            userId,
            params.cursor.updatedAtMs,
            params.cursor.updatedAtMs,
            params.cursor.id,
            params.limit,
          )
          .all<ConversationSummaryRow>()
      : await this.db
          .prepare(
            `SELECT ${CONVERSATION_SUMMARY_COLUMNS} FROM conversations
             WHERE user_id = ?
             ORDER BY updated_at_ms DESC, id ASC
             LIMIT ?`,
          )
          .bind(userId, params.limit)
          .all<ConversationSummaryRow>();
    return rows.results.map(toConversationSummary);
  }

  async getById(userId: string, id: string): Promise<Conversation | null> {
    const row = await this.db
      .prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE user_id = ? AND id = ?`)
      .bind(userId, id)
      .first<ConversationRow>();
    return row === null ? null : toConversation(row);
  }

  async deleteById(userId: string, id: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM conversations WHERE user_id = ? AND id = ?`)
      .bind(userId, id)
      .run();
    // 件数が取れなければ既定値で埋めない（RULE-004）。
    const changes = result.meta.changes;
    if (typeof changes !== "number") {
      throw new Error("D1 delete result has no meta.changes");
    }
    return changes;
  }

  async deleteAllByUser(userId: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM conversations WHERE user_id = ?`)
      .bind(userId)
      .run();
    const changes = result.meta.changes;
    if (typeof changes !== "number") {
      throw new Error("D1 delete result has no meta.changes");
    }
    return changes;
  }

  async listAllByUser(userId: string): Promise<Conversation[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
         WHERE user_id = ?
         ORDER BY updated_at_ms DESC, id ASC`,
      )
      .bind(userId)
      .all<ConversationRow>();
    return results.map(toConversation);
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
    amount?: number;
  }): Promise<{ reserved: boolean; usage: AiUsage }> {
    const { userId, monthKey, dayKey, updatedAt, limits } = params;
    const amount = params.amount ?? 1;
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
         SELECT ?, ?, ?, ?, ?, 0, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM account_deletions
           WHERE user_id = ? AND started_at_ms > ?
         )
           -- 初回の行でも、確保する回数が上限を超えるなら作らない。
           AND ? <= ? AND ? <= ?
         ON CONFLICT (user_id, month_key) DO UPDATE SET
           monthly_requests = ai_usage.monthly_requests + excluded.monthly_requests,
           -- 日が変わっていれば、その日の最初の分として数え直す。
           daily_requests = CASE
             WHEN ai_usage.day_key = excluded.day_key
               THEN ai_usage.daily_requests + excluded.daily_requests
             ELSE excluded.daily_requests
           END,
           day_key = excluded.day_key,
           updated_at = excluded.updated_at
         WHERE ai_usage.monthly_requests + excluded.monthly_requests <= ?
           AND (
             ai_usage.day_key <> excluded.day_key
             OR ai_usage.daily_requests + excluded.daily_requests <= ?
           )
         RETURNING day_key, monthly_requests, daily_requests, monthly_tokens`,
      )
      .bind(
        userId,
        monthKey,
        dayKey,
        amount,
        amount,
        updatedAt,
        userId,
        nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
        amount,
        limits.monthlyRequests,
        amount,
        limits.dailyRequests,
        limits.monthlyRequests,
        limits.dailyRequests,
      )
      .first<AiUsageRow>();

    if (row !== null) return { reserved: true, usage: toAiUsage(row, dayKey) };

    // ここから先は「加算されなかった」理由の切り分けである。RETURNING が空に
    // なる経路は2つあり、**上限到達と退会中を同じ扱いにしない**（RULE-004）。
    const current = await this.get({ userId, monthKey, dayKey });
    const atLimit =
      current.monthlyRequests + amount > limits.monthlyRequests ||
      current.dailyRequests + amount > limits.dailyRequests;
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

/** `UserPlanRepository` の D1 実装（#289）。 */
export class D1UserPlanRepository implements UserPlanRepository {
  constructor(private readonly db: D1Database) {}

  async get(userId: string): Promise<Plan> {
    const row = await this.db
      .prepare(`SELECT plan FROM user_plans WHERE user_id = ?`)
      .bind(userId)
      .first<{ plan: string }>();
    if (row === null) return "free";
    // 表の CHECK と型がずれたとき、知らないプランを free として黙って通さない（RULE-004）。
    if (!(PLANS as readonly string[]).includes(row.plan)) {
      throw new Error(`unknown plan in user_plans: ${row.plan}`);
    }
    return row.plan as Plan;
  }
}

/** `FixedMapCreatorRepository` の D1 実装（migrations/0018_fixed_map_creators.sql）。 */
export class D1FixedMapCreatorRepository implements FixedMapCreatorRepository {
  constructor(private readonly db: D1Database) {}

  async isCreator(language: string, userId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS found FROM fixed_map_creators WHERE language = ? AND user_id = ?`)
      .bind(language, userId)
      .first<{ found: number }>();
    return row !== null;
  }

  async languagesOf(userId: string): Promise<string[]> {
    const rows = await this.db
      .prepare(`SELECT language FROM fixed_map_creators WHERE user_id = ? ORDER BY language`)
      .bind(userId)
      .all<{ language: string }>();
    return rows.results.map((row) => row.language);
  }
}

/**
 * `AuditLogRepository` の D1 実装（Issue #122）。
 *
 * 追記のみ。`user_id` は `users(id)` を参照するため、users 行が無いまま
 * 書こうとすると FOREIGN KEY constraint failed で落ちる。行が無い利用者を
 * 記録したい経路では、呼び出し側が先に `ensureUser` で行を用意する。
 * `ensureUser` と `record` の間に退会（users 行の削除）が割り込む競合窓は
 * 残るが、狭いうえ失敗は伝播するだけなので、そのままにしてある。
 */
export class D1AuditLogRepository implements AuditLogRepository {
  constructor(private readonly db: D1Database) {}

  async record(entry: AuditLogEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_log (user_id, action, occurred_at_ms, detail)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(
        entry.userId,
        entry.action,
        entry.occurredAtMs,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      )
      .run();
  }
}

/**
 * 分野コンプリートの記録（migrations/0007_area_completions.sql）。
 *
 * 追記だけで、消す操作も書き換える操作も持たない。
 */
export class D1AreaCompletionRepository implements AreaCompletionRepository {
  constructor(private readonly db: D1Database) {}

  async listByUser(userId: string): Promise<AreaCompletion[]> {
    const { results } = await this.db
      .prepare(
        `SELECT language, completed_at
         FROM area_completions
         WHERE user_id = ?
         ORDER BY completed_at, language`,
      )
      .bind(userId)
      .all<{ language: string; completed_at: string }>();
    return results.map((row) => {
      // 読めない時刻を黙って通さない。表示側で Invalid Date になるより、ここで落とす（RULE-004）。
      if (Number.isNaN(Date.parse(row.completed_at))) {
        throw new Error(`area_completions contains invalid data (language=${row.language})`);
      }
      return { language: row.language, completedAt: row.completed_at };
    });
  }

  async record(userId: string, languages: readonly string[], completedAt: string): Promise<void> {
    if (languages.length === 0) return;
    // OR IGNORE で、既に記録済みの分野は素通りする。再実行しても件数が増えず、
    // 最初の達成時刻が後の時刻で上書きされない。
    await this.db.batch(
      languages.map((language) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO area_completions (user_id, language, completed_at)
             VALUES (?, ?, ?)`,
          )
          .bind(userId, language, completedAt),
      ),
    );
  }
}

/**
 * 確認問題の保存（migrations/0009_concept_checks.sql、Issue #185）。
 *
 * 表は `users(id)` を参照しない。退会（`DELETE FROM users`）でも消えない。
 */
export class D1ConceptCheckRepository implements ConceptCheckRepository {
  constructor(private readonly db: D1Database) {}

  async get(conceptId: string): Promise<StoredConceptCheck | null> {
    const row = await this.db
      .prepare(
        `SELECT format_version, prompt_sha256, body, model, generated_at
         FROM concept_checks
         WHERE concept_id = ?`,
      )
      .bind(conceptId)
      .first<{
        format_version: number;
        prompt_sha256: string;
        body: string;
        model: string;
        generated_at: string;
      }>();
    if (row === null) return null;

    // 書き込み時に検証した形しか入らないはずなので、読めなければ DB の破損である。
    // 生成し直して黙って上書きすると、壊れた原因を追えなくなる（RULE-004）。
    const parsed = parseConceptCheck(row.body, conceptId);
    if (!parsed.ok) {
      throw new Error(
        `concept_checks contains invalid data (concept_id=${conceptId}, reason=${parsed.reason})`,
      );
    }
    if (Number.isNaN(Date.parse(row.generated_at))) {
      throw new Error(`concept_checks.generated_at is invalid (concept_id=${conceptId})`);
    }
    return {
      check: { ...parsed.check, model: row.model, generatedAt: row.generated_at },
      formatVersion: row.format_version,
      promptSha256: row.prompt_sha256,
    };
  }

  async put(stored: StoredConceptCheck): Promise<void> {
    const { conceptId, overview, practice, model, generatedAt } = stored.check;
    // 本文は生成時の JSON と同じ形で持つ。読み出しで `parseConceptCheck` をそのまま通せる。
    const body = JSON.stringify({ conceptId, overview, practice });
    // 同時に2人が生成させた場合は後着が勝つ。どちらも検証済みの1組なので、
    // どちらが残っても出題として成立する。
    await this.db
      .prepare(
        `INSERT INTO concept_checks (
           concept_id, format_version, prompt_sha256, body, model, generated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (concept_id) DO UPDATE SET
           format_version = excluded.format_version,
           prompt_sha256 = excluded.prompt_sha256,
           body = excluded.body,
           model = excluded.model,
           generated_at = excluded.generated_at`,
      )
      .bind(conceptId, stored.formatVersion, stored.promptSha256, body, model, generatedAt)
      .run();
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

// ---------------------------------------------------------------------------
// 外部履歴からの学習引き継ぎ（Issue #157）
// ---------------------------------------------------------------------------

/** learning_evidence の1行。SELECT する列と対応させる。 */
interface EvidenceRow {
  id: string;
  import_session_id: string;
  provider: string;
  imported_by: string;
  kind: string;
  concept_ids: string;
  observed_at: string | null;
  confidence: number;
  external_ref_hash: string | null;
}

const EVIDENCE_COLUMNS = `id, import_session_id, provider, imported_by, kind, concept_ids,
  observed_at, confidence, external_ref_hash`;

/**
 * learning_evidence の行を `LearningEvidence` へ戻す。
 *
 * `concept_ids` のパースに失敗したら例外にする。`toLearningEvent` と同じく、
 * 空配列へ丸めると「なぜこの状態か」の根拠が黙って欠けるため。
 */
function toLearningEvidence(row: EvidenceRow): LearningEvidence {
  let conceptIds: unknown;
  try {
    conceptIds = JSON.parse(row.concept_ids);
  } catch (cause) {
    throw new Error(`learning_evidence.concept_ids is not valid JSON (id=${row.id})`, {
      cause,
    });
  }
  if (!Array.isArray(conceptIds) || conceptIds.some((id) => typeof id !== "string")) {
    throw new Error(`learning_evidence.concept_ids is not string[] (id=${row.id})`);
  }

  return {
    id: row.id,
    conceptIds,
    source: {
      provider: row.provider as HistoryProviderId,
      importedBy: row.imported_by as EvidenceImportedBy,
    },
    kind: row.kind as EvidenceKind,
    ...(row.observed_at === null ? {} : { observedAt: row.observed_at }),
    confidence: row.confidence,
    importSessionId: row.import_session_id,
    ...(row.external_ref_hash === null ? {} : { externalRefHash: row.external_ref_hash }),
  };
}

/** import_sessions の1行。 */
interface ImportSessionRow {
  id: string;
  status: string;
  imported_by: string;
  providers: string;
  conversation_count: number;
  ignored_count: number;
  unmapped_candidates: string;
  evidence_count: number;
  concept_count: number;
  created_at: string;
  updated_at: string;
}

/** JSON 配列の列を読む。壊れていれば丸めず例外にする（RULE-004）。 */
function parseStringArrayJson(raw: string, context: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${context} is not valid JSON`, { cause });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${context} is not string[]`);
  }
  return parsed;
}

function toImportSessionView(row: ImportSessionRow): ImportSessionView {
  return {
    id: row.id,
    status: row.status,
    importedBy: row.imported_by as EvidenceImportedBy,
    providers: parseStringArrayJson(
      row.providers,
      `import_sessions.providers (id=${row.id})`,
    ) as HistoryProviderId[],
    conversationCount: row.conversation_count,
    ignoredCount: row.ignored_count,
    evidenceCount: row.evidence_count,
    conceptCount: row.concept_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUnmappedCandidates(row: ImportSessionRow): UnmappedCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.unmapped_candidates);
  } catch (cause) {
    throw new Error(`import_sessions.unmapped_candidates is not valid JSON (id=${row.id})`, {
      cause,
    });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (item) =>
        typeof item !== "object" ||
        item === null ||
        typeof (item as { sourceId?: unknown }).sourceId !== "string" ||
        typeof (item as { candidate?: unknown }).candidate !== "string",
    )
  ) {
    throw new Error(`import_sessions.unmapped_candidates has unexpected shape (id=${row.id})`);
  }
  return parsed as UnmappedCandidate[];
}

export class D1LearningEvidenceRepository implements LearningEvidenceRepository {
  constructor(private readonly db: D1Database) {}

  async listByUser(userId: string): Promise<LearningEvidence[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${EVIDENCE_COLUMNS} FROM learning_evidence WHERE user_id = ? ORDER BY id ASC`,
      )
      .bind(userId)
      .all<EvidenceRow>();
    return results.map(toLearningEvidence);
  }

  async listBySession(userId: string, sessionId: string): Promise<LearningEvidence[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${EVIDENCE_COLUMNS} FROM learning_evidence
         WHERE user_id = ? AND import_session_id = ? ORDER BY id ASC`,
      )
      .bind(userId, sessionId)
      .all<EvidenceRow>();
    return results.map(toLearningEvidence);
  }

  async deleteByProvider(
    userId: string,
    provider: HistoryProviderId,
    updatedAt: string,
  ): Promise<{ deletedCount: number; sessionsMarkedUndone: number }> {
    // 「どの Session がこの provider の Evidence を持っていたか」を消す前に
    // 記録する必要はない。消した後に「Evidence が残らなかった applied の
    // Session」を undone へ倒す方が、消し損ねた Session を残さず確実である。
    const [deleted, undone] = await this.db.batch([
      this.db
        .prepare(`DELETE FROM learning_evidence WHERE user_id = ? AND provider = ?`)
        .bind(userId, provider),
      this.db
        .prepare(
          `UPDATE import_sessions SET status = 'undone', updated_at = ?
           WHERE user_id = ? AND status = 'applied'
             AND NOT EXISTS (
               SELECT 1 FROM learning_evidence
               WHERE learning_evidence.user_id = import_sessions.user_id
                 AND learning_evidence.import_session_id = import_sessions.id
             )`,
        )
        .bind(updatedAt, userId),
    ]);

    const deletedCount = deleted?.meta?.changes;
    if (typeof deletedCount !== "number") {
      throw new Error("D1 delete result has no meta.changes");
    }
    const sessionsMarkedUndone = undone?.meta?.changes;
    if (typeof sessionsMarkedUndone !== "number") {
      throw new Error("D1 update result has no meta.changes");
    }
    return { deletedCount, sessionsMarkedUndone };
  }

  async deleteAllByUser(userId: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM learning_evidence WHERE user_id = ?`)
      .bind(userId)
      .run();
    const changes = result.meta.changes;
    if (typeof changes !== "number") {
      throw new Error("D1 delete result has no meta.changes");
    }
    return changes;
  }
}

export class D1ImportSessionRepository implements ImportSessionRepository {
  constructor(private readonly db: D1Database) {}

  async createWithEvidence(
    userId: string,
    session: StoredImportSessionInput,
    evidence: readonly LearningEvidence[],
  ): Promise<{ alreadyExisted: boolean }> {
    const nowMs = Date.now();

    // Session と Evidence を同じバッチに入れて原子的に作る。
    // 先に存在を確認してから分岐すると、同じ ID の再送と並行したときに
    // どちらかが中途半端な状態を作る。ON CONFLICT で DB 側へ委ねる。
    const statements = [
      this.db
        .prepare(
          `INSERT INTO import_sessions (
             id, user_id, status, imported_by, providers, conversation_count,
             ignored_count, unmapped_candidates, evidence_count, concept_count,
             created_at, updated_at
           )
           SELECT ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM account_deletions
             WHERE user_id = ? AND started_at_ms > ?
           )
           ON CONFLICT (user_id, id) DO NOTHING`,
        )
        .bind(
          session.id,
          userId,
          session.importedBy,
          JSON.stringify(session.providers),
          session.conversationCount,
          session.ignoredCount,
          JSON.stringify(session.unmappedCandidates),
          session.evidenceCount,
          session.conceptCount,
          session.createdAt,
          session.updatedAt,
          userId,
          nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS,
        ),
      ...evidence.map((item) =>
        this.db
          .prepare(
            // Undo 済みの Session が同じ ID で再送されたとき、Evidence だけが
            // 復活して「undone なのに形跡が残る」状態を作らないよう、
            // applied な Session が存在するときだけ書く。
            `INSERT INTO learning_evidence (
               id, user_id, import_session_id, provider, imported_by, kind,
               concept_ids, observed_at, confidence, external_ref_hash, received_at_ms
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM import_sessions
               WHERE user_id = ? AND id = ? AND status = 'applied'
             )
             ON CONFLICT (user_id, id) DO NOTHING`,
          )
          .bind(
            item.id,
            userId,
            session.id,
            item.source.provider,
            item.source.importedBy,
            item.kind,
            JSON.stringify(item.conceptIds),
            item.observedAt ?? null,
            item.confidence,
            item.externalRefHash ?? null,
            nowMs,
            userId,
            session.id,
          ),
      ),
    ];
    const results = await this.db.batch(statements);

    const sessionChanges = results[0]?.meta?.changes;
    if (typeof sessionChanges !== "number") {
      throw new Error("D1 insert result has no meta.changes");
    }
    // セッションが書けず（changes=0）、退会中なら再送ではなく退会の競合である。
    if (sessionChanges === 0 && (await hasActiveDeletion(this.db, userId, nowMs))) {
      throw new Error("user deletion is in progress");
    }
    return { alreadyExisted: sessionChanges === 0 };
  }

  async listByUser(userId: string): Promise<ImportSessionView[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, status, imported_by, providers, conversation_count, ignored_count,
                unmapped_candidates, evidence_count, concept_count, created_at, updated_at
         FROM import_sessions WHERE user_id = ?
         ORDER BY created_at DESC, id ASC`,
      )
      .bind(userId)
      .all<ImportSessionRow>();
    return results.map(toImportSessionView);
  }

  async getById(
    userId: string,
    id: string,
  ): Promise<{ session: ImportSessionView; unmappedCandidates: UnmappedCandidate[] } | null> {
    const row = await this.db
      .prepare(
        `SELECT id, status, imported_by, providers, conversation_count, ignored_count,
                unmapped_candidates, evidence_count, concept_count, created_at, updated_at
         FROM import_sessions WHERE user_id = ? AND id = ?`,
      )
      .bind(userId, id)
      .first<ImportSessionRow>();
    if (row === null) return null;
    return { session: toImportSessionView(row), unmappedCandidates: toUnmappedCandidates(row) };
  }

  async undo(
    userId: string,
    sessionId: string,
    updatedAt: string,
  ): Promise<{ status: string; deletedEvidenceCount: number } | null> {
    const current = await this.db
      .prepare(`SELECT status FROM import_sessions WHERE user_id = ? AND id = ?`)
      .bind(userId, sessionId)
      .first<{ status: string }>();
    if (current === null) return null;
    if (current.status === "undone") {
      // Undo の再実行は失敗にしない。応答前に切断された利用者の押し直しを
      // 許容する（learning-data の削除と同じ方針）。
      return { status: "undone", deletedEvidenceCount: 0 };
    }
    if (current.status !== "applied") {
      // scanning / analyzing / ready_for_review / confirmed / failed は
      // サーバーでは applied としてしか作らないが、ドメインの状態機械で
      // undone へ遷移できない状態なら拒否する。黙って消さない。
      return { status: current.status, deletedEvidenceCount: 0 };
    }

    // Evidence の削除と undone への更新を1トランザクションにする。
    // 片方だけ成功すると「消えたのに applied」「applied なのに空」の
    // どちらかの状態が残る。
    const [deleted] = await this.db.batch([
      this.db
        .prepare(`DELETE FROM learning_evidence WHERE user_id = ? AND import_session_id = ?`)
        .bind(userId, sessionId),
      // 競合で状態が動いていたら更新しない。status の条件を WHERE に入れて
      // 「読んだときは applied だった」のに依存しない。
      this.db
        .prepare(
          `UPDATE import_sessions SET status = 'undone', updated_at = ?
           WHERE user_id = ? AND id = ? AND status = 'applied'`,
        )
        .bind(updatedAt, userId, sessionId),
    ]);

    const deletedCount = deleted?.meta?.changes;
    if (typeof deletedCount !== "number") {
      throw new Error("D1 delete result has no meta.changes");
    }
    return { status: "undone", deletedEvidenceCount: deletedCount };
  }

  async deleteAllByUser(userId: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM import_sessions WHERE user_id = ?`)
      .bind(userId)
      .run();
    const changes = result.meta.changes;
    if (typeof changes !== "number") {
      throw new Error("D1 delete result has no meta.changes");
    }
    return changes;
  }
}

/** user_concept_checks の1行。SELECT する列と対応させる。 */
interface PersonalCheckRow {
  concept_id: string;
  scope: string;
  objective_id: string | null;
  level: string;
  body: string;
  model: string;
  generated_at: string;
}

const PERSONAL_CHECK_COLUMNS = "concept_id, scope, objective_id, level, body, model, generated_at";

/**
 * D1 の行を `PersonalConceptCheck` へ戻す。
 *
 * 書き込み時に検証した形しか入らないはずなので、読めなければ DB の破損である。
 * 黙って捨てると、利用者には問題が消えたように見える（RULE-004）。
 */
function toPersonalCheck(row: PersonalCheckRow): PersonalConceptCheck {
  const parsed = parseConceptCheck(row.body, row.concept_id);
  if (!parsed.ok) {
    throw new Error(
      `user_concept_checks contains invalid data (concept_id=${row.concept_id}, reason=${parsed.reason})`,
    );
  }
  if (!(CHECK_SCOPES as readonly string[]).includes(row.scope)) {
    throw new Error(`user_concept_checks.scope is invalid (concept_id=${row.concept_id})`);
  }
  if (!(CHECK_LEVELS as readonly string[]).includes(row.level)) {
    throw new Error(`user_concept_checks.level is invalid (concept_id=${row.concept_id})`);
  }
  if (Number.isNaN(Date.parse(row.generated_at))) {
    throw new Error(`user_concept_checks.generated_at is invalid (concept_id=${row.concept_id})`);
  }
  return {
    ...parsed.check,
    scope: row.scope as CheckScope,
    level: row.level as CheckLevel,
    ...(row.objective_id === null ? {} : { objectiveId: row.objective_id }),
    model: row.model,
    generatedAt: row.generated_at,
  };
}

/**
 * 利用者ごとの確認問題（migrations/0012_user_concept_checks.sql、Issue #236）。
 *
 * 表は `users(id)` を ON DELETE CASCADE で参照する。退会で一緒に消える。
 */
export class D1PersonalCheckRepository implements PersonalCheckRepository {
  constructor(private readonly db: D1Database) {}

  async listByConcept(userId: string, conceptId: string): Promise<PersonalConceptCheck[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${PERSONAL_CHECK_COLUMNS}
         FROM user_concept_checks
         WHERE user_id = ? AND concept_id = ?
         ORDER BY generated_at DESC, target ASC`,
      )
      .bind(userId, conceptId)
      .all<PersonalCheckRow>();
    return results.map(toPersonalCheck);
  }

  async put(
    userId: string,
    check: PersonalConceptCheck,
    startedAtMs: number,
    target?: { mapId: string; origin?: CheckOrigin },
  ): Promise<{ saved: true } | { saved: false; reason: "reset" | "target-removed" }> {
    const { conceptId, overview, practice } = check;
    // 本文は生成時の JSON と同じ形で持つ。読み出しで `parseConceptCheck` をそのまま通せる。
    const body = JSON.stringify({ conceptId, overview, practice });
    const objectiveId = check.objectiveId ?? null;
    // 手で作ったマップのノードなら、ノードと狙った項目がまだあることも同じ文で確かめる。
    const targetExists = `EXISTS (
           SELECT 1 FROM learning_map_nodes n JOIN learning_maps m ON m.id = n.map_id
           WHERE n.map_id = ? AND n.concept_id = ? AND n.is_reference = 0 AND m.owner_user_id = ?
         )
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM learning_objectives WHERE id = ? AND map_id = ? AND concept_id = ?
         ))`;
    // 固定の Concept の項目を狙った組なら、その項目がまだあることを同じ文で確かめる（#245）。
    // 作成者が生成の間に項目を消すと、確定で消した問題が後から書き戻される（PR #293 のレビュー）。
    const fixedObjectiveExists = `EXISTS (
           SELECT 1 FROM learning_objectives WHERE id = ? AND map_id IS NULL AND concept_id = ?
         )`;
    const [guard, guardBindings] =
      target !== undefined
        ? [
            targetExists,
            [target.mapId, conceptId, userId, objectiveId, objectiveId, target.mapId, conceptId],
          ]
        : objectiveId !== null
          ? [fixedObjectiveExists, [objectiveId, conceptId]]
          : [undefined, []];
    const result = await this.db
      .prepare(
        `INSERT INTO user_concept_checks (
           user_id, concept_id, target, scope, objective_id, level, body, model, generated_at, origin
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         -- 生成を始めたあとに学習データが削除されていたら書かない。同じ文の中で判定する。
         WHERE NOT EXISTS (
           SELECT 1 FROM learning_history_resets
           WHERE user_id = ? AND reset_at_ms >= ?
         )
         ${guard === undefined ? "" : `AND ${guard}`}
         ON CONFLICT (user_id, concept_id, target) DO UPDATE SET
           scope = excluded.scope,
           objective_id = excluded.objective_id,
           level = excluded.level,
           body = excluded.body,
           model = excluded.model,
           generated_at = excluded.generated_at,
           origin = excluded.origin`,
      )
      .bind(
        userId,
        conceptId,
        checkTargetOf(check),
        check.scope,
        check.objectiveId ?? null,
        check.level,
        body,
        check.model,
        check.generatedAt,
        target?.origin ?? "on_demand",
        userId,
        startedAtMs,
        ...guardBindings,
      )
      .run();
    const changes = result.meta.changes;
    if (typeof changes !== "number") {
      throw new Error("D1 insert result has no meta.changes");
    }
    if (changes > 0) return { saved: true };
    if (guard === undefined) return { saved: false, reason: "reset" };
    // 書かなかった理由を応答の文面のために分ける。判定は書き込みと同じ文で済んでいるので、
    // ここで読み直した結果が書き込みの可否を左右することはない。
    const exists = await this.db
      .prepare(`SELECT 1 AS found WHERE ${guard}`)
      .bind(...guardBindings)
      .first<{ found: number }>();
    return { saved: false, reason: exists === null ? "target-removed" : "reset" };
  }

  async listMapCreationChecks(userId: string): Promise<PersonalConceptCheck[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${PERSONAL_CHECK_COLUMNS}
         FROM user_concept_checks
         WHERE user_id = ? AND origin = 'map_creation'
         ORDER BY concept_id ASC, target ASC`,
      )
      .bind(userId)
      .all<PersonalCheckRow>();
    return results.map(toPersonalCheck);
  }

  async listAllByUser(userId: string): Promise<PersonalConceptCheck[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${PERSONAL_CHECK_COLUMNS}
         FROM user_concept_checks
         WHERE user_id = ?
         ORDER BY concept_id ASC, target ASC`,
      )
      .bind(userId)
      .all<PersonalCheckRow>();
    return results.map(toPersonalCheck);
  }

  async deleteAllByUser(userId: string): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM user_concept_checks WHERE user_id = ?")
      .bind(userId)
      .run();
    const changes = result.meta.changes;
    if (typeof changes !== "number") {
      throw new Error("D1 delete result has no meta.changes");
    }
    return changes;
  }
}

/** 確認問題の生成への同意（migrations/0012_user_concept_checks.sql、Issue #236）。 */
/**
 * 生成の同意の「今後表示しない」の記録（確認問題 #236、学習マップ #243）。
 * 表の形が同じなので、表の名前だけを変えて使い回す。
 */
class D1GenerationConsentRepository implements CheckGenerationConsentRepository {
  constructor(
    private readonly db: D1Database,
    private readonly table: "check_generation_consents" | "map_generation_consents",
  ) {}

  async get(userId: string): Promise<ConsentRecord | null> {
    const row = await this.db
      .prepare(`SELECT version, granted_at FROM ${this.table} WHERE user_id = ?`)
      .bind(userId)
      .first<{ version: number; granted_at: string }>();
    return row === null ? null : { version: row.version, grantedAt: row.granted_at };
  }

  async put(userId: string, record: ConsentRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ${this.table} (user_id, version, granted_at)
         VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           version = excluded.version,
           granted_at = excluded.granted_at`,
      )
      .bind(userId, record.version, record.grantedAt)
      .run();
  }

  async delete(userId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM ${this.table} WHERE user_id = ?`).bind(userId).run();
  }
}

export class D1CheckGenerationConsentRepository extends D1GenerationConsentRepository {
  constructor(db: D1Database) {
    super(db, "check_generation_consents");
  }
}

/** 学習マップの AI 生成の同意（migrations/0014_map_generation_consents.sql）。 */
export class D1MapGenerationConsentRepository extends D1GenerationConsentRepository {
  constructor(db: D1Database) {
    super(db, "map_generation_consents");
  }
}

/** 作成時の確認問題の技術レベル。表の CHECK で守られているので、外れていたら壊れている。 */
function toCheckLevel(value: string): CheckLevel {
  if (!(CHECK_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`learning_maps.creation_checks_level is invalid: ${value}`);
  }
  return value as CheckLevel;
}

function toCreationChecks(row: LearningMapRow): StoredCreationChecks | null {
  if (row.creation_checks_level === undefined || row.creation_checks_level === null) return null;
  if (typeof row.creation_checks_attempts !== "number") {
    throw new Error(`learning_maps.creation_checks_attempts is missing: ${row.id}`);
  }
  return {
    level: toCheckLevel(row.creation_checks_level),
    attempts: row.creation_checks_attempts,
    doneAt: row.creation_checks_done_at ?? null,
    startedAtMs: row.creation_checks_started_at_ms ?? null,
  };
}

/** learning_maps の1行。 */
interface LearningMapRow {
  id: string;
  title: string;
  description: string;
  visibility: string;
  share_scope: string | null;
  latest_version: number | null;
  source_map_id: string | null;
  source_version: number | null;
  source_key: string | null;
  source_title: string | null;
  source_node_ids: string | null;
  source_latest_version: number | null;
  source_latest_at: string | null;
  /** `get` だけが読む（0019）。 */
  revision?: number;
  share_key?: string | null;
  created_at: string;
  updated_at: string;
  node_count: number;
  /** `get` だけが読む（作成時の確認問題の状態、#247）。 */
  creation_checks_level?: string | null;
  creation_checks_attempts?: number;
  creation_checks_done_at?: string | null;
  creation_checks_started_at_ms?: number | null;
}

interface LearningMapNodeRow {
  concept_id: string;
  is_reference: number;
  label: string | null;
  summary: string | null;
}

interface LearningMapEdgeRow {
  from_concept_id: string;
  to_concept_id: string;
}

interface LearningObjectiveRow {
  id: string;
  concept_id: string;
  label: string;
  source: string;
}

interface OwnMapNodeRow {
  concept_id: string;
  label: string;
  summary: string;
  map_id: string;
  map_title: string;
}

/**
 * 0013 の visibility（private / shared）と 0019 の share_scope を1つの範囲にする。
 * 書く側が両方をそろえる（migrations/0019_learning_map_versions.sql）。食い違えば壊れている。
 */
function toLearningMapVisibility(row: {
  id: string;
  visibility: string;
  share_scope: string | null;
}): LearningMapVisibility {
  if (row.visibility === "private" && row.share_scope === null) return "private";
  if (row.visibility === "shared" && (row.share_scope === "link" || row.share_scope === "public")) {
    return row.share_scope;
  }
  throw new Error(
    `learning_maps.visibility and share_scope disagree: ${row.id} (${row.visibility}, ${String(row.share_scope)})`,
  );
}

/** 鍵は範囲が link のときだけ持つ（0019）。食い違えば壊れている。 */
function toShareKey(row: {
  id: string;
  share_scope: string | null;
  share_key?: string | null;
}): string | null {
  const key = row.share_key ?? null;
  if ((row.share_scope === "link") !== (key !== null)) {
    throw new Error(`learning_maps.share_key disagrees with share_scope: ${row.id}`);
  }
  return key;
}

function requireRevision(row: LearningMapRow): number {
  if (typeof row.revision !== "number") {
    throw new Error(`learning_maps.revision is missing: ${row.id}`);
  }
  return row.revision;
}

/** 手元のマップの書き換えの回数が読んだときのままであることの条件。`?` は map_id, revision。 */
const SAME_REVISION = "(SELECT revision FROM learning_maps WHERE id = ?) = ?";

/** learning_map_versions の1行。 */
interface MapVersionRow {
  version: number;
  content: string;
  content_hash: string;
  author_user_id: string;
  restored_from: number | null;
  checks_included: number;
  summary: string;
  created_at: string;
}

const MAP_VERSION_COLUMNS = `version, content, content_hash, author_user_id, restored_from,
  checks_included, summary, created_at`;

function toMapVersionMeta(row: Omit<MapVersionRow, "content" | "content_hash">): MapVersionMeta {
  let summary: unknown;
  try {
    summary = JSON.parse(row.summary);
  } catch (error) {
    throw new Error(`learning_map_versions.summary is not JSON: ${String(row.version)}`, {
      cause: error,
    });
  }
  if (!isMapVersionSummary(summary)) {
    throw new Error(
      `learning_map_versions.summary has an unexpected shape: ${String(row.version)}`,
    );
  }
  return {
    version: row.version,
    createdAt: row.created_at,
    authorUserId: row.author_user_id,
    restoredFrom: row.restored_from,
    checksIncluded: row.checks_included === 1,
    summary,
  };
}

function isMapVersionSummary(value: unknown): value is MapVersionSummary {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    ["added", "removed", "changed", "checksAdded", "checksRemoved"].every(
      (key) => typeof record[key] === "number",
    ) &&
    typeof record.titleChanged === "boolean" &&
    typeof record.reordered === "boolean"
  );
}

function toStoredMapVersion(row: MapVersionRow): StoredMapVersion {
  return { ...toMapVersionMeta(row), content: row.content, contentHash: row.content_hash };
}

/**
 * 取り込み元の列（0020）。`m` は learning_maps。いちばん新しい版は、元が全員に共有されているか、
 * 取り込んだときの鍵で「リンクだけ」の共有が読めるときだけ引く（#244 の決定 U1）。
 */
const SOURCE_COLUMNS = `m.source_map_id, m.source_version, m.source_key, m.source_title,
  m.source_node_ids,
  (SELECT v.version FROM learning_map_versions v JOIN learning_maps s ON s.id = v.map_id
   WHERE v.map_id = m.source_map_id
     AND (s.share_scope = 'public' OR (s.share_scope = 'link' AND s.share_key = m.source_key))
   ORDER BY v.version DESC LIMIT 1) AS source_latest_version,
  (SELECT v.created_at FROM learning_map_versions v JOIN learning_maps s ON s.id = v.map_id
   WHERE v.map_id = m.source_map_id
     AND (s.share_scope = 'public' OR (s.share_scope = 'link' AND s.share_key = m.source_key))
   ORDER BY v.version DESC LIMIT 1) AS source_latest_at`;

/** 共有の一覧（全員・持ち主）の列。題名・説明・ノード数は版の中身から読む。 */
const SHARED_SUMMARY_COLUMNS = `m.id,
  json_extract(v.content, '$.title') AS title,
  json_extract(v.content, '$.description') AS description,
  json_array_length(v.content, '$.nodes') AS node_count,
  v.version, v.created_at`;

/** そのマップのいちばん新しい版だけを結ぶ。 */
const LATEST_VERSION_JOIN = `JOIN learning_map_versions v
  ON v.map_id = m.id
 AND v.version = (SELECT MAX(version) FROM learning_map_versions WHERE map_id = m.id)`;

interface SharedSummaryRow {
  id: string;
  title: unknown;
  description: unknown;
  node_count: unknown;
  version: number;
  created_at: string;
}

function toSharedMapSummary(row: SharedSummaryRow): SharedMapSummary {
  if (
    typeof row.title !== "string" ||
    typeof row.description !== "string" ||
    typeof row.node_count !== "number"
  ) {
    throw new Error(`learning_map_versions.content has an unexpected shape: ${row.id}`);
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    nodeCount: row.node_count,
    version: row.version,
    publishedAt: row.created_at,
  };
}

function toMapSource(row: LearningMapRow): StoredMapSource | null {
  if (row.source_map_id === null) return null;
  if (
    typeof row.source_version !== "number" ||
    typeof row.source_title !== "string" ||
    typeof row.source_node_ids !== "string"
  ) {
    throw new Error(`learning_maps has an incomplete source: ${row.id}`);
  }
  let nodeIds: unknown;
  try {
    nodeIds = JSON.parse(row.source_node_ids);
  } catch (error) {
    throw new Error(`learning_maps.source_node_ids is not JSON: ${row.id}`, { cause: error });
  }
  if (!Array.isArray(nodeIds) || !nodeIds.every((id) => typeof id === "string")) {
    throw new Error(`learning_maps.source_node_ids has an unexpected shape: ${row.id}`);
  }
  return {
    mapId: row.source_map_id,
    version: row.source_version,
    key: row.source_key,
    title: row.source_title,
    nodeIds,
    latest:
      row.source_latest_version === null || row.source_latest_at === null
        ? null
        : { version: row.source_latest_version, publishedAt: row.source_latest_at },
  };
}

/** マップのいちばん新しい版の番号。`?` は map_id。無ければ NULL。 */
const LATEST_VERSION = "(SELECT MAX(version) FROM learning_map_versions WHERE map_id = ?)";

function toLearningObjective(row: LearningObjectiveRow): StoredLearningObjective {
  if (row.source !== "manual" && row.source !== "ai") {
    throw new Error(`learning_objectives.source has an unknown value: ${row.source}`);
  }
  return { id: row.id, conceptId: row.concept_id, label: row.label, source: row.source };
}

function toStoredMapNode(row: LearningMapNodeRow): StoredMapNode {
  if (row.is_reference === 1) return { kind: "reference", conceptId: row.concept_id };
  // 表の CHECK で、参照でないノードは label・summary を必ず持つ。持たないなら壊れている。
  if (row.label === null || row.summary === null) {
    throw new Error(
      `learning_map_nodes has an own node without label or summary: ${row.concept_id}`,
    );
  }
  return { kind: "own", conceptId: row.concept_id, label: row.label, summary: row.summary };
}

/** Concept ID ごとにまとめる。並びは入力の順を保つ。 */
function groupByConcept<T extends { conceptId: string }>(items: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const list = grouped.get(item.conceptId);
    if (list === undefined) grouped.set(item.conceptId, [item]);
    else list.push(item);
  }
  return grouped;
}

/** batch の1文の結果の行。 */
function rowsOf<T>(result: D1Result | undefined): T[] {
  if (result === undefined) throw new Error("D1 batch returned fewer results than statements");
  return result.results as T[];
}

/** 変更した行数。取れなければ既定値で埋めない（RULE-004）。 */
function changesOf(result: D1Result | undefined): number {
  const changes = result?.meta.changes;
  if (typeof changes !== "number") {
    throw new Error("D1 result has no meta.changes");
  }
  return changes;
}

/**
 * ノードを `json_each` で1文に入れるための JSON。
 * `CAST(key AS INTEGER)` が配列の添字なので、並び（position）は渡した順になる。
 */
function nodesJson(nodes: readonly StoredMapNode[]): string {
  return JSON.stringify(
    nodes.map((node) =>
      node.kind === "own"
        ? { conceptId: node.conceptId, isReference: 0, label: node.label, summary: node.summary }
        : { conceptId: node.conceptId, isReference: 1, label: null, summary: null },
    ),
  );
}

/** 自分のマップであることの条件。`?` は map_id, owner_user_id の順に2つ。 */
const OWNED_MAP = "EXISTS (SELECT 1 FROM learning_maps WHERE id = ? AND owner_user_id = ?)";

/**
 * 自分のマップに、参照ではないそのノードがあることの条件。
 * `?` は map_id, concept_id, owner_user_id の順に3つ。
 */
const OWNED_MAP_NODE = `EXISTS (
  SELECT 1 FROM learning_map_nodes n JOIN learning_maps m ON m.id = n.map_id
  WHERE n.map_id = ? AND n.concept_id = ? AND n.is_reference = 0 AND m.owner_user_id = ?
)`;

/** `?` は map_id, ノードの JSON, map_id, owner_user_id。 */
const INSERT_MAP_NODES = `INSERT INTO learning_map_nodes (map_id, concept_id, is_reference, label, summary, position)
  SELECT ?, json_extract(value, '$.conceptId'), json_extract(value, '$.isReference'),
         json_extract(value, '$.label'), json_extract(value, '$.summary'), CAST(key AS INTEGER)
  FROM json_each(?)
  WHERE ${OWNED_MAP}`;

/**
 * 取り込んだ版の公開の確認問題を写す（0020、#244 の T6）。`?` は map_id, 確認問題の JSON。
 * 呼び出し側が `WHERE` を足す。
 */
const INSERT_IMPORTED_CHECKS = `INSERT INTO imported_map_checks
    (map_id, concept_id, target, scope, objective_id, level, body, model, generated_at)
  SELECT ?, json_extract(value, '$.conceptId'), json_extract(value, '$.target'),
         json_extract(value, '$.scope'), json_extract(value, '$.objectiveId'),
         json_extract(value, '$.level'), json_extract(value, '$.body'),
         json_extract(value, '$.model'), json_extract(value, '$.generatedAt')
  FROM json_each(?)`;

/** 本文は user_concept_checks と同じ形（`parseConceptCheck` をそのまま通せる）。 */
function importedChecksJson(checks: readonly PersonalConceptCheck[]): string {
  return JSON.stringify(
    checks.map((check) => ({
      conceptId: check.conceptId,
      target: checkTargetOf(check),
      scope: check.scope,
      objectiveId: check.objectiveId ?? null,
      level: check.level,
      body: JSON.stringify({
        conceptId: check.conceptId,
        overview: check.overview,
        practice: check.practice,
      }),
      model: check.model,
      generatedAt: check.generatedAt,
    })),
  );
}

/** `?` は map_id, 線の JSON, map_id, owner_user_id。 */
const INSERT_MAP_EDGES = `INSERT INTO learning_map_edges (map_id, from_concept_id, to_concept_id)
  SELECT ?, json_extract(value, '$.from'), json_extract(value, '$.to')
  FROM json_each(?)
  WHERE ${OWNED_MAP}`;

const OWN_MAP_NODE_COLUMNS = `n.concept_id, n.label, n.summary, n.map_id, m.title AS map_title`;

/** 文に足す条件。`sql` の `?` に `binds` を順に当てる。 */
interface SqlGuard {
  sql: string;
  binds: readonly unknown[];
}

const NO_GUARD: SqlGuard = { sql: "1", binds: [] };

export class D1LearningMapRepository implements LearningMapRepository {
  constructor(private readonly db: D1Database) {}

  async create(
    ownerUserId: string,
    params: {
      id: string;
      content: StoredMapContent;
      objectives?: readonly StoredLearningObjective[];
      creationChecksLevel?: CheckLevel;
      nowIso: string;
      nowMs: number;
      maxMaps: number;
    },
  ): Promise<{ created: boolean }> {
    const { id, content } = params;
    // 並び（position）はノードごとに数える。json_each の添字は全体の通し番号なので、ここで振る。
    const positions = new Map<string, number>();
    const objectives = (params.objectives ?? []).map((objective) => {
      const position = positions.get(objective.conceptId) ?? 0;
      positions.set(objective.conceptId, position + 1);
      return { ...objective, position };
    });
    // 数えることと書くことを1文にまとめる。読んでから書くと、同時に作られたときに上限を超える。
    // ノードと線の文は、マップの行が入ったときだけ書く（上限で弾いたら何も書かない）。
    const [inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO learning_maps
             (id, owner_user_id, title, description, visibility, created_at, updated_at, updated_at_ms,
              creation_checks_level)
           SELECT ?, ?, ?, ?, 'private', ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM learning_maps WHERE owner_user_id = ?) < ?`,
        )
        .bind(
          id,
          ownerUserId,
          content.title,
          content.description,
          params.nowIso,
          params.nowIso,
          params.nowMs,
          params.creationChecksLevel ?? null,
          ownerUserId,
          params.maxMaps,
        ),
      this.db.prepare(INSERT_MAP_NODES).bind(id, nodesJson(content.nodes), id, ownerUserId),
      this.db.prepare(INSERT_MAP_EDGES).bind(id, JSON.stringify(content.edges), id, ownerUserId),
      // 項目は (map_id, concept_id) でノードを参照する。無いノードを指せば batch ごと失敗する。
      this.db
        .prepare(
          `INSERT INTO learning_objectives
             (id, concept_id, map_id, label, source, position, created_at, updated_at)
           SELECT json_extract(value, '$.id'), json_extract(value, '$.conceptId'), ?,
                  json_extract(value, '$.label'), json_extract(value, '$.source'),
                  json_extract(value, '$.position'), ?, ?
           FROM json_each(?)
           WHERE ${OWNED_MAP}`,
        )
        .bind(id, params.nowIso, params.nowIso, JSON.stringify(objectives), id, ownerUserId),
    ]);
    return { created: changesOf(inserted) === 1 };
  }

  async listByOwner(ownerUserId: string): Promise<LearningMapSummary[]> {
    const rows = await this.db
      .prepare(
        `SELECT m.id, m.title, m.description, m.visibility, m.share_scope, m.created_at, m.updated_at,
                (SELECT MAX(version) FROM learning_map_versions v WHERE v.map_id = m.id)
                  AS latest_version,
                ${SOURCE_COLUMNS},
                (SELECT COUNT(*) FROM learning_map_nodes n WHERE n.map_id = m.id) AS node_count
         FROM learning_maps m
         WHERE m.owner_user_id = ?
         ORDER BY m.updated_at_ms DESC, m.id ASC`,
      )
      .bind(ownerUserId)
      .all<LearningMapRow>();
    return rows.results.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      visibility: toLearningMapVisibility(row),
      latestVersion: row.latest_version,
      source: toMapSourceView(toMapSource(row)),
      nodeCount: row.node_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async get(ownerUserId: string, mapId: string): Promise<StoredLearningMap | null> {
    // 4つの読み取りを1つの batch にまとめ、途中で書き換わった食い違いを読まない。
    const [map, nodes, edges, objectives] = await this.db.batch([
      this.db
        .prepare(
          `SELECT m.id, m.title, m.description, m.visibility, m.share_scope, m.created_at,
                  m.updated_at, 0 AS node_count,
                  (SELECT MAX(version) FROM learning_map_versions WHERE map_id = ?) AS latest_version,
                  m.revision, m.share_key, ${SOURCE_COLUMNS},
                  m.creation_checks_level, m.creation_checks_attempts, m.creation_checks_done_at,
                  m.creation_checks_started_at_ms
           FROM learning_maps m WHERE m.id = ? AND m.owner_user_id = ?`,
        )
        .bind(mapId, mapId, ownerUserId),
      this.db
        .prepare(
          `SELECT concept_id, is_reference, label, summary FROM learning_map_nodes
           WHERE map_id = ? AND ${OWNED_MAP} ORDER BY position`,
        )
        .bind(mapId, mapId, ownerUserId),
      // 線は並びを持たないので、入れた順（rowid）で返す。
      this.db
        .prepare(
          `SELECT from_concept_id, to_concept_id FROM learning_map_edges
           WHERE map_id = ? AND ${OWNED_MAP} ORDER BY rowid`,
        )
        .bind(mapId, mapId, ownerUserId),
      this.db
        .prepare(
          `SELECT id, concept_id, label, source FROM learning_objectives
           WHERE map_id = ? AND ${OWNED_MAP} ORDER BY concept_id, position`,
        )
        .bind(mapId, mapId, ownerUserId),
    ]);
    const row = rowsOf<LearningMapRow>(map)[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      visibility: toLearningMapVisibility(row),
      latestVersion: row.latest_version,
      revision: requireRevision(row),
      shareKey: toShareKey(row),
      source: toMapSource(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nodes: rowsOf<LearningMapNodeRow>(nodes).map(toStoredMapNode),
      edges: rowsOf<LearningMapEdgeRow>(edges).map((edge) => ({
        from: edge.from_concept_id,
        to: edge.to_concept_id,
      })),
      objectives: groupByConcept(rowsOf<LearningObjectiveRow>(objectives).map(toLearningObjective)),
      creationChecks: toCreationChecks(row),
    };
  }

  async claimCreationChecks(
    ownerUserId: string,
    mapId: string,
    params: { maxAttempts: number; nowMs: number; leaseMs: number },
  ): Promise<CheckLevel | null> {
    // 判定と書き込みを1文で行う。読んでから書くと、同時に2回頼まれたときに両方が通る。
    const row = await this.db
      .prepare(
        `UPDATE learning_maps
         SET creation_checks_attempts = creation_checks_attempts + 1,
             creation_checks_started_at_ms = ?
         WHERE id = ? AND owner_user_id = ?
           AND creation_checks_level IS NOT NULL
           AND creation_checks_done_at IS NULL
           AND creation_checks_attempts < ?
           AND (creation_checks_started_at_ms IS NULL OR creation_checks_started_at_ms <= ?)
         RETURNING creation_checks_level`,
      )
      .bind(params.nowMs, mapId, ownerUserId, params.maxAttempts, params.nowMs - params.leaseMs)
      .first<{ creation_checks_level: string }>();
    if (row === null) return null;
    return toCheckLevel(row.creation_checks_level);
  }

  async releaseCreationChecks(
    ownerUserId: string,
    mapId: string,
    params: { refundAttempt: boolean },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE learning_maps
         SET creation_checks_started_at_ms = NULL,
             creation_checks_attempts = MAX(0, creation_checks_attempts - ?)
         WHERE id = ? AND owner_user_id = ?`,
      )
      .bind(params.refundAttempt ? 1 : 0, mapId, ownerUserId)
      .run();
  }

  async enableCreationChecks(
    ownerUserId: string,
    mapId: string,
    level: CheckLevel,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE learning_maps SET creation_checks_level = ?
         WHERE id = ? AND owner_user_id = ? AND source_map_id IS NOT NULL
           AND (creation_checks_level IS NULL
             OR (creation_checks_attempts = 0 AND creation_checks_done_at IS NULL))`,
      )
      .bind(level, mapId, ownerUserId)
      .run();
    return changesOf(result) === 1;
  }

  async completeCreationChecks(
    ownerUserId: string,
    mapId: string,
    nowIso: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE learning_maps
         SET creation_checks_done_at = ?, creation_checks_started_at_ms = NULL
         WHERE id = ? AND owner_user_id = ?`,
      )
      .bind(nowIso, mapId, ownerUserId)
      .run();
    return changesOf(result) === 1;
  }

  async replace(
    ownerUserId: string,
    mapId: string,
    content: StoredMapContent,
    now: { nowIso: string; nowMs: number },
  ): Promise<boolean> {
    const results = await this.db.batch(
      this.replaceStatements(ownerUserId, mapId, content, now, NO_GUARD),
    );
    return changesOf(results.at(-1)) === 1;
  }

  /**
   * マップの中身を置き換える文。どの文も `guard` が真のときだけ書く（復元では「新しい版を
   * 足せたとき」、取り込み直しでは「読んだときのまま」、#244）。
   *
   * **最後の文が learning_maps の UPDATE** で、書けたら1行変わる。書き換えの回数（revision）を
   * ここで増やすので、`guard` が回数を見ていても、ほかの文はすべて増やす前に判定される。
   */
  private replaceStatements(
    ownerUserId: string,
    mapId: string,
    content: StoredMapContent,
    now: { nowIso: string; nowMs: number },
    guard: SqlGuard,
    extraMapUpdate: SqlGuard = { sql: "", binds: [] },
  ): D1PreparedStatement[] {
    const nodes = nodesJson(content.nodes);
    // ノードを全部消して入れ直さない。消すと、残したノードの「理解すること」まで
    // CASCADE で消える。送られなかったノードだけを消し、残りは上書きする。
    return [
      // 外すノードの確認問題を、ノードを消す前に消す（#242、2026-10-07 の決定）。
      // user_concept_checks はノードを参照していないので、CASCADE では消えない。
      this.db
        .prepare(
          `DELETE FROM user_concept_checks
           WHERE user_id = ? AND ${OWNED_MAP} AND ${guard.sql}
             AND concept_id IN (
               SELECT concept_id FROM learning_map_nodes
               WHERE map_id = ? AND is_reference = 0
                 AND concept_id NOT IN (
                   SELECT json_extract(value, '$.conceptId') FROM json_each(?)
                 )
             )`,
        )
        .bind(ownerUserId, mapId, ownerUserId, ...guard.binds, mapId, nodes),
      this.db
        .prepare(
          `DELETE FROM learning_map_edges WHERE map_id = ? AND ${OWNED_MAP} AND ${guard.sql}`,
        )
        .bind(mapId, mapId, ownerUserId, ...guard.binds),
      this.db
        .prepare(
          `DELETE FROM learning_map_nodes
           WHERE map_id = ? AND ${OWNED_MAP} AND ${guard.sql}
             AND concept_id NOT IN (SELECT json_extract(value, '$.conceptId') FROM json_each(?))`,
        )
        .bind(mapId, mapId, ownerUserId, ...guard.binds, nodes),
      // SELECT の WHERE は、SELECT と ON CONFLICT の構文の曖昧さを避けるためにも要る（SQLite の upsert）。
      this.db
        .prepare(
          `${INSERT_MAP_NODES} AND ${guard.sql}
           ON CONFLICT (map_id, concept_id) DO UPDATE SET
             is_reference = excluded.is_reference,
             label = excluded.label,
             summary = excluded.summary,
             position = excluded.position`,
        )
        .bind(mapId, nodes, mapId, ownerUserId, ...guard.binds),
      this.db
        .prepare(`${INSERT_MAP_EDGES} AND ${guard.sql}`)
        .bind(mapId, JSON.stringify(content.edges), mapId, ownerUserId, ...guard.binds),
      this.db
        .prepare(
          `UPDATE learning_maps
           SET title = ?, description = ?, updated_at = ?, updated_at_ms = ?,
               revision = revision + 1${extraMapUpdate.sql}
           WHERE id = ? AND owner_user_id = ? AND ${guard.sql}`,
        )
        .bind(
          content.title,
          content.description,
          now.nowIso,
          now.nowMs,
          ...extraMapUpdate.binds,
          mapId,
          ownerUserId,
          ...guard.binds,
        ),
    ];
  }

  /**
   * 参照ではないノードの「理解すること」を全部置き換える文（復元・取り込み直し、#244）。
   * ノードを入れ終えた後に並べること（項目はノードを (map_id, concept_id) で参照する）。
   * 消える項目を狙った自分の確認問題も消す（replaceObjectives と同じ。消えるノードの分は
   * replaceStatements が消す）。
   */
  private replaceAllObjectivesStatements(
    ownerUserId: string,
    mapId: string,
    objectives: readonly StoredLearningObjective[],
    nowIso: string,
    guard: SqlGuard,
  ): D1PreparedStatement[] {
    const positions = new Map<string, number>();
    const json = JSON.stringify(
      objectives.map((objective) => {
        const position = positions.get(objective.conceptId) ?? 0;
        positions.set(objective.conceptId, position + 1);
        return { ...objective, position };
      }),
    );
    return [
      this.db
        .prepare(
          `DELETE FROM user_concept_checks
           WHERE user_id = ? AND ${guard.sql}
             AND objective_id IS NOT NULL
             AND concept_id IN (
               SELECT concept_id FROM learning_map_nodes WHERE map_id = ? AND is_reference = 0
             )
             AND objective_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
        )
        .bind(ownerUserId, ...guard.binds, mapId, json),
      this.db
        .prepare(
          `DELETE FROM learning_objectives
           WHERE map_id = ? AND ${guard.sql}
             AND id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
        )
        .bind(mapId, ...guard.binds, json),
      // ID が同じマップの別のノードの項目と重なったら、concept_id に NULL を入れようとして
      // NOT NULL 制約で文ごと失敗させる（書き飛ばすと、上の DELETE だけが確定する。
      // replaceFixedObjectives と同じ考え方）。別のマップの項目とは重ならない（0020 で
      // マップ＋項目 ID で一意にした）。
      this.db
        .prepare(
          `INSERT INTO learning_objectives
             (id, concept_id, map_id, label, source, position, created_at, updated_at)
           SELECT json_extract(value, '$.id'), json_extract(value, '$.conceptId'), ?,
                  json_extract(value, '$.label'), json_extract(value, '$.source'),
                  json_extract(value, '$.position'), ?, ?
           FROM json_each(?)
           WHERE ${guard.sql}
           ON CONFLICT (map_id, id) WHERE map_id IS NOT NULL DO UPDATE SET
             concept_id = CASE
               WHEN learning_objectives.concept_id = excluded.concept_id
               THEN excluded.concept_id
             END,
             label = excluded.label,
             source = excluded.source,
             position = excluded.position,
             updated_at = excluded.updated_at`,
        )
        .bind(mapId, nowIso, nowIso, json, ...guard.binds),
    ];
  }

  async publishVersion(
    ownerUserId: string,
    mapId: string,
    params: {
      expectedLatest: number | null;
      expectedRevision: number;
      scope: ShareScope;
      shareKey: string | null;
      content: string;
      contentHash: string;
      checksIncluded: boolean;
      summary: MapVersionSummary;
      nowIso: string;
      nowMs: number;
    },
  ): Promise<boolean> {
    const version = (params.expectedLatest ?? 0) + 1;
    // いちばん新しい版が読んだときのままなら足す。判定と書き込みを1文にまとめる。
    // 範囲の切り替えは、この版が足せたときだけ行う（同じ batch の中なので、版の番号・時刻・
    // ハッシュが一致する行はこの文が足したものに限られる）。
    const [inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO learning_map_versions
             (map_id, version, content, content_hash, author_user_id, restored_from,
              checks_included, summary, created_at, created_at_ms)
           SELECT ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?
           WHERE ${OWNED_MAP} AND ${LATEST_VERSION} IS ? AND ${SAME_REVISION}`,
        )
        .bind(
          mapId,
          version,
          params.content,
          params.contentHash,
          ownerUserId,
          params.checksIncluded ? 1 : 0,
          JSON.stringify(params.summary),
          params.nowIso,
          params.nowMs,
          mapId,
          ownerUserId,
          mapId,
          params.expectedLatest,
          mapId,
          params.expectedRevision,
        ),
      this.db
        .prepare(
          `UPDATE learning_maps SET visibility = 'shared', share_scope = ?, share_key = ?
           WHERE id = ? AND owner_user_id = ?
             AND EXISTS (
               SELECT 1 FROM learning_map_versions
               WHERE map_id = ? AND version = ? AND created_at_ms = ? AND content_hash = ?
                 AND restored_from IS NULL
             )`,
        )
        .bind(
          params.scope,
          params.shareKey,
          mapId,
          ownerUserId,
          mapId,
          version,
          params.nowMs,
          params.contentHash,
        ),
    ]);
    return changesOf(inserted) === 1;
  }

  async setShareScope(
    ownerUserId: string,
    mapId: string,
    scope: ShareScope | null,
    shareKey: string | null,
  ): Promise<boolean> {
    // 共有へ切り替えるのは、版が1つ以上あるときだけ（中身を確かめずに出さない、S1-a）。
    const result = await this.db
      .prepare(
        `UPDATE learning_maps
         SET visibility = CASE WHEN ? IS NULL THEN 'private' ELSE 'shared' END,
             share_scope = ?, share_key = ?
         WHERE id = ? AND owner_user_id = ?
           AND (? IS NULL OR ${LATEST_VERSION} IS NOT NULL)`,
      )
      .bind(scope, scope, shareKey, mapId, ownerUserId, scope, mapId)
      .run();
    return changesOf(result) === 1;
  }

  async listVersions(ownerUserId: string, mapId: string): Promise<MapVersionMeta[] | null> {
    const [map, versions] = await this.db.batch([
      this.db
        .prepare("SELECT id FROM learning_maps WHERE id = ? AND owner_user_id = ?")
        .bind(mapId, ownerUserId),
      this.db
        .prepare(
          `SELECT version, author_user_id, restored_from, checks_included, summary, created_at
           FROM learning_map_versions
           WHERE map_id = ? AND ${OWNED_MAP}
           ORDER BY version DESC`,
        )
        .bind(mapId, mapId, ownerUserId),
    ]);
    if (rowsOf<{ id: string }>(map).length === 0) return null;
    return rowsOf<Omit<MapVersionRow, "content" | "content_hash">>(versions).map(toMapVersionMeta);
  }

  async getVersion(
    ownerUserId: string,
    mapId: string,
    version: number,
  ): Promise<StoredMapVersion | null> {
    const row = await this.db
      .prepare(
        `SELECT ${MAP_VERSION_COLUMNS} FROM learning_map_versions
         WHERE map_id = ? AND version = ? AND ${OWNED_MAP}`,
      )
      .bind(mapId, version, mapId, ownerUserId)
      .first<MapVersionRow>();
    return row === null ? null : toStoredMapVersion(row);
  }

  async restoreVersion(
    ownerUserId: string,
    mapId: string,
    params: {
      fromVersion: number;
      expectedLatest: number;
      expectedRevision: number;
      content: StoredMapContent;
      objectives: readonly StoredLearningObjective[];
      summary: MapVersionSummary;
      nowIso: string;
      nowMs: number;
    },
  ): Promise<boolean> {
    const version = params.expectedLatest + 1;
    // 新しい版を足せたときだけ、手元のマップを書き換える。足した行は版の番号・時刻・元の版で見分ける
    // （同じ batch の中で、ほかにこの組の行を足すものは無い）。
    const restored: SqlGuard = {
      sql: `EXISTS (
        SELECT 1 FROM learning_map_versions
        WHERE map_id = ? AND version = ? AND created_at_ms = ? AND restored_from = ?
      )`,
      binds: [mapId, version, params.nowMs, params.fromVersion],
    };
    const [inserted] = await this.db.batch([
      // 中身・ハッシュ・確認問題を含めたかは元の版のまま写す。
      this.db
        .prepare(
          `INSERT INTO learning_map_versions
             (map_id, version, content, content_hash, author_user_id, restored_from,
              checks_included, summary, created_at, created_at_ms)
           SELECT map_id, ?, content, content_hash, ?, version, checks_included, ?, ?, ?
           FROM learning_map_versions
           WHERE map_id = ? AND version = ? AND ${OWNED_MAP} AND ${LATEST_VERSION} = ?
             AND ${SAME_REVISION}`,
        )
        .bind(
          version,
          ownerUserId,
          JSON.stringify(params.summary),
          params.nowIso,
          params.nowMs,
          mapId,
          params.fromVersion,
          mapId,
          ownerUserId,
          mapId,
          params.expectedLatest,
          mapId,
          params.expectedRevision,
        ),
      ...this.replaceStatements(ownerUserId, mapId, params.content, params, restored),
      ...this.replaceAllObjectivesStatements(
        ownerUserId,
        mapId,
        params.objectives,
        params.nowIso,
        restored,
      ),
    ]);
    return changesOf(inserted) === 1;
  }

  async createImported(
    ownerUserId: string,
    params: {
      id: string;
      content: StoredMapContent;
      objectives: readonly StoredLearningObjective[];
      source: MapSourceInput;
      checks: readonly PersonalConceptCheck[];
      nowIso: string;
      nowMs: number;
      maxMaps: number;
    },
  ): Promise<boolean> {
    const { id, content, source } = params;
    const positions = new Map<string, number>();
    const objectives = params.objectives.map((objective) => {
      const position = positions.get(objective.conceptId) ?? 0;
      positions.set(objective.conceptId, position + 1);
      return { ...objective, position };
    });
    // 数える・確かめることと書くことを1文にまとめる（create と同じ）。マップの行が入ったときだけ、
    // ほかの文が書く（どれも OWNED_MAP を条件にしている）。
    const [inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO learning_maps
             (id, owner_user_id, title, description, visibility, created_at, updated_at, updated_at_ms,
              source_map_id, source_version, source_key, source_title, source_node_ids)
           SELECT ?, ?, ?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM learning_maps WHERE owner_user_id = ?) < ?
             AND NOT EXISTS (
               SELECT 1 FROM learning_maps WHERE owner_user_id = ? AND source_map_id = ?
             )`,
        )
        .bind(
          id,
          ownerUserId,
          content.title,
          content.description,
          params.nowIso,
          params.nowIso,
          params.nowMs,
          source.mapId,
          source.version,
          source.key,
          source.title,
          JSON.stringify(source.nodeIds),
          ownerUserId,
          params.maxMaps,
          ownerUserId,
          source.mapId,
        ),
      this.db.prepare(INSERT_MAP_NODES).bind(id, nodesJson(content.nodes), id, ownerUserId),
      this.db.prepare(INSERT_MAP_EDGES).bind(id, JSON.stringify(content.edges), id, ownerUserId),
      this.db
        .prepare(
          `INSERT INTO learning_objectives
             (id, concept_id, map_id, label, source, position, created_at, updated_at)
           SELECT json_extract(value, '$.id'), json_extract(value, '$.conceptId'), ?,
                  json_extract(value, '$.label'), json_extract(value, '$.source'),
                  json_extract(value, '$.position'), ?, ?
           FROM json_each(?)
           WHERE ${OWNED_MAP}`,
        )
        .bind(id, params.nowIso, params.nowIso, JSON.stringify(objectives), id, ownerUserId),
      this.db
        .prepare(`${INSERT_IMPORTED_CHECKS} WHERE ${OWNED_MAP}`)
        .bind(id, importedChecksJson(params.checks), id, ownerUserId),
    ]);
    return changesOf(inserted) === 1;
  }

  async reimport(
    ownerUserId: string,
    mapId: string,
    params: {
      expectedSourceVersion: number;
      expectedRevision: number;
      source: { version: number; nodeIds: readonly string[] };
      content: StoredMapContent;
      objectives: readonly StoredLearningObjective[];
      checks: readonly PersonalConceptCheck[];
      nowIso: string;
      nowMs: number;
    },
  ): Promise<boolean> {
    // 取り込んだ版と書き換えの回数が読んだときのままなら書く。どちらも最後の UPDATE（replaceStatements の
    // 末尾）まで変わらないので、すべての文が同じ判定になる。
    const unchanged: SqlGuard = {
      sql: `EXISTS (
        SELECT 1 FROM learning_maps
        WHERE id = ? AND owner_user_id = ? AND source_version = ? AND revision = ?
      )`,
      binds: [mapId, ownerUserId, params.expectedSourceVersion, params.expectedRevision],
    };
    const results = await this.db.batch([
      this.db
        .prepare(`DELETE FROM imported_map_checks WHERE map_id = ? AND ${unchanged.sql}`)
        .bind(mapId, ...unchanged.binds),
      this.db
        .prepare(`${INSERT_IMPORTED_CHECKS} WHERE ${unchanged.sql}`)
        .bind(mapId, importedChecksJson(params.checks), ...unchanged.binds),
      // 項目の文はノードを入れ終えてから、マップの行の UPDATE（回数を増やす）より前に並べる。
      ...this.replaceStatements(ownerUserId, mapId, params.content, params, unchanged).slice(0, -1),
      ...this.replaceAllObjectivesStatements(
        ownerUserId,
        mapId,
        params.objectives,
        params.nowIso,
        unchanged,
      ),
      ...this.replaceStatements(ownerUserId, mapId, params.content, params, unchanged, {
        sql: ", source_version = ?, source_node_ids = ?",
        binds: [params.source.version, JSON.stringify(params.source.nodeIds)],
      }).slice(-1),
    ]);
    return changesOf(results.at(-1)) === 1;
  }

  async listImportedChecksByConcept(
    ownerUserId: string,
    conceptId: string,
  ): Promise<PersonalConceptCheck[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.concept_id, c.scope, c.objective_id, c.level, c.body, c.model, c.generated_at
         FROM imported_map_checks c
         JOIN learning_maps m ON m.id = c.map_id
         JOIN learning_map_nodes n
           ON n.map_id = c.map_id AND n.concept_id = c.concept_id AND n.is_reference = 0
         WHERE m.owner_user_id = ? AND c.concept_id = ?
           AND (c.objective_id IS NULL OR EXISTS (
             SELECT 1 FROM learning_objectives o
             WHERE o.map_id = c.map_id AND o.concept_id = c.concept_id AND o.id = c.objective_id
           ))
         ORDER BY c.target ASC`,
      )
      .bind(ownerUserId, conceptId)
      .all<PersonalCheckRow>();
    return results.map(toPersonalCheck);
  }

  async listImportedChecks(ownerUserId: string, mapId: string): Promise<PersonalConceptCheck[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${PERSONAL_CHECK_COLUMNS} FROM imported_map_checks
         WHERE map_id = ? AND ${OWNED_MAP}
         ORDER BY concept_id ASC, target ASC`,
      )
      .bind(mapId, mapId, ownerUserId)
      .all<PersonalCheckRow>();
    return results.map(toPersonalCheck);
  }

  async getSharedVersion(
    mapId: string,
    version: number,
    key: string | null,
  ): Promise<StoredMapVersion | null> {
    // 読めるか（範囲と鍵）を、版を読むのと同じ文で確かめる。先に確かめてから読むと、
    // その間に共有をやめられても中身を返してしまう（PR #295 のレビュー）。
    const row = await this.db
      .prepare(
        `SELECT ${MAP_VERSION_COLUMNS} FROM learning_map_versions
         WHERE map_id = ? AND version = ?
           AND EXISTS (
             SELECT 1 FROM learning_maps s
             WHERE s.id = ?
               AND (s.share_scope = 'public' OR (s.share_scope = 'link' AND s.share_key = ?))
           )`,
      )
      .bind(mapId, version, mapId, key)
      .first<MapVersionRow>();
    return row === null ? null : toStoredMapVersion(row);
  }

  async getShared(mapId: string): Promise<StoredSharedMap | null> {
    const [map, latest] = await this.db.batch([
      this.db
        .prepare(
          `SELECT id, owner_user_id, visibility, share_scope, share_key
           FROM learning_maps WHERE id = ?`,
        )
        .bind(mapId),
      this.db
        .prepare(
          `SELECT ${MAP_VERSION_COLUMNS} FROM learning_map_versions
           WHERE map_id = ? ORDER BY version DESC LIMIT 1`,
        )
        .bind(mapId),
    ]);
    const row = rowsOf<{
      id: string;
      owner_user_id: string;
      visibility: string;
      share_scope: string | null;
      share_key: string | null;
    }>(map)[0];
    if (row === undefined) return null;
    const version = rowsOf<MapVersionRow>(latest)[0];
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      visibility: toLearningMapVisibility(row),
      shareKey: toShareKey(row),
      latest: version === undefined ? null : toStoredMapVersion(version),
    };
  }

  async listPublic(limit: number, excludeOwnerUserId?: string): Promise<SharedMapSummary[]> {
    // 題名・説明・ノード数は、手元ではなく共有の側（いちばん新しい版の中身）から読む。
    const { results } = await this.db
      .prepare(
        `SELECT ${SHARED_SUMMARY_COLUMNS}
         FROM learning_maps m
         ${LATEST_VERSION_JOIN}
         WHERE m.share_scope = 'public' AND (? IS NULL OR m.owner_user_id <> ?)
         ORDER BY v.created_at_ms DESC, m.id ASC
         LIMIT ?`,
      )
      .bind(excludeOwnerUserId ?? null, excludeOwnerUserId ?? null, limit)
      .all<SharedSummaryRow>();
    return results.map(toSharedMapSummary);
  }

  async listSharedByOwner(ownerUserId: string): Promise<OwnSharedMapSummary[]> {
    // 全員の一覧と同じく、題名・説明・ノード数は共有の側の版から読む（PR #304 のレビュー）。
    const { results } = await this.db
      .prepare(
        `SELECT ${SHARED_SUMMARY_COLUMNS}, m.visibility, m.share_scope
         FROM learning_maps m
         ${LATEST_VERSION_JOIN}
         WHERE m.owner_user_id = ? AND m.share_scope IS NOT NULL
         ORDER BY v.created_at_ms DESC, m.id ASC`,
      )
      .bind(ownerUserId)
      .all<SharedSummaryRow & { visibility: string; share_scope: string | null }>();
    return results.map((row) => {
      const visibility = toLearningMapVisibility(row);
      // share_scope IS NOT NULL で選んでいるので private は来ない。来たら壊れている。
      if (visibility === "private") throw new Error(`shared map is private: ${row.id}`);
      return { ...toSharedMapSummary(row), visibility };
    });
  }

  async delete(ownerUserId: string, mapId: string): Promise<boolean> {
    // ノード・線・項目は外部キーの ON DELETE CASCADE で消える。確認問題はノードを
    // 参照していないので、マップを消す前に同じ batch で消す（#242、2026-10-07 の決定）。
    const [, deleted] = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM user_concept_checks
           WHERE user_id = ? AND ${OWNED_MAP}
             AND concept_id IN (
               SELECT concept_id FROM learning_map_nodes WHERE map_id = ? AND is_reference = 0
             )`,
        )
        .bind(ownerUserId, mapId, ownerUserId, mapId),
      this.db
        .prepare("DELETE FROM learning_maps WHERE id = ? AND owner_user_id = ?")
        .bind(mapId, ownerUserId),
    ]);
    return changesOf(deleted) === 1;
  }

  async replaceObjectives(
    ownerUserId: string,
    params: {
      mapId: string;
      conceptId: string;
      objectives: readonly { id: string; label: string; source: LearningObjectiveSource }[];
      nowIso: string;
      nowMs: number;
    },
  ): Promise<boolean> {
    const { mapId, conceptId } = params;
    const objectives = JSON.stringify(params.objectives);
    const ownedNode = [mapId, conceptId, ownerUserId];
    // どの文も「自分のマップの、参照ではないそのノード」があるときだけ書く。batch は1つの
    // トランザクションなので、最初の UPDATE が1行変えたなら、残りの文も同じノードを見ている。
    const [touched] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE learning_maps SET updated_at = ?, updated_at_ms = ?, revision = revision + 1
           WHERE id = ? AND ${OWNED_MAP_NODE}`,
        )
        .bind(params.nowIso, params.nowMs, mapId, ...ownedNode),
      // 外す項目を狙った確認問題を消す（#242、2026-10-07 の決定）。
      this.db
        .prepare(
          `DELETE FROM user_concept_checks
           WHERE user_id = ? AND concept_id = ? AND ${OWNED_MAP_NODE}
             AND objective_id IS NOT NULL
             AND objective_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
        )
        .bind(ownerUserId, conceptId, ...ownedNode, objectives),
      this.db
        .prepare(
          `DELETE FROM learning_objectives
           WHERE map_id = ? AND concept_id = ? AND ${OWNED_MAP_NODE}
             AND id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
        )
        .bind(mapId, conceptId, ...ownedNode, objectives),
      // 作った時刻は最初に入れたときのまま残す。
      this.db
        .prepare(
          `INSERT INTO learning_objectives
             (id, concept_id, map_id, label, source, position, created_at, updated_at)
           SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.label'),
                  json_extract(value, '$.source'), CAST(key AS INTEGER), ?, ?
           FROM json_each(?)
           WHERE ${OWNED_MAP_NODE}
           ON CONFLICT (map_id, id) WHERE map_id IS NOT NULL DO UPDATE SET
             label = excluded.label,
             source = excluded.source,
             position = excluded.position,
             updated_at = excluded.updated_at
           WHERE learning_objectives.concept_id = excluded.concept_id`,
        )
        .bind(conceptId, mapId, params.nowIso, params.nowIso, objectives, ...ownedNode),
    ]);
    return changesOf(touched) === 1;
  }

  async findOwnNodes(
    ownerUserId: string,
    conceptIds: readonly string[],
  ): Promise<StoredOwnMapNode[]> {
    if (conceptIds.length === 0) return [];
    const rows = await this.db
      .prepare(
        `SELECT ${OWN_MAP_NODE_COLUMNS}
         FROM learning_map_nodes n JOIN learning_maps m ON m.id = n.map_id
         WHERE m.owner_user_id = ? AND n.is_reference = 0
           AND n.concept_id IN (SELECT value FROM json_each(?))
         ORDER BY m.updated_at_ms DESC, m.id ASC, n.position`,
      )
      .bind(ownerUserId, JSON.stringify(conceptIds))
      .all<OwnMapNodeRow>();
    return this.withEdgesAndObjectives(rows.results);
  }

  async listFixedObjectives(): Promise<StoredLearningObjective[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, concept_id, label, source FROM learning_objectives
         WHERE map_id IS NULL
         ORDER BY concept_id, position`,
      )
      .all<LearningObjectiveRow>();
    return rows.results.map(toLearningObjective);
  }

  async getFixedObjectives(
    conceptId: string,
  ): Promise<{ objectives: StoredLearningObjective[]; revision: string | null }> {
    // 項目と版を同じトランザクションで読む。別々に読むと、間の置き換えで版と項目が食い違う。
    const [objectives, revision] = await this.db.batch([
      this.db
        .prepare(
          `SELECT id, concept_id, label, source FROM learning_objectives
           WHERE map_id IS NULL AND concept_id = ?
           ORDER BY position`,
        )
        .bind(conceptId),
      this.db
        .prepare(`SELECT revision FROM fixed_objective_revisions WHERE concept_id = ?`)
        .bind(conceptId),
    ]);
    return {
      objectives: rowsOf<LearningObjectiveRow>(objectives).map(toLearningObjective),
      revision: rowsOf<{ revision: string }>(revision)[0]?.revision ?? null,
    };
  }

  async replaceFixedObjectives(params: {
    conceptId: string;
    expectedRevision: string | null;
    revision: string;
    objectives: readonly { id: string; label: string; source: LearningObjectiveSource }[];
    nowIso: string;
  }): Promise<boolean> {
    const { conceptId, nowIso, revision } = params;
    const objectives = JSON.stringify(params.objectives);
    // 版を進められた（読んだときの版のままだった）ときだけ、残りの文が書く。
    // 最初の文で版をこの書き込みの値にするので、残りの文はその値かどうかで判定できる。
    const claimed = `EXISTS (
      SELECT 1 FROM fixed_objective_revisions WHERE concept_id = ? AND revision = ?
    )`;
    // 1つの batch（トランザクション）で書く。途中で失敗しても、項目と確認問題が食い違わない。
    const [advanced, , , written] = await this.db.batch([
      // 行が無ければ（まだ一度も置き換えていない）入れる。あれば、読んだときの版のときだけ進める。
      this.db
        .prepare(
          `INSERT INTO fixed_objective_revisions (concept_id, revision) VALUES (?, ?)
           ON CONFLICT (concept_id) DO UPDATE SET revision = excluded.revision
           WHERE fixed_objective_revisions.revision IS ?`,
        )
        .bind(conceptId, revision, params.expectedRevision),
      // 外す項目を狙った確認問題を、全利用者の分消す。
      this.db
        .prepare(
          `DELETE FROM user_concept_checks
           WHERE concept_id = ? AND objective_id IS NOT NULL
             AND objective_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?))
             AND ${claimed}`,
        )
        .bind(conceptId, objectives, conceptId, revision),
      this.db
        .prepare(
          `DELETE FROM learning_objectives
           WHERE map_id IS NULL AND concept_id = ?
             AND id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?))
             AND ${claimed}`,
        )
        .bind(conceptId, objectives, conceptId, revision),
      // 作った時刻は最初に入れたときのまま残す。
      // ID が他の Concept の項目と重なったら、concept_id に NULL を入れようとして
      // NOT NULL 制約で文ごと失敗させる。batch ごと巻き戻るので、上の2つの DELETE も残らない
      // （ON CONFLICT の WHERE で書き飛ばすと、DELETE だけが確定して項目が消える）。
      // SELECT の WHERE は、SELECT と ON CONFLICT の構文の曖昧さを避けるためにも要る（SQLite の upsert）。
      this.db
        .prepare(
          `INSERT INTO learning_objectives
             (id, concept_id, map_id, label, source, position, created_at, updated_at)
           SELECT json_extract(value, '$.id'), ?, NULL, json_extract(value, '$.label'),
                  json_extract(value, '$.source'), CAST(key AS INTEGER), ?, ?
           FROM json_each(?)
           WHERE ${claimed}
           ON CONFLICT (id) WHERE map_id IS NULL DO UPDATE SET
             concept_id = CASE
               WHEN learning_objectives.concept_id = excluded.concept_id
               THEN excluded.concept_id
             END,
             label = excluded.label,
             source = excluded.source,
             position = excluded.position,
             updated_at = excluded.updated_at`,
        )
        .bind(conceptId, nowIso, nowIso, objectives, conceptId, revision),
    ]);
    // 読んだあとに別の置き換えが入った。どの文も書いていない。
    if (changesOf(advanced) === 0) return false;
    // 書けなかった項目を「保存した」と返さない（RULE-004）。
    if (changesOf(written) !== params.objectives.length) {
      throw new Error(`fixed objectives were not all written: ${conceptId}`);
    }
    return true;
  }

  async listOwnNodes(ownerUserId: string, limit: number): Promise<StoredOwnMapNode[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${OWN_MAP_NODE_COLUMNS}
         FROM learning_map_nodes n JOIN learning_maps m ON m.id = n.map_id
         WHERE m.owner_user_id = ? AND n.is_reference = 0
         ORDER BY m.updated_at_ms DESC, m.id ASC, n.position
         LIMIT ?`,
      )
      .bind(ownerUserId, limit)
      .all<OwnMapNodeRow>();
    return this.withEdgesAndObjectives(rows.results);
  }

  /**
   * ノードに前提と項目を付ける。
   *
   * 線は (map_id, concept_id) の組で引く。参照のノードは元のノードと同じ concept_id で
   * 別のマップに置かれるので、ID だけで引くと、別のマップで参照に引いた線が
   * 元のノードの前提に混ざる。項目も同じ組で引く（取り込んだマップは元と同じ ID を持つ、#244）。
   */
  private async withEdgesAndObjectives(
    rows: readonly OwnMapNodeRow[],
  ): Promise<StoredOwnMapNode[]> {
    if (rows.length === 0) return [];
    const nodes = JSON.stringify(
      rows.map((row) => ({ mapId: row.map_id, conceptId: row.concept_id })),
    );
    const [edges, objectives] = await this.db.batch([
      this.db
        .prepare(
          `SELECT e.map_id, e.from_concept_id, e.to_concept_id
           FROM learning_map_edges e
           JOIN json_each(?) j
             ON e.map_id = json_extract(j.value, '$.mapId')
            AND e.to_concept_id = json_extract(j.value, '$.conceptId')
           ORDER BY e.rowid`,
        )
        .bind(nodes),
      // 項目も (map_id, concept_id) の組で引く。取り込んだマップ（#244）は元のマップと同じ
      // Concept ID・項目 ID を持つので、ID だけで引くと他人のマップの項目が混ざる。
      this.db
        .prepare(
          `SELECT o.map_id, o.id, o.concept_id, o.label, o.source
           FROM learning_objectives o
           JOIN json_each(?) j
             ON o.map_id = json_extract(j.value, '$.mapId')
            AND o.concept_id = json_extract(j.value, '$.conceptId')
           ORDER BY o.concept_id, o.position`,
        )
        .bind(nodes),
    ]);
    // 組み合わせるときも (map_id, concept_id) で突き合わせる。取り込んだマップは元と同じ
    // Concept ID を持つので、ID だけで束ねると、別のマップの線・項目が混ざりうる（PR #295 のレビュー）。
    const keyOf = (mapId: string, conceptId: string) => `${mapId}\n${conceptId}`;
    const prerequisites = new Map<string, string[]>();
    for (const edge of rowsOf<LearningMapEdgeRow & { map_id: string }>(edges)) {
      const key = keyOf(edge.map_id, edge.to_concept_id);
      prerequisites.set(key, [...(prerequisites.get(key) ?? []), edge.from_concept_id]);
    }
    const objectivesByNode = new Map<string, StoredLearningObjective[]>();
    for (const row of rowsOf<LearningObjectiveRow & { map_id: string }>(objectives)) {
      const key = keyOf(row.map_id, row.concept_id);
      objectivesByNode.set(key, [...(objectivesByNode.get(key) ?? []), toLearningObjective(row)]);
    }
    return rows.map((row) => ({
      conceptId: row.concept_id,
      label: row.label,
      summary: row.summary,
      mapId: row.map_id,
      mapTitle: row.map_title,
      prerequisites: prerequisites.get(keyOf(row.map_id, row.concept_id)) ?? [],
      objectives: objectivesByNode.get(keyOf(row.map_id, row.concept_id)) ?? [],
    }));
  }
}
