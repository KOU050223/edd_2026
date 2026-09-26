/**
 * 学習データのエクスポートと削除（Issue #79）。
 *
 * - `GET /v1/learning-events:export`: 自分の学習イベントを `LearnerProfile` の形で返す。
 * - `DELETE /v1/learning-events`: 自分の学習イベントを全件消す。
 *
 * アカウントを保持したまま学習データだけを取り出す／消す経路である。
 * アカウントごと消す退会は `DELETE /v1/me`（routes/account.ts）が持つ。
 *
 * 対象は `c.get("user").userId` だけから決める。パスにもボディにも userId を取らない。
 * 他人のデータを指定できる入力を最初から持たないことで、認可の分岐を作らない。
 */

import { Hono } from "hono";
import {
  LEARNER_PROFILE_VERSION,
  deriveMasteryFromEvents,
  type LearnerProfile,
} from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import type {
  AuditLogRepository,
  ConversationRepository,
  IdentityRepository,
  ImportSessionRepository,
  LearningEventRepository,
  LearningEvidenceRepository,
} from "../repository/types.js";

export interface LearningDataDeps {
  identity: IdentityRepository;
  events: LearningEventRepository;
  /**
   * 外部履歴由来の Evidence（Issue #157）。学習履歴の削除では
   * LearningEvent と一緒に消す。「履歴を消したのに Map 上の触れた形跡が
   * 残る」状態を作らないためである。
   */
  evidence: LearningEvidenceRepository;
  sessions: ImportSessionRepository;
  /**
   * 質問履歴（Issue #204）。学習履歴の削除では会話も一緒に消す。
   * 「学習データを消したのに質問履歴が残る」状態を作らないためである。
   * 削除時刻の境界（learning_history_resets）を会話へは広げない。
   * 遅延した upsert が削除直後に会話を書き戻しうる既知の限界は
   * docs/conversation-history.md「保存期間と既知の限界」で受け入れている。
   */
  conversations: ConversationRepository;
  /** 監査ログ（Issue #122）。エクスポートと削除を「誰がいつ何をしたか」として残す。 */
  audit: AuditLogRepository;
  /** 現在時刻を ISO 8601 で返す。テストで固定できるよう注入する。 */
  nowIso: () => string;
  /** 現在時刻（epoch ミリ秒）。削除時刻の記録に使う。テストで固定できるよう注入する。 */
  nowMs: () => number;
}

/** {@link SyncDepsResolver} と同じ理由で、依存はリクエスト時に解決する。 */
export type LearningDataDepsResolver = (env: CloudflareBindings) => LearningDataDeps;

/** `DELETE /v1/learning-events` の応答。 */
export interface DeleteLearningEventsResponse {
  /** 消したイベントの件数。既に空なら 0。 */
  deletedCount: number;
  /** 一緒に消した外部履歴由来の Evidence の件数（Issue #157）。 */
  deletedEvidenceCount: number;
  /** 一緒に消した Import Session の件数。 */
  deletedSessionCount: number;
  /** 一緒に消した会話履歴の件数（Issue #204）。 */
  deletedConversationCount: number;
  /**
   * `learning_history_resets` へ記録した削除時刻（epoch ミリ秒）。
   *
   * 呼んだ端末はこの値を「適用済みの削除時刻」として記憶する。同期応答の
   * `historyResetAtMs` と比較して、自分が呼んだ削除を「他端末から見えた削除」
   * として二重に処理しないためである（Issue #124）。
   */
  resetAtMs: number;
}

export function createLearningDataRoute(resolve: LearningDataDepsResolver) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  app.get("/learning-events:export", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);

    // 監査ログの audit_log.user_id は users(id) を参照する。まだ一度も
    // 同期していない利用者でも記録できるよう、先に行を用意する。
    // 退会のトゥームストーンが残っている間は ensureUser が失敗し 500 になる。
    // 退会済みアカウントのエクスポートが拒否されるのは意図した挙動である
    // （docs/api-ops.md「監視・監査ログ・障害時の再送」）。
    await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });
    const events = await deps.events.listByUser(userId);

    // 独自形式を作らず、VS Code 拡張が globalState に持つ `LearnerProfile` と
    // 同じ形で返す。再取り込みできることに意味がある（Issue #79）。
    // 習熟度はイベントから導出した値であり、保存値ではない。
    const body: LearnerProfile = {
      version: LEARNER_PROFILE_VERSION,
      updatedAt: deps.nowIso(),
      mastery: deriveMasteryFromEvents(events),
      events,
    };
    await deps.audit.record({
      userId,
      action: "learning_events.exported",
      occurredAtMs: deps.nowMs(),
      detail: { eventCount: events.length },
    });
    // 学習履歴を中間のキャッシュに残さない。
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  app.delete("/learning-events", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);

    // 削除時刻の記録は users 行を参照する（D1 の外部キー）。まだ一度も同期していない
    // 利用者でも、その最初の同期が並行して走っている可能性があるため、行を用意して
    // から必ず時刻を記録する。行が無いからといって記録を省くと、その同期が削除後に書き込む。
    await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });

    // 時刻は ensureUser の後で取り直す。Workers の Date.now() は I/O を挟むまで進まないため、
    // 先に取った値を使うと、その間に受け取った同期を境界の外へ取りこぼす。
    const deletedCount = await deps.events.deleteByUser(userId, deps.nowMs());
    // 外部履歴由来のデータも一緒に消す。残すと「履歴を消した」のに
    // Familiarity が Map 上に残り、利用者には消えたように見えない（Issue #157）。
    const deletedEvidenceCount = await deps.evidence.deleteAllByUser(userId);
    const deletedSessionCount = await deps.sessions.deleteAllByUser(userId);
    // 質問履歴も消す。オプトインで保存した本文データが「学習データを消した」
    // あとに残ると、利用者から見て削除が約束どおり働いていない（Issue #204）。
    const deletedConversationCount = await deps.conversations.deleteAllByUser(userId);

    await deps.audit.record({
      userId,
      action: "learning_events.deleted",
      occurredAtMs: deps.nowMs(),
      detail: {
        deletedCount,
        deletedEvidenceCount,
        deletedSessionCount,
        deletedConversationCount,
      },
    });

    // 応答には記録後の実効値を返す。deleteByUser は既存の削除時刻を
    // 巻き戻さない（MAX を取る）ため、時計の逆行などで要求時刻より新しい値が
    // 残っている場合がある。要求時刻を返すとクライアントが古い「適用済み」を
    // 記録し、次回同期で自分が呼んだ削除へ再度追従してしまう。
    const resetAtMs = await deps.events.latestResetAtMs(userId);
    if (resetAtMs === null) {
      // deleteByUser の直後に読めないのはリポジトリの不整合。要求時刻で
      // 埋めると削除時刻が他端末へ伝わらないままになるため握らない。
      // deleteByUser は冪等なので、失敗と返して再実行してもらう。
      throw new Error("履歴の削除時刻が記録されていません");
    }

    const body: DeleteLearningEventsResponse = {
      deletedCount,
      deletedEvidenceCount,
      deletedSessionCount,
      deletedConversationCount,
      resetAtMs,
    };
    return c.json(body);
  });

  return app;
}
