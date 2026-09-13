/**
 * 認証の継ぎ目。
 *
 * docs/architecture.md は VS Code の端末認可に OAuth Device Authorization Flow を
 * 使うと定めているが、それは Identity の責務として独立して実装する。ここでは
 * 「リクエストから認証済みの userId を決める」という一点だけを引き受け、
 * 学習ドメインのハンドラ（sync / profile）がトークンの形式に依存しないようにする。
 *
 * 検証方式は Auth0 のアクセストークン（JWT）である。`createAuth` が本番の経路で、
 * userId には IdP の `sub` をそのまま使う。可変なメールアドレスを主キーにしない。
 *
 * `devAuth` は開発用の共有トークンを検証する古い経路で、もう組み立てられていない。
 * 削除は全クライアントの疎通確認後（Auth/06）に行う。
 */

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import {
  Auth0Verifier,
  AuthVerificationError,
  noopJwksCache,
  type AuthVerifier,
  type JwksCache,
} from "./verifier.js";

/** 認証済みの主体。ハンドラはこれ以外から userId を得てはならない。 */
export interface AuthenticatedUser {
  userId: string;
}

export interface AuthVariables {
  user: AuthenticatedUser;
}

/**
 * `Authorization: Bearer <token>` からトークンを取り出す。
 *
 * 形式が違うものは受け付けない。`Bearer` を省いた生のトークンを許すと、
 * 認証方式を差し替えるときに古い形式が残っているかどうかを判定できなくなる。
 */
function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1];
}

/**
 * 開発用トークンを検証するミドルウェア。**現在は組み立てられていない。**
 *
 * `app.ts` が使うのは `createAuth` である。これを残しているのは、古い共有トークンを
 * 送るクライアントの疎通確認が済むまで（Auth/06）参照を消さないためであって、
 * `createAuth` の代わりに使ってよいという意味ではない。
 *
 * `DEV_AUTH_TOKEN` が未設定なら、認証を素通りさせず 500 で落とす。
 * 「設定が無いから全員通す」は、本番で秘密の設定漏れがそのまま
 * 認証の無効化になる。設定漏れは機能の停止として現れるべきである。
 *
 * userId はトークンから決める。リクエストボディの `clientId` は
 * クライアントの自己申告であり、認可の入力にしてはならない。
 */
export const devAuth = createMiddleware<{
  Bindings: CloudflareBindings;
  Variables: AuthVariables;
}>(async (c, next) => {
  const expected = c.env.DEV_AUTH_TOKEN;
  if (!expected) {
    throw new HTTPException(500, { message: "DEV_AUTH_TOKEN is not configured" });
  }

  const token = extractBearerToken(c.req.header("Authorization"));
  if (token === undefined) {
    throw new HTTPException(401, { message: "Authorization: Bearer <token> is required" });
  }

  if (!timingSafeEqual(token, expected)) {
    throw new HTTPException(401, { message: "invalid token" });
  }

  // 開発用トークンは単一ユーザーを表す。実際の認証方式ではトークンから
  // ユーザーを解決する。
  c.set("user", { userId: c.env.DEV_AUTH_USER_ID || "dev-user" });

  await next();
});

/**
 * 文字列を定数時間で比較する。
 *
 * 通常の `===` は先頭から違う位置で打ち切るため、比較にかかる時間から
 * トークンを1文字ずつ推測できる。認証に使う比較では長さの違いも含めて
 * 早期に返さない。
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // 長さが違えば不一致だが、その事実だけで早期に返すと長さが漏れる。
  // 同じ長さのバッファ同士を必ず最後まで比較する。
  const length = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Auth0 のアクセストークンを検証するミドルウェアを組み立てる。
 *
 * 検証の実体は他のルート（`createLearningEventsRoute` など）と同じく注入する。
 * こうすることで `test:unit` が素の vitest のまま（Worker ランタイム無し）で通る。
 * 検証器そのものをテストするための2つ目の継ぎ目は `verifier.ts` の側にある
 * （docs/auth.md §4）。
 *
 * 失敗の扱いを1か所に集める。トークンが不正なら 401、こちらの設定が欠けていれば
 * 500、Auth0 へ到達できなければ 503 とし、どれも黙って通さない。
 * 「設定が無いから全員通す」は、設定漏れがそのまま認証の無効化になる。
 */
export function createAuth(resolve: (env: CloudflareBindings) => AuthVerifier) {
  return createMiddleware<{
    Bindings: CloudflareBindings;
    Variables: AuthVariables;
  }>(async (c, next) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (token === undefined) {
      throw new HTTPException(401, { message: "Authorization: Bearer <token> is required" });
    }

    const verifier = resolve(c.env);

    let verified;
    try {
      verified = await verifier.verify(token);
    } catch (error) {
      throw toHttpException(error, c.req.path);
    }

    c.set("user", { userId: verified.sub });

    await next();
  });
}

/**
 * 検証の失敗を HTTP の応答へ変換する。
 *
 * 種別を潰さない。設定漏れや Auth0 への到達不能を 401 に丸めると、利用者には
 * 「トークンが不正」として現れ、障害の原因が見えなくなる
 * （.agents/rules/rules.md RULE-004）。利用者へ返すのは種別だけにし、
 * 原因は握りつぶさずログへ出す。
 */
function toHttpException(error: unknown, path: string): HTTPException {
  if (error instanceof AuthVerificationError) {
    if (error.kind === "invalid_token") {
      return new HTTPException(401, { message: "invalid token" });
    }

    console.error("authentication is unavailable", {
      kind: error.kind,
      message: error.message,
      cause: error.cause,
      path,
    });
    return error.kind === "configuration"
      ? new HTTPException(500, { message: "authentication is not configured" })
      : new HTTPException(503, { message: "authentication is temporarily unavailable" });
  }

  console.error("unexpected authentication failure", { error, path });
  return new HTTPException(500, { message: "authentication failed" });
}

/**
 * 設定から Auth0 の検証器を組み立て、認証ミドルウェアとして使う。
 *
 * `app.ts` の組み立てを1行に保つための入口である。§4 が
 * 「変わるのはこの組み立て1行だけ」と定めているので、検証器の生成・使い回し・
 * キャッシュの選択はすべてこちら側に置く。
 */
export const requireAuth = createAuth((env) => resolveVerifier(env));

/**
 * 検証器を設定ごとに使い回す。
 *
 * Discovery の結果と取り込んだ公開鍵は検証器のインスタンスが持つ。リクエストごとに
 * 作り直すと、そのたび Auth0 へ取りに行くことになる（docs/auth.md §10.4 は
 * これをコスト要件として禁じている）。
 *
 * 鍵は `env` オブジェクトではなく設定の値にする。`env` の同一性が保たれるかは
 * ランタイムの実装に依存するが、issuer と audience が同じなら検証器は等価である、
 * というのはこちらで保証できる性質である。設定は数種類しか無いので増え続けない。
 */
const verifiers = new Map<string, Auth0Verifier>();

function resolveVerifier(env: CloudflareBindings): Auth0Verifier {
  const issuer = env.AUTH_ISSUER;
  const audience = env.AUTH_AUDIENCE;

  // 設定が欠けていたら素通りさせず落とす。値の妥当性（https か、許可したホストか）は
  // 検証器の側で確かめる（docs/auth.md §4）。
  if (!issuer || !audience) {
    throw new AuthVerificationError(
      "configuration",
      "AUTH_ISSUER and AUTH_AUDIENCE are not configured",
    );
  }

  const key = `${issuer}|${audience}`;
  const cached = verifiers.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const verifier = new Auth0Verifier({
    issuer,
    audience,
    fetch: (input, init) => globalThis.fetch(input, init),
    // JWKS は Cache API へ置く。取得の回数を抑えるのはコスト要件である
    // （docs/auth.md §10.4）。`caches` を持たない環境では保存しない。
    cache: cacheApiJwksCache() ?? noopJwksCache,
  });
  verifiers.set(key, verifier);
  return verifier;
}

/**
 * Workers の Cache API を JWKS のキャッシュとして使う。持たない環境では undefined。
 *
 * `caches.default` は Workers 固有で、tsconfig の `lib` が持つ標準の `CacheStorage`
 * には無い。`lib` を緩める代わりに、この1か所だけ Workers の形を明示する。
 */
function cacheApiJwksCache(): JwksCache | undefined {
  if (typeof caches === "undefined") {
    return undefined;
  }
  const store = (caches as unknown as { default: Cache }).default;
  return {
    match: (key: string) => store.match(key),
    put: (key: string, response: Response) => store.put(key, response),
  };
}
