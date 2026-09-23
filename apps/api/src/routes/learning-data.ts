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
import type { LearningEventRepository } from "../repository/types.js";

export interface LearningDataDeps {
  events: LearningEventRepository;
  /** 現在時刻を ISO 8601 で返す。テストで固定できるよう注入する。 */
  nowIso: () => string;
}

/** {@link SyncDepsResolver} と同じ理由で、依存はリクエスト時に解決する。 */
export type LearningDataDepsResolver = (env: CloudflareBindings) => LearningDataDeps;

/** `DELETE /v1/learning-events` の応答。 */
export interface DeleteLearningEventsResponse {
  /** 消したイベントの件数。既に空なら 0。 */
  deletedCount: number;
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
    const deletedCount = await deps.events.deleteByUser(userId);

    const body: DeleteLearningEventsResponse = { deletedCount };
    return c.json(body);
  });

  return app;
}
