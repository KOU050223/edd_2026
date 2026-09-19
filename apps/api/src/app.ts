import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requireAuth, type AuthVariables } from "./auth/middleware.js";
import { rateLimit } from "./auth/rate-limit.js";
import { D1IdentityRepository, D1LearningEventRepository } from "./repository/d1.js";
import { createLearningEventsRoute } from "./routes/learning-events.js";
import { createLearningProfileRoute } from "./routes/learning-profile.js";
import { createLearningActivityRoute } from "./routes/learning-activity.js";
import { createAiRoute } from "./routes/ai.js";

/** Cloudflare Worker から提供する HTTP API。 */
export const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

/**
 * 例外を型付きの応答へ変換する。
 *
 * 例外の内容をそのまま本文へ載せない。エラーメッセージにはイベントの中身や
 * SQL の断片が混ざりうるため、利用者へ返すのは種別だけにする。
 * ただし握りつぶさない。500 を返したうえで、原因を追える形で必ずログへ出す。
 */
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }

  console.error("unhandled error", {
    message: err.message,
    stack: err.stack,
    path: c.req.path,
  });
  return c.json({ error: "internal server error" }, 500);
});

/** Worker とデプロイの稼働確認に使う。認証を要求しない。 */
app.get("/health", (context) => context.json({ status: "ok" }));

/**
 * Web App からの利用を想定した CORS。
 *
 * VS Code Extension は同一生成元の制約を受けないため、これは apps/web のための設定である。
 * 許可する生成元は設定で与え、`*` を既定にしない。認証付きの API で生成元を
 * 無制限にすると、利用者がアクセスした任意のサイトから、その利用者の学習履歴を
 * 読める余地を残す。未設定なら誰も許可しない（ブラウザからは使えない）。
 */
app.use("/v1/*", (c, next) => {
  const configured = c.env.CORS_ALLOWED_ORIGINS;
  const origins = configured
    ? configured
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    : [];
  return cors({ origin: origins, allowMethods: ["GET", "POST", "OPTIONS"] })(c, next);
});

app.use("/v1/*", requireAuth);

// レート制限は認証の後に置く。userId が決まっていないと誰の分として
// 数えるかが定まらない。エンドポイントごとに上限が違うため、
// /v1/* へ一括では適用しない。
app.use(
  "/v1/learning-events:sync",
  rateLimit((env) => env.SYNC_RATE_LIMITER),
);
app.use(
  "/v1/learning-profile",
  rateLimit((env) => env.PROFILE_RATE_LIMITER),
);
app.use(
  "/v1/learning-activity",
  rateLimit((env) => env.PROFILE_RATE_LIMITER),
);
// AIは外部プロバイダのコストが発生するため、Profileと同じユーザー単位の
// レート制限を適用する。認証後に実行されるため userId で数えられる。
app.use(
  "/v1/ai/responses",
  rateLimit((env) => env.PROFILE_RATE_LIMITER),
);

app.route(
  "/v1",
  createAiRoute((env) => ({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    fetch: (input, init) => globalThis.fetch(input, init),
  })),
);

/**
 * Repository の実体を D1 に結び付ける唯一の場所。
 *
 * Bindings はリクエストごとに渡るため、依存を組み立てられるのもリクエスト時である。
 * ハンドラは interface しか知らないので、テストではインメモリ実装を挿して
 * Worker ランタイム無しで動かせる。
 */
app.route(
  "/v1",
  createLearningEventsRoute((env) => ({
    identity: new D1IdentityRepository(env.DB),
    events: new D1LearningEventRepository(env.DB),
    now: () => Date.now(),
  })),
);

app.route(
  "/v1",
  createLearningProfileRoute((env) => ({
    events: new D1LearningEventRepository(env.DB),
    nowIso: () => new Date().toISOString(),
  })),
);

app.route(
  "/v1",
  createLearningActivityRoute((env) => ({
    events: new D1LearningEventRepository(env.DB),
    now: () => new Date(),
  })),
);
