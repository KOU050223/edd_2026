import { expect, test } from "vitest";
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  OAuthTokenError,
  randomState,
  refreshAccessToken,
  revokeRefreshToken,
  type OAuthConfig,
} from "./oauth.js";

const config: OAuthConfig = {
  issuer: "https://idp.example.test/",
  clientId: "web-client",
  clientSecret: "web-secret",
  audience: "https://api.example.test",
};

const base64Url = (value: string) =>
  btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const jwtWith = (payload: object) =>
  `${base64Url(JSON.stringify({ alg: "RS256" }))}.${base64Url(JSON.stringify(payload))}.sig`;

test("PKCE の challenge は verifier の SHA-256 を base64url で表したもの", async () => {
  const pair = await createPkcePair();

  expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pair.verifier));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  expect(pair.challenge).toBe(expected);
});

test("state は毎回違う値になる", () => {
  const values = new Set(Array.from({ length: 20 }, () => randomState()));

  expect(values.size).toBe(20);
  for (const value of values) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("認可 URL に offline_access と audience を載せる", () => {
  const url = new URL(
    buildAuthorizationUrl(config, "https://web.example.test/callback", "st", "ch"),
  );

  expect(url.origin + url.pathname).toBe("https://idp.example.test/authorize");
  expect(url.searchParams.get("scope")?.split(" ")).toContain("offline_access");
  expect(url.searchParams.get("audience")).toBe("https://api.example.test");
  expect(url.searchParams.get("state")).toBe("st");
  expect(url.searchParams.get("code_challenge")).toBe("ch");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  // 秘密は認可 URL に載せない（ブラウザのアドレスバーと履歴に残る）。
  expect(url.search).not.toContain("web-secret");
});

test("トークンの取得は資格情報を載せるのでリダイレクトを追跡せず、締め切りを設ける", async () => {
  let init: RequestInit | undefined;
  await exchangeAuthorizationCode(
    config,
    "code",
    "https://web.example.test/callback",
    "verifier",
    async (_input, options) => {
      init = options;
      return Response.json({
        access_token: jwtWith({ sub: "auth0|alice" }),
        refresh_token: "rt-1",
        expires_in: 900,
      });
    },
  );

  // RULE-002 / RULE-001。
  expect(init?.redirect).toBe("error");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});

test("アクセストークンの sub を読んでセッションへ渡す", async () => {
  const tokens = await exchangeAuthorizationCode(
    config,
    "code",
    "https://web.example.test/callback",
    "verifier",
    async () =>
      Response.json({
        access_token: jwtWith({ sub: "auth0|alice", aud: "https://api.example.test" }),
        refresh_token: "rt-1",
        expires_in: 900,
      }),
  );

  expect(tokens.sub).toBe("auth0|alice");
  expect(tokens.refreshToken).toBe("rt-1");
  expect(tokens.expiresInSeconds).toBe(900);
});

test("sub の無いアクセストークンは失敗として扱う", async () => {
  await expect(
    exchangeAuthorizationCode(config, "code", "https://web.example.test/callback", "v", async () =>
      Response.json({ access_token: jwtWith({ aud: "x" }), refresh_token: "rt-1" }),
    ),
  ).rejects.toThrow(/sub/);
});

test("JWT の形をしていないアクセストークンは失敗として扱う", async () => {
  await expect(
    exchangeAuthorizationCode(config, "code", "https://web.example.test/callback", "v", async () =>
      Response.json({ access_token: "not-a-jwt", refresh_token: "rt-1" }),
    ),
  ).rejects.toThrow(/解析|形式/);
});

test("refresh_token が返らなければ失敗として扱う（保存対象が無い）", async () => {
  await expect(
    exchangeAuthorizationCode(config, "code", "https://web.example.test/callback", "v", async () =>
      Response.json({ access_token: jwtWith({ sub: "auth0|a" }) }),
    ),
  ).rejects.toThrow(/refresh_token/);
});

test("invalid_grant は code で見分けられる", async () => {
  const error = await refreshAccessToken(config, "rt-1", async () =>
    Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 403 }),
  ).catch((value: unknown) => value);

  expect(error).toBeInstanceOf(OAuthTokenError);
  expect((error as OAuthTokenError).code).toBe("invalid_grant");
  expect((error as OAuthTokenError).isInvalidGrant).toBe(true);
});

test("5xx は invalid_grant ではない（セッションを消す理由にならない）", async () => {
  const error = await refreshAccessToken(
    config,
    "rt-1",
    async () => new Response("upstream down", { status: 503 }),
  ).catch((value: unknown) => value);

  expect(error).toBeInstanceOf(OAuthTokenError);
  expect((error as OAuthTokenError).isInvalidGrant).toBe(false);
  expect((error as OAuthTokenError).status).toBe(503);
});

test("ネットワーク障害も invalid_grant ではない", async () => {
  const error = await refreshAccessToken(config, "rt-1", async () => {
    throw new Error("network down");
  }).catch((value: unknown) => value);

  expect(error).toBeInstanceOf(OAuthTokenError);
  expect((error as OAuthTokenError).isInvalidGrant).toBe(false);
  expect((error as OAuthTokenError).status).toBe(0);
});

test("rotation で返らなかった refresh_token は undefined のままにする", async () => {
  const refreshed = await refreshAccessToken(config, "rt-1", async () =>
    Response.json({ access_token: "at-1", expires_in: 900 }),
  );

  expect(refreshed.refreshToken).toBeUndefined();
  expect(refreshed.accessToken).toBe("at-1");
});

test("撤回の失敗は握りつぶさず投げる", async () => {
  await expect(
    revokeRefreshToken(config, "rt-1", async () => new Response("nope", { status: 500 })),
  ).rejects.toBeInstanceOf(OAuthTokenError);
});

test("撤回は client_secret を添えてリダイレクトを追跡しない", async () => {
  let init: RequestInit | undefined;
  let url: string | undefined;

  await revokeRefreshToken(config, "rt-1", async (input, options) => {
    url = String(input);
    init = options;
    return new Response(null, { status: 200 });
  });

  expect(url).toBe("https://idp.example.test/oauth/revoke");
  expect(init?.redirect).toBe("error");
  expect(JSON.parse(String(init?.body))).toEqual({
    client_id: "web-client",
    client_secret: "web-secret",
    token: "rt-1",
  });
});
