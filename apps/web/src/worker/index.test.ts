import { expect, test } from "vitest";
import { createWebApp } from "./index.js";

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

function freshEnv() {
  return { ...env, SESSIONS: new MemoryKv(), MASTERY_OVERRIDES: new MemoryKv() };
}

/** ログインしてセッション cookie を得る。 */
async function login(
  app: ReturnType<typeof createWebApp>,
  bindings: Record<string, unknown>,
): Promise<string> {
  const response = await app.request(
    "https://web.example.test/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "open-sesame" }),
    },
    bindings as unknown as CloudflareBindings,
  );
  return response.headers.get("set-cookie") ?? "";
}

const env = {
  API_ORIGIN: "https://api.example.test/",
  API_TOKEN: "api-token",
  WEB_ACCESS_PASSPHRASE: "open-sesame",
  SESSIONS: new MemoryKv(),
  LOGIN_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
};

test("ログイン後だけ /api を API トークン付きで中継する", async () => {
  const received: Request[] = [];
  const receivedInit: RequestInit[] = [];
  const app = createWebApp({
    fetch: async (input, init) => {
      received.push(new Request(input, init));
      receivedInit.push(init ?? {});
      return Response.json({ concepts: [] });
    },
  });
  const login = await app.request(
    "https://web.example.test/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "open-sesame" }),
    },
    env as unknown as CloudflareBindings,
  );

  expect(login.status).toBe(204);
  const cookie = login.headers.get("set-cookie");
  expect(cookie).toContain("HttpOnly");
  const response = await app.request(
    "https://web.example.test/api/v1/learning-profile",
    { headers: { cookie: cookie ?? "", host: "web.example.test" } },
    env as unknown as CloudflareBindings,
  );

  expect(response.status).toBe(200);
  expect(received[0]?.url).toBe("https://api.example.test/v1/learning-profile");
  expect(received[0]?.headers.get("authorization")).toBe("Bearer api-token");
  expect(received[0]?.headers.get("host")).toBe("api.example.test");
  expect(receivedInit[0]?.redirect).toBe("error");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("既定の fetch は Cloudflare Workers のグローバルコンテキストで呼ぶ", async () => {
  const originalFetch = globalThis.fetch;
  const received: Request[] = [];
  const runtimeFetch: typeof fetch = async function (this: typeof globalThis, input, init) {
    expect(this).toBe(globalThis);
    received.push(new Request(input, init));
    return Response.json({ concepts: [] });
  };
  globalThis.fetch = runtimeFetch;

  try {
    const app = createWebApp();
    const login = await app.request(
      "https://web.example.test/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "open-sesame" }),
      },
      env as unknown as CloudflareBindings,
    );
    const response = await app.request(
      "https://web.example.test/api/v1/learning-profile",
      { headers: { cookie: login.headers.get("set-cookie") ?? "" } },
      env as unknown as CloudflareBindings,
    );

    expect(response.status).toBe(200);
    expect(received[0]?.url).toBe("https://api.example.test/v1/learning-profile");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("セッションが無い /api は API に中継せず理由を区別する", async () => {
  const app = createWebApp({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });

  const response = await app.request(
    "https://web.example.test/api/v1/learning-profile",
    {},
    env as unknown as CloudflareBindings,
  );

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "session_expired" });
});

test("loopback 以外の HTTP API_ORIGIN へ API トークンを送らない", async () => {
  let calls = 0;
  const app = createWebApp({
    fetch: async () => {
      calls += 1;
      return Response.json({});
    },
  });
  const login = await app.request(
    "https://web.example.test/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "open-sesame" }),
    },
    env as unknown as CloudflareBindings,
  );
  const response = await app.request(
    "https://web.example.test/api/v1/learning-profile",
    {
      headers: { cookie: login.headers.get("set-cookie") ?? "" },
    },
    { ...env, API_ORIGIN: "http://api.example.test" } as unknown as CloudflareBindings,
  );

  expect(response.status).toBe(500);
  expect(calls).toBe(0);
});

test("手動で変えた理解度は、再読み込みしても保存された値が返る", async () => {
  const bindings = freshEnv();
  const app = createWebApp({
    fetch: async () => {
      throw new Error("上書きの保存で API へ中継してはいけない");
    },
    now: () => "2026-09-21T09:00:00.000Z",
  });
  const cookie = await login(app, bindings);

  const saved = await app.request(
    "https://web.example.test/api/web/mastery-overrides",
    {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ conceptId: "go.pointer", status: "confirmed" }),
    },
    bindings as unknown as CloudflareBindings,
  );
  const reloaded = await app.request(
    "https://web.example.test/api/web/mastery-overrides",
    { headers: { cookie } },
    bindings as unknown as CloudflareBindings,
  );

  expect(saved.status).toBe(200);
  await expect(reloaded.json()).resolves.toEqual({
    "go.pointer": { status: "confirmed", updatedAt: "2026-09-21T09:00:00.000Z" },
  });
});

test("上書きを取り消すと、その Concept は自動算出へ戻る", async () => {
  const bindings = freshEnv();
  const app = createWebApp({
    fetch: async () => Response.json({}),
    now: () => "2026-09-21T09:00:00.000Z",
  });
  const cookie = await login(app, bindings);
  const put = (body: unknown) =>
    app.request(
      "https://web.example.test/api/web/mastery-overrides",
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      bindings as unknown as CloudflareBindings,
    );

  await put({ conceptId: "go.pointer", status: "confirmed" });
  await put({ conceptId: "go.defer", status: "learning" });
  const cleared = await put({ conceptId: "go.pointer", status: null });

  await expect(cleared.json()).resolves.toEqual({
    "go.defer": { status: "learning", updatedAt: "2026-09-21T09:00:00.000Z" },
  });
});

test("理解度として読めない値は保存せず、理由付きで拒む", async () => {
  const bindings = freshEnv();
  const app = createWebApp({ fetch: async () => Response.json({}) });
  const cookie = await login(app, bindings);

  const response = await app.request(
    "https://web.example.test/api/web/mastery-overrides",
    {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ conceptId: "go.pointer", status: "mastered" }),
    },
    bindings as unknown as CloudflareBindings,
  );

  expect(response.status).toBe(400);
  expect(bindings.MASTERY_OVERRIDES.values.size).toBe(0);
});

test("セッションが無いと手動の上書きを保存しない", async () => {
  const bindings = freshEnv();
  const app = createWebApp({ fetch: async () => Response.json({}) });

  const response = await app.request(
    "https://web.example.test/api/web/mastery-overrides",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conceptId: "go.pointer", status: "confirmed" }),
    },
    bindings as unknown as CloudflareBindings,
  );

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "session_expired" });
  expect(bindings.MASTERY_OVERRIDES.values.size).toBe(0);
});

test("保存された上書きが壊れていたら、空として扱わず失敗させる", async () => {
  const bindings = freshEnv();
  await bindings.MASTERY_OVERRIDES.put("mastery-overrides", "{broken");
  const app = createWebApp({ fetch: async () => Response.json({}) });
  const cookie = await login(app, bindings);

  const response = await app.request(
    "https://web.example.test/api/web/mastery-overrides",
    { headers: { cookie } },
    bindings as unknown as CloudflareBindings,
  );

  expect(response.status).toBe(500);
});
