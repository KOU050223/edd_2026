/**
 * 認証済みユーザー単位のレート制限。
 *
 * 認証を通ったトークンであっても、同期 API への大量書き込みや Profile の
 * 全イベント再導出を無制限に実行できてはならない。D1 と Worker の可用性・
 * コストに直結する。
 *
 * IP ではなく userId で数える。IP は NAT の内側で共有されるため、同じ職場の
 * 別の利用者を巻き添えにする。逆に IP は変えられるので、上限の回避も容易である。
 */

import type { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AuthVariables } from "./middleware.js";

/**
 * 指定したレート制限バインディングを、認証済みの userId 単位で適用する。
 *
 * 認証ミドルウェアより後に置く必要がある。userId が決まっていないと
 * 誰の分として数えるかが定まらない。
 */
export function rateLimit(selectLimiter: (env: CloudflareBindings) => RateLimit) {
  return createMiddleware<{
    Bindings: CloudflareBindings;
    Variables: AuthVariables;
  }>(async (c, next) => {
    const limiter = selectLimiter(c.env);

    // バインディングが無ければ素通りさせず落とす。「設定が無いから無制限」は、
    // 設定漏れがそのまま制限の解除になる。認証トークンの扱いと同じ方針。
    if (limiter === undefined) {
      throw new HTTPException(500, { message: "rate limiter is not configured" });
    }

    const { success } = await limiter.limit({ key: c.get("user").userId });
    if (!success) {
      // 到達数は監視指標の1つ（docs/api-ops.md「監視・監査ログ・障害時の再送」）。
      // 429 の応答だけではどの経路で誰が止まったかがダッシュボードから読めないため、
      // 構造化ログへ残す。
      console.warn("rate limit reached", {
        path: c.req.path,
        userId: c.get("user").userId,
      });
      throw new HTTPException(429, { message: "too many requests" });
    }

    await next();
  });
}

/**
 * 学習マップ（#242）・共有マップ（#244）・言語別マップ（#245）の経路を `MAP_RATE_LIMITER` で数える（#299）。
 *
 * どれも画面を開くたびに読み、共有・取り込みの操作では画面を何度も行き来する。Profile と同じ枠
 * （1 分 30 回）では、ふつうの操作で上限に届いた。全イベントを導出する Profile より軽いので別枠にする。
 * 生成の口（`learning-maps:generate` など）も含む。AI の回数は `ai_usage` が別に数える。
 *
 * 生成の同意の口（`/v1/map-generation-consent`）はこの前置きに当たらないので、
 * `routes/learning-maps.ts` が同じ枠で数える。
 */
export function useMapRateLimit(
  app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>,
) {
  for (const path of ["/v1/learning-maps*", "/v1/shared-maps*", "/v1/fixed-maps*"]) {
    app.use(
      path,
      rateLimit((env) => env.MAP_RATE_LIMITER),
    );
  }
}
