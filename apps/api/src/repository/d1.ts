/**
 * `LearningEventRepository` の D1 実装。
 *
 * SQL とドメイン型の変換をここに閉じ込める。`conceptIds` が JSON 文字列であること、
 * 発生時刻が2列であることは、この外へ漏らさない。
 */

import type { LearningEvent, LearningEventType, EventOrigin } from "@gakushu-sochi/domain";
import type {
  AppendResult,
  IdentityRepository,
  LearningEventRepository,
  MasteryOverride,
  MasteryOverrideRepository,
  StoredEventInput,
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

    const statement = this.db.prepare(
      `INSERT INTO learning_events (
         id, user_id, occurred_at, occurred_at_ms, type, origin, concept_ids,
         language, diagnostic_code, session_id, client_id, received_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      ),
    );

    // batch は SQL トランザクションであり、1文でも失敗すると全件がロールバックされる
    // （ローカル D1 で確認済み: FK 違反を1件混ぜると、同じバッチの正常な行も残らない）。
    // ここでは想定内の失敗は ON CONFLICT DO NOTHING で吸収され、残る失敗は
    // 呼び出し前に ensureUserAndDevice を通していない場合の FK 違反のような
    // 実装の誤りだけになる。部分的に書けた状態を作らないため、その場合は
    // バッチ全体を失敗させたままにする。
    const results = await this.db.batch(bound);

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

  async ensureUserAndDevice(params: {
    userId: string;
    clientId: string;
    nowMs: number;
  }): Promise<void> {
    const { userId, clientId, nowMs } = params;

    // users を先に入れる。devices と learning_events の両方が users(id) を
    // 参照しているため、順序を逆にすると外部キー制約で落ちる。
    await this.db.batch([
      this.db
        .prepare(`INSERT INTO users (id, created_at_ms) VALUES (?, ?) ON CONFLICT (id) DO NOTHING`)
        .bind(userId, nowMs),
      this.db
        .prepare(
          `INSERT INTO devices (user_id, client_id, created_at_ms, last_seen_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, client_id) DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms`,
        )
        .bind(userId, clientId, nowMs, nowMs),
    ]);
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
      await this.db
        .prepare(
          `INSERT INTO mastery_overrides (user_id, concept_id, status, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, concept_id) DO UPDATE SET
             status = excluded.status,
             updated_at = excluded.updated_at`,
        )
        .bind(userId, conceptId, status, updatedAt)
        .run();
    }
    return this.listByUser(userId);
  }
}
