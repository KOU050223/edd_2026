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
