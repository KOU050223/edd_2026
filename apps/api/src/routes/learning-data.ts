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
import type { IdentityRepository, LearningEventRepository } from "../repository/types.js";

export interface LearningDataDeps {
  identity: IdentityRepository;
  events: LearningEventRepository;
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

    const body: DeleteLearningEventsResponse = { deletedCount, resetAtMs };
    return c.json(body);
  });

  return app;
}
