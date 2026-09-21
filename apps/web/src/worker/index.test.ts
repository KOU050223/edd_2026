import { expect, test } from "vitest";
import { createWebApp } from "./index.js";
import { createSession, readSession } from "./session.js";

class MemoryKv {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

const kvOf = (kv: MemoryKv) => kv as unknown as KVNamespace;

function envWith(sessions: MemoryKv, overrides: Record<string, unknown> = {}) {
  return {
    API_ORIGIN: "https://api.example.test/",
    AUTH_ISSUER: "https://idp.example.test/",
    AUTH_AUDIENCE: "https://api.example.test",
    AUTH_CLIENT_ID: "web-client",
    AUTH_CLIENT_SECRET: "web-secret",
    SESSIONS: sessions,
    LOGIN_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
    ...overrides,
  } as unknown as CloudflareBindings;
}

/** `sub` を載せた、署名を確かめないダミーの JWT。Worker は payload しか読まない。 */
function fakeJwt(sub: string): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256" })}.${encode({ sub })}.signature`;
}

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .join("; ");

/** `Set-Cookie` から 1 つの値を取る。空文字は「消された」を意味する。 */
const cookieOf = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? "";

test("/login は state と PKCE を作って Auth0 の /authorize へ送る", async () => {
  const sessions = new MemoryKv();
  const app = createWebApp({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });

  const response = await app.request("https://web.example.test/login", {}, envWith(sessions));

  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin).toBe("https://idp.example.test");
  expect(location.pathname).toBe("/authorize");
  expect(location.searchParams.get("response_type")).toBe("code");
  expect(location.searchParams.get("client_id")).toBe("web-client");
  expect(location.searchParams.get("audience")).toBe("https://api.example.test");
  expect(location.searchParams.get("redirect_uri")).toBe("https://web.example.test/callback");
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // offline_access が無いと Refresh Token が返らず、KV に保存する対象が存在しなくなる。
  expect(location.searchParams.get("scope")?.split(" ")).toContain("offline_access");

  // state は Cookie ではなく KV に置き、Cookie は引換券だけを持つ。
  const state = location.searchParams.get("state");
  const loginCookie = response.headers.get("set-cookie") ?? "";
  expect(loginCookie).toContain("HttpOnly");
  expect(loginCookie).toContain("Secure");
  expect(loginCookie).not.toContain(state ?? "never");
  expect([...sessions.values.keys()][0]).toMatch(/^login:/);
});

test("/callback は認可コードを交換し、個人のセッションを張る", async () => {
  const sessions = new MemoryKv();
  const bodies: URLSearchParams[] = [];
  const app = createWebApp({
    fetch: async (_input, init) => {
      bodies.push(new URLSearchParams(String(init?.body)));
      return Response.json({
        access_token: fakeJwt("auth0|alice"),
        refresh_token: "rt-1",
        expires_in: 900,
      });
    },
  });
  const env = envWith(sessions);

  const login = await app.request("https://web.example.test/login", {}, env);
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");
  const callback = await app.request(
    `https://web.example.test/callback?code=auth-code&state=${state}`,
    { headers: { cookie: cookiesOf(login) } },
    env,
  );

  expect(callback.status).toBe(302);
  // KV の伝播待ちを画面が 1 回だけ再試行できるよう、ログイン直後の印を付けて戻す。
  expect(callback.headers.get("location")).toBe("/?login=1");
  expect(bodies[0]?.get("grant_type")).toBe("authorization_code");
  expect(bodies[0]?.get("code")).toBe("auth-code");
  expect(bodies[0]?.get("client_secret")).toBe("web-secret");
  expect(bodies[0]?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(bodies[0]?.get("redirect_uri")).toBe("https://web.example.test/callback");

  const sessionToken = cookieOf(callback, "session");
  await expect(readSession(kvOf(sessions), sessionToken)).resolves.toEqual({
    refreshToken: "rt-1",
    sub: "auth0|alice",
  });
  // 使い終わった pre-session Cookie を残さない。
  expect(cookieOf(callback, "login")).toBe("");
});

test("state が一致しないと中断し、Refresh Token を保存しない", async () => {
  const sessions = new MemoryKv();
  let exchanges = 0;
  const app = createWebApp({
    fetch: async () => {
      exchanges += 1;
      return Response.json({ access_token: fakeJwt("auth0|mallory"), refresh_token: "rt-x" });
    },
  });
  const env = envWith(sessions);

  const login = await app.request("https://web.example.test/login", {}, env);
  const response = await app.request(
    "https://web.example.test/callback?code=attacker-code&state=not-the-one",
    { headers: { cookie: cookiesOf(login) } },
    env,
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/login-failed?reason=state_mismatch");
  // 交換まで進んでいない。ここが通ると攻撃者のアカウントでログインさせられる。
  expect(exchanges).toBe(0);
  expect([...sessions.values.keys()].filter((key) => key.startsWith("session:"))).toEqual([]);
});

test("login Cookie が無い /callback は中断する", async () => {
  const sessions = new MemoryKv();
  const app = createWebApp({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });

  const response = await app.request(
    "https://web.example.test/callback?code=c&state=s",
    {},
    envWith(sessions),
  );

  expect(response.headers.get("location")).toBe("/login-failed?reason=login_state_missing");
});

test("同じ login Cookie は二度使えない", async () => {
  const sessions = new MemoryKv();
  const app = createWebApp({
    fetch: async () =>
      Response.json({
        access_token: fakeJwt("auth0|alice"),
        refresh_token: "rt-1",
        expires_in: 900,
      }),
  });
  const env = envWith(sessions);

  const login = await app.request("https://web.example.test/login", {}, env);
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");
  const cookie = cookiesOf(login);
  const first = await app.request(
    `https://web.example.test/callback?code=c1&state=${state}`,
    { headers: { cookie } },
    env,
  );
  const replay = await app.request(
    `https://web.example.test/callback?code=c1&state=${state}`,
    { headers: { cookie } },
    env,
  );

  expect(first.headers.get("location")).toBe("/?login=1");
  expect(replay.headers.get("location")).toBe("/login-failed?reason=login_state_missing");
});

test("IdP が error を返した /callback は交換へ進まない", async () => {
  const sessions = new MemoryKv();
  const app = createWebApp({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  const env = envWith(sessions);

  const login = await app.request("https://web.example.test/login", {}, env);
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");
  const response = await app.request(
    `https://web.example.test/callback?error=access_denied&state=${state}`,
    { headers: { cookie: cookiesOf(login) } },
    env,
  );

  expect(response.headers.get("location")).toBe("/login-failed?reason=access_denied");
});

test("state の合わない error つき /callback は進行中のログインを壊さない", async () => {
  const sessions = new MemoryKv();
  const app = createWebApp({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  const env = envWith(sessions);

  const login = await app.request("https://web.example.test/login", {}, env);
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");
  const cookie = cookiesOf(login);

  // 攻撃者に誘導された、自分が始めたものではない error 応答。
  const forged = await app.request(
    "https://web.example.test/callback?error=access_denied&state=attacker",
    { headers: { cookie } },
    env,
  );

  expect(forged.headers.get("location")).toBe("/login-failed?reason=unsolicited");
  // Cookie も KV も触っていないので、本来のログインはそのまま完了できる。
  expect(forged.headers.get("set-cookie")).toBeNull();
  const resumed = await app.request(
    `https://web.example.test/callback?error=access_denied&state=${state}`,
    { headers: { cookie } },
    env,
  );
  expect(resumed.headers.get("location")).toBe("/login-failed?reason=access_denied");
});

test("IdP が返した未知の error は次の URL へそのまま載せない", async () => {
  const sessions = new MemoryKv();
  const app = createWebApp({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  const env = envWith(sessions);

  const login = await app.request("https://web.example.test/login", {}, env);
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");
  const response = await app.request(
    `https://web.example.test/callback?error=%3Cscript%3Ealert(1)%3C/script%3E&state=${state}`,
    { headers: { cookie: cookiesOf(login) } },
    env,
  );

  expect(response.headers.get("location")).toBe("/login-failed?reason=authorize_failed");
});

test("/api は共有トークンではなく、そのセッションのアクセストークンを注入する", async () => {
  const sessions = new MemoryKv();
  const token = await createSession(kvOf(sessions), {
    refreshToken: "rt-1",
    sub: "auth0|alice",
  });
  const received: Request[] = [];
  const receivedInit: RequestInit[] = [];
  const app = createWebApp({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith("https://idp.example.test")) {
        return Response.json({ access_token: "at-alice", expires_in: 900 });
      }
      received.push(request);
      receivedInit.push(init ?? {});
      return Response.json({ concepts: [] });
    },
  });

  const response = await app.request(
    "https://web.example.test/api/v1/learning-profile",
    { headers: { cookie: `session=${token}`, host: "web.example.test" } },
    envWith(sessions),
  );

  expect(response.status).toBe(200);
  expect(received[0]?.url).toBe("https://api.example.test/v1/learning-profile");
  expect(received[0]?.headers.get("authorization")).toBe("Bearer at-alice");
  expect(received[0]?.headers.get("host")).toBe("api.example.test");
  expect(received[0]?.headers.get("cookie")).toBeNull();
  expect(receivedInit[0]?.redirect).toBe("error");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("利用者ごとに別のアクセストークンが載る", async () => {
  const sessions = new MemoryKv();
  const alice = await createSession(kvOf(sessions), { refreshToken: "rt-a", sub: "auth0|a" });
  const bob = await createSession(kvOf(sessions), { refreshToken: "rt-b", sub: "auth0|b" });
  const authorizations: (string | null)[] = [];
  const app = createWebApp({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith("https://idp.example.test")) {
        const body = new URLSearchParams(String(init?.body));
        return Response.json({
          access_token: `at-for-${body.get("refresh_token")}`,
          expires_in: 900,
        });
      }
      authorizations.push(request.headers.get("authorization"));
      return Response.json({});
    },
  });
  const env = envWith(sessions);

  for (const token of [alice, bob]) {
    await app.request(
      "https://web.example.test/api/v1/learning-profile",
      { headers: { cookie: `session=${token}` } },
      env,
    );
  }

  expect(authorizations).toEqual(["Bearer at-for-rt-a", "Bearer at-for-rt-b"]);
});

test("セッションが無い /api は API に中継せず理由を区別する", async () => {
  const sessions = new MemoryKv();
  const app = createWebApp({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });

  const response = await app.request(
    "https://web.example.test/api/v1/learning-profile",
    {},
    envWith(sessions),
  );

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "session_expired" });
});

test("伝播待ちの 401 では Cookie を消さない（再試行が資格情報を失わない）", async () => {
  const sessions = new MemoryKv();
  const app = createWebApp({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });

  // ログイン直後、KV がまだ伝播していない状態を模す（Cookie はあるが KV に無い）。
  const response = await app.request(
    "https://web.example.test/api/v1/learning-profile",
    { headers: { cookie: "session=not-yet-propagated" } },
    envWith(sessions),
  );

  expect(response.status).toBe(401);
  // ここで Cookie を消すと、画面の 1 回だけの再試行が必ず 401 になり回復できない。
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("API の 401 ではサーバー側のセッションも消す", async () => {
  const sessions = new MemoryKv();
  const token = await createSession(kvOf(sessions), { refreshToken: "rt-1", sub: "auth0|a" });
  const app = createWebApp({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith("https://idp.example.test"))
        return Response.json({ access_token: "at-1", expires_in: 900 });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    },
  });

  const response = await app.request(
    "https://web.example.test/api/v1/learning-profile",
    { headers: { cookie: `session=${token}` } },
    envWith(sessions),
  );

  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  // Cookie を消すだけでは、同じ Cookie を持つ別の誰かが refresh を回して使い続けられる。
  await expect(readSession(kvOf(sessions), token)).resolves.toBeUndefined();
});

test("ログアウトと並行する refresh は、消したセッションを蘇らせない", async () => {
  const sessions = new MemoryKv();
  const token = await createSession(kvOf(sessions), { refreshToken: "rt-1", sub: "auth0|a" });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = createWebApp({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/oauth/token")) {
        await held;
        return Response.json({
          access_token: "at-1",
          refresh_token: "rt-2",
          expires_in: 900,
        });
      }
      if (request.url.endsWith("/oauth/revoke")) return new Response(null, { status: 200 });
      return Response.json({});
    },
  });
  const env = envWith(sessions);

  // refresh の途中でログアウトが割り込む。
  const api = app.request(
    "https://web.example.test/api/v1/learning-profile",
    { headers: { cookie: `session=${token}` } },
    env,
  );
  const logout = await app.request(
    "https://web.example.test/logout",
    { method: "POST", headers: { cookie: `session=${token}` } },
    env,
  );
  release();
  await api;

  expect(logout.status).toBe(204);
  // ログアウト後に KV へセッションが書き戻されていないこと。
  await expect(readSession(kvOf(sessions), token)).resolves.toBeUndefined();
});

test("Auth0 の 5xx では 503 を返し、セッションを消さない", async () => {
  const sessions = new MemoryKv();
  const token = await createSession(kvOf(sessions), { refreshToken: "rt-1", sub: "auth0|a" });
  let apiCalls = 0;
  const app = createWebApp({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith("https://idp.example.test"))
        return new Response("upstream down", { status: 503 });
      apiCalls += 1;
      return Response.json({});
    },
  });

  const response = await app.request(
    "https://web.example.test/api/v1/learning-profile",
    { headers: { cookie: `session=${token}` } },
    envWith(sessions),
  );

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({ error: "auth_unavailable" });
  expect(apiCalls).toBe(0);
  // セッションが残っているので、利用者は再試行だけで戻れる。
  await expect(readSession(kvOf(sessions), token)).resolves.toEqual({
    refreshToken: "rt-1",
    sub: "auth0|a",
  });
});

test("invalid_grant では 401 session_expired を返し、セッションを消す", async () => {
  const sessions = new MemoryKv();
  const token = await createSession(kvOf(sessions), { refreshToken: "rt-1", sub: "auth0|a" });
  const app = createWebApp({
    fetch: async () => Response.json({ error: "invalid_grant" }, { status: 403 }),
  });

  const response = await app.request(
    "https://web.example.test/api/v1/learning-profile",
    { headers: { cookie: `session=${token}` } },
    envWith(sessions),
  );

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "session_expired" });
  await expect(readSession(kvOf(sessions), token)).resolves.toBeUndefined();
});

test("並行リクエストは refresh を 1 回にまとめ、ランダムにログアウトしない", async () => {
  const sessions = new MemoryKv();
  const token = await createSession(kvOf(sessions), { refreshToken: "rt-1", sub: "auth0|a" });
  let refreshes = 0;
  const app = createWebApp({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith("https://idp.example.test")) {
        refreshes += 1;
        // rotation。古い RT はこの時点で無効になる。
        return Response.json({
          access_token: "at-1",
          refresh_token: `rt-${refreshes + 1}`,
          expires_in: 900,
        });
      }
      return Response.json({});
    },
  });
  const env = envWith(sessions);

  // 画面は profile と overrides を Promise.all で並べて取る。
  const responses = await Promise.all([
    app.request(
      "https://web.example.test/api/v1/learning-profile",
      { headers: { cookie: `session=${token}` } },
      env,
    ),
    app.request(
      "https://web.example.test/api/v1/mastery-overrides",
      { headers: { cookie: `session=${token}` } },
      env,
    ),
  ]);

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(refreshes).toBe(1);
  await expect(readSession(kvOf(sessions), token)).resolves.toEqual({
    refreshToken: "rt-2",
    sub: "auth0|a",
  });
});

test("ログアウトは先に KV を消し、その後 Refresh Token を撤回する", async () => {
  const sessions = new MemoryKv();
  const token = await createSession(kvOf(sessions), { refreshToken: "rt-1", sub: "auth0|a" });
  const revoked: unknown[] = [];
  const app = createWebApp({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://idp.example.test/oauth/revoke");
      // 撤回に着手した時点で、既に KV から消えていること。
      expect(sessions.values.has(`session:${token}`)).toBe(false);
      revoked.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    },
  });

  const response = await app.request(
    "https://web.example.test/logout",
    { method: "POST", headers: { cookie: `session=${token}` } },
    envWith(sessions),
  );

  expect(response.status).toBe(204);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(revoked).toEqual([
    { client_id: "web-client", client_secret: "web-secret", token: "rt-1" },
  ]);
  await expect(readSession(kvOf(sessions), token)).resolves.toBeUndefined();
});

test("撤回に失敗してもログアウトは完了する（利用者を守るのは KV の削除）", async () => {
  const sessions = new MemoryKv();
  const token = await createSession(kvOf(sessions), { refreshToken: "rt-1", sub: "auth0|a" });
  const app = createWebApp({
    fetch: async () => new Response("nope", { status: 500 }),
  });

  const response = await app.request(
    "https://web.example.test/logout",
    { method: "POST", headers: { cookie: `session=${token}` } },
    envWith(sessions),
  );

  expect(response.status).toBe(204);
  await expect(readSession(kvOf(sessions), token)).resolves.toBeUndefined();
});

test("loopback 以外の HTTP API_ORIGIN へトークンを送らない", async () => {
  const sessions = new MemoryKv();
  const token = await createSession(kvOf(sessions), { refreshToken: "rt-1", sub: "auth0|a" });
  let apiCalls = 0;
  const app = createWebApp({
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith("https://idp.example.test"))
        return Response.json({ access_token: "at-1", expires_in: 900 });
      apiCalls += 1;
      return Response.json({});
    },
  });

  const response = await app.request(
    "https://web.example.test/api/v1/learning-profile",
    { headers: { cookie: `session=${token}` } },
    envWith(sessions, { API_ORIGIN: "http://api.example.test" }),
  );

  expect(response.status).toBe(500);
  expect(apiCalls).toBe(0);
});

test("loopback 以外の HTTP AUTH_ISSUER へ client secret を送らない", async () => {
  const sessions = new MemoryKv();
  let calls = 0;
  const app = createWebApp({
    fetch: async () => {
      calls += 1;
      return Response.json({});
    },
  });

  const response = await app.request(
    "https://web.example.test/login",
    {},
    envWith(sessions, { AUTH_ISSUER: "http://idp.example.test/" }),
  );

  expect(response.status).toBe(500);
  expect(calls).toBe(0);
});

test("認証前エンドポイントはレート制限を IP で数える", async () => {
  const sessions = new MemoryKv();
  const keys: string[] = [];
  const app = createWebApp({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  const env = envWith(sessions, {
    LOGIN_RATE_LIMITER: {
      limit: ({ key }: { key: string }) => {
        keys.push(key);
        return Promise.resolve({ success: false });
      },
    },
  });

  const login = await app.request(
    "https://web.example.test/login",
    { headers: { "CF-Connecting-IP": "203.0.113.7" } },
    env,
  );
  const callback = await app.request(
    "https://web.example.test/callback?code=c&state=s",
    { headers: { "CF-Connecting-IP": "203.0.113.7" } },
    env,
  );

  expect(login.status).toBe(429);
  expect(callback.status).toBe(429);
  expect(keys).toEqual(["203.0.113.7", "203.0.113.7"]);
});

test("既定の fetch は Cloudflare Workers のグローバルコンテキストで呼ぶ", async () => {
  const sessions = new MemoryKv();
  const token = await createSession(kvOf(sessions), { refreshToken: "rt-1", sub: "auth0|a" });
  const originalFetch = globalThis.fetch;
  const received: Request[] = [];
  const runtimeFetch: typeof fetch = async function (this: typeof globalThis, input, init) {
    expect(this).toBe(globalThis);
    const request = new Request(input, init);
    if (request.url.startsWith("https://idp.example.test"))
      return Response.json({ access_token: "at-1", expires_in: 900 });
    received.push(request);
    return Response.json({ concepts: [] });
  };
  globalThis.fetch = runtimeFetch;

  try {
    const app = createWebApp();
    const response = await app.request(
      "https://web.example.test/api/v1/learning-profile",
      { headers: { cookie: `session=${token}` } },
      envWith(sessions),
    );

    expect(response.status).toBe(200);
    expect(received[0]?.url).toBe("https://api.example.test/v1/learning-profile");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
