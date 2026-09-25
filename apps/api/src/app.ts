import { Hono } from "hono";
import { CONCEPTS } from "@gakushu-sochi/domain";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requireAuth, type AuthVariables } from "./auth/middleware.js";
import { rateLimit } from "./auth/rate-limit.js";
import {
  D1AiUsageRepository,
  D1AreaCompletionRepository,
  D1AuditLogRepository,
  D1IdentityRepository,
  D1LearningEventRepository,
  D1MasteryOverrideRepository,
  D1UserSettingsRepository,
} from "./repository/d1.js";
import { createLearningEventsRoute } from "./routes/learning-events.js";
import { createLearningProfileRoute } from "./routes/learning-profile.js";
import { createLearningDataRoute } from "./routes/learning-data.js";
import { createLearningActivityRoute } from "./routes/learning-activity.js";
import { createAiRoute } from "./routes/ai.js";
import { createAccountRoute } from "./routes/account.js";
import { createManagementUsers } from "./auth/management.js";
import { createAreaCompletionsRoute } from "./routes/area-completions.js";
import { createMasteryOverridesRoute } from "./routes/mastery-overrides.js";
import { createUserSettingsRoute } from "./routes/user-settings.js";

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
  return cors({ origin: origins, allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] })(
    c,
    next,
  );
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
// 学習データのエクスポートと削除（#79）。どちらも利用者の明示的な操作でしか
// 呼ばれず、頻度の想定は Profile より低い。エクスポートは全件を読むため、
// 叩き放題にすると D1 の読み取りを食い潰せる。
app.use(
  "/v1/learning-events:export",
  rateLimit((env) => env.PROFILE_RATE_LIMITER),
);
app.use(
  "/v1/learning-events",
  rateLimit((env) => env.PROFILE_RATE_LIMITER),
);
app.use(
  "/v1/learning-activity",
  rateLimit((env) => env.PROFILE_RATE_LIMITER),
);
app.use(
  "/v1/mastery-overrides",
  rateLimit((env) => env.MASTERY_OVERRIDE_RATE_LIMITER),
);
// 分野コンプリートの判定（#178）。地図を開くたびに 1 回叩かれ、全イベントを読んで
// 導出する。頻度も重さも Profile と同じ性質なので同じ上限を使う。
app.use(
  "/v1/area-completions:check",
  rateLimit((env) => env.PROFILE_RATE_LIMITER),
);
// 設定の保存も利用者の操作ごとに1回書き込む。手動上書きと頻度の性質が同じなので
// 同じ上限を使う。設定のためだけに新しい namespace を増やさない。
app.use(
  "/v1/user-settings",
  rateLimit((env) => env.MASTERY_OVERRIDE_RATE_LIMITER),
);
// AIは外部プロバイダのコストが発生するため、Profileと同じユーザー単位の
// レート制限を適用する。認証後に実行されるため userId で数えられる。
app.use(
  "/v1/ai/responses",
  rateLimit((env) => env.PROFILE_RATE_LIMITER),
);
// 利用量の読み取り（#165）。設定画面を開くたびに D1 を1回読む。頻度の性質は
// Profile と同じなので同じ上限を使う。
app.use(
  "/v1/ai/usage",
  rateLimit((env) => env.PROFILE_RATE_LIMITER),
);
// 退会は Auth0 の Management API を呼ぶ。Auth0 側にもレート制限があるため、
// 認証済みであっても叩き放題にしない。頻度の想定は Profile より遥かに低い。
app.use(
  "/v1/me",
  rateLimit((env) => env.PROFILE_RATE_LIMITER),
);

app.route(
  "/v1",
  createAiRoute((env) => ({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    fetch: (input, init) => globalThis.fetch(input, init),
    // 利用量は D1 に置く。退会が `DELETE FROM users` 1文で全データを消せる
    // という前提を崩さないため（migrations/0004_ai_usage.sql）。
    usage: new D1AiUsageRepository(env.DB),
    identity: new D1IdentityRepository(env.DB),
    now: () => new Date(),
  })),
);

// 確認問題の生成（#184、`routes/checks.ts`）はここへ繋がない。
//
// 歯止めの本体は「保存済みの問題があれば生成しない」であり、**それを実装するのは #185** である。
// 生成だけを先に開けると、`ai_usage` の回数上限の外で毎回生成が走る経路になる。
// #185 の D1 キャッシュと同時に `app.route` し、そのとき `app.test.ts` の
// 「公開しない」テストを書き換える。レート制限はルート側が自分で掛けている
// （繋いでいないルートの上限をここへ置くと、参照先の無い設定になるため）。

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
  createAreaCompletionsRoute((env) => ({
    identity: new D1IdentityRepository(env.DB),
    events: new D1LearningEventRepository(env.DB),
    overrides: new D1MasteryOverrideRepository(env.DB),
    completions: new D1AreaCompletionRepository(env.DB),
    // 定義は生成物の全件。テストだけが小さな一覧へ差し替える。
    definitions: CONCEPTS,
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  })),
);

app.route(
  "/v1",
  createLearningDataRoute((env) => ({
    identity: new D1IdentityRepository(env.DB),
    events: new D1LearningEventRepository(env.DB),
    audit: new D1AuditLogRepository(env.DB),
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  })),
);

app.route(
  "/v1",
  createLearningActivityRoute((env) => ({
    events: new D1LearningEventRepository(env.DB),
    now: () => new Date(),
  })),
);

// 退会。D1 の削除と Auth0 の削除の順序は route 側が固定する（docs/auth.md §8）。
app.route(
  "/v1",
  createAccountRoute((env) => ({
    identity: new D1IdentityRepository(env.DB),
    idp: createManagementUsers({
      issuer: env.AUTH_ISSUER,
      clientId: env.AUTH_MANAGEMENT_CLIENT_ID,
      clientSecret: env.AUTH_MANAGEMENT_CLIENT_SECRET,
      fetch: (input, init) => globalThis.fetch(input, init),
    }),
  })),
);

app.route(
  "/v1",
  createMasteryOverridesRoute((env) => ({
    identity: new D1IdentityRepository(env.DB),
    repository: new D1MasteryOverrideRepository(env.DB),
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  })),
);

app.route(
  "/v1",
  createUserSettingsRoute((env) => ({
    identity: new D1IdentityRepository(env.DB),
    repository: new D1UserSettingsRepository(env.DB),
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  })),
);
