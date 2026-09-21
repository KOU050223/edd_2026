import { expect, test } from "vitest";
import { createAccessTokenProvider } from "./access-token.js";
import type { OAuthConfig } from "./oauth.js";
import { createSession, readSession, type SessionRecord } from "./session.js";

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

const config: OAuthConfig = {
  issuer: "https://idp.example.test/",
  clientId: "web-client",
  clientSecret: "web-secret",
  audience: "https://api.example.test",
};

const tokenResponse = (values: Record<string, unknown>) => Response.json(values);

/** 指定した応答を順に返す偽の fetch。呼ばれた回数と本文を残す。 */
function stubFetch(responses: (() => Promise<Response>)[]) {
  const bodies: URLSearchParams[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    const next = responses[bodies.length - 1];
    if (!next) throw new Error(`unexpected fetch #${bodies.length}`);
    return next();
  };
  return { fetch: fetchImpl, bodies };
}

async function seed(
  kv: MemoryKv,
  record: SessionRecord = { refreshToken: "rt-1", sub: "auth0|a" },
) {
  return { token: await createSession(kvOf(kv), record), record: { ...record } };
}

test("アクセストークンを取得し、二度目はメモリのキャッシュで済ませる", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  const stub = stubFetch([async () => tokenResponse({ access_token: "at-1", expires_in: 900 })]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  const first = await provider.get(kvOf(kv), token, record, config);
  const second = await provider.get(kvOf(kv), token, record, config);

  expect(first).toEqual({ ok: true, accessToken: "at-1" });
  expect(second).toEqual({ ok: true, accessToken: "at-1" });
  // 2 回目は IdP を叩いていない。KV 書き込みも増えていない。
  expect(stub.bodies).toHaveLength(1);
});

test("期限が近づいたら取り直す", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  const stub = stubFetch([
    async () => tokenResponse({ access_token: "at-1", expires_in: 900 }),
    async () => tokenResponse({ access_token: "at-2", expires_in: 900 }),
  ]);
  let clock = 0;
  const provider = createAccessTokenProvider({ fetch: stub.fetch, now: () => clock });

  await provider.get(kvOf(kv), token, record, config);
  // 900 秒 - 余裕 60 秒 = 840 秒でキャッシュが切れる。
  clock = 840_000;
  const refreshed = await provider.get(kvOf(kv), token, record, config);

  expect(refreshed).toEqual({ ok: true, accessToken: "at-2" });
  expect(stub.bodies).toHaveLength(2);
});

test("rotation した Refresh Token を KV へ書き戻す", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  const stub = stubFetch([
    async () => tokenResponse({ access_token: "at-1", refresh_token: "rt-2", expires_in: 900 }),
  ]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  await provider.get(kvOf(kv), token, record, config);

  expect(stub.bodies[0]?.get("refresh_token")).toBe("rt-1");
  await expect(readSession(kvOf(kv), token)).resolves.toEqual({
    refreshToken: "rt-2",
    sub: "auth0|a",
  });
});

test("confidential client として client_secret を本文へ載せる", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  const stub = stubFetch([async () => tokenResponse({ access_token: "at-1", expires_in: 900 })]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  await provider.get(kvOf(kv), token, record, config);

  expect(stub.bodies[0]?.get("grant_type")).toBe("refresh_token");
  expect(stub.bodies[0]?.get("client_id")).toBe("web-client");
  expect(stub.bodies[0]?.get("client_secret")).toBe("web-secret");
});

test("invalid_grant のときだけセッションを消す", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  const stub = stubFetch([
    async () =>
      Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 403 }),
  ]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  const result = await provider.get(kvOf(kv), token, record, config);

  expect(result).toEqual({ ok: false, kind: "session_expired" });
  await expect(readSession(kvOf(kv), token)).resolves.toBeUndefined();
});

test("Auth0 の 5xx ではセッションを消さず、再試行できるエラーを返す", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  const stub = stubFetch([async () => new Response("upstream down", { status: 503 })]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  const result = await provider.get(kvOf(kv), token, record, config);

  expect(result).toEqual({ ok: false, kind: "auth_unavailable" });
  // ここが消えると、Auth0 の一時的な 5xx 一回で全利用者がログアウトする。
  await expect(readSession(kvOf(kv), token)).resolves.toEqual({
    refreshToken: "rt-1",
    sub: "auth0|a",
  });
});

test("レート制限とネットワーク障害でもセッションを残す", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  const stub = stubFetch([
    async () => Response.json({ error: "too_many_requests" }, { status: 429 }),
    async () => {
      throw new Error("network down");
    },
  ]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  const limited = await provider.get(kvOf(kv), token, record, config);
  const offline = await provider.get(kvOf(kv), token, record, config);

  expect(limited).toEqual({ ok: false, kind: "auth_unavailable" });
  expect(offline).toEqual({ ok: false, kind: "auth_unavailable" });
  await expect(readSession(kvOf(kv), token)).resolves.toEqual({
    refreshToken: "rt-1",
    sub: "auth0|a",
  });
});

test("2xx でも本文を解析できなければ失敗として扱う", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  const stub = stubFetch([async () => new Response("not-json", { status: 200 })]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  const result = await provider.get(kvOf(kv), token, record, config);

  expect(result).toEqual({ ok: false, kind: "auth_unavailable" });
});

test("同じセッションの並行リクエストは refresh を 1 回に直列化する", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stub = stubFetch([
    async () => {
      await held;
      return tokenResponse({ access_token: "at-1", refresh_token: "rt-2", expires_in: 900 });
    },
  ]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  // 画面は profile と overrides を Promise.all で並べて取る。その形をそのまま再現する。
  const both = Promise.all([
    provider.get(kvOf(kv), token, record, config),
    provider.get(kvOf(kv), token, record, config),
  ]);
  release();
  const [first, second] = await both;

  expect(first).toEqual({ ok: true, accessToken: "at-1" });
  expect(second).toEqual({ ok: true, accessToken: "at-1" });
  // 2 回回すと、片方が取得した新しい RT をもう片方が古い値で上書きして
  // 利用者がランダムにログアウトする。
  expect(stub.bodies).toHaveLength(1);
  await expect(readSession(kvOf(kv), token)).resolves.toEqual({
    refreshToken: "rt-2",
    sub: "auth0|a",
  });
});

test("直列化は失敗しても解除され、次のリクエストが再試行できる", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  const stub = stubFetch([
    async () => new Response("upstream down", { status: 503 }),
    async () => tokenResponse({ access_token: "at-1", expires_in: 900 }),
  ]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  const failed = await provider.get(kvOf(kv), token, record, config);
  const recovered = await provider.get(kvOf(kv), token, record, config);

  expect(failed).toEqual({ ok: false, kind: "auth_unavailable" });
  expect(recovered).toEqual({ ok: true, accessToken: "at-1" });
});

test("別セッションの refresh は互いに待たない", async () => {
  const kv = new MemoryKv();
  const alice = await seed(kv, { refreshToken: "rt-a", sub: "auth0|a" });
  const bob = await seed(kv, { refreshToken: "rt-b", sub: "auth0|b" });
  const stub = stubFetch([
    async () => tokenResponse({ access_token: "at-a", expires_in: 900 }),
    async () => tokenResponse({ access_token: "at-b", expires_in: 900 }),
  ]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  const [first, second] = await Promise.all([
    provider.get(kvOf(kv), alice.token, alice.record, config),
    provider.get(kvOf(kv), bob.token, bob.record, config),
  ]);

  expect(first).toEqual({ ok: true, accessToken: "at-a" });
  expect(second).toEqual({ ok: true, accessToken: "at-b" });
});

test("forget したセッションはキャッシュを使わず取り直す", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  const stub = stubFetch([
    async () => tokenResponse({ access_token: "at-1", expires_in: 900 }),
    async () => tokenResponse({ access_token: "at-2", expires_in: 900 }),
  ]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  await provider.get(kvOf(kv), token, record, config);
  provider.forget(token);
  const again = await provider.get(kvOf(kv), token, record, config);

  expect(again).toEqual({ ok: true, accessToken: "at-2" });
});

test("expires_in が無ければキャッシュせず、毎回取り直す", async () => {
  const kv = new MemoryKv();
  const { token, record } = await seed(kv);
  const stub = stubFetch([
    async () => tokenResponse({ access_token: "at-1" }),
    async () => tokenResponse({ access_token: "at-2" }),
  ]);
  const provider = createAccessTokenProvider({ fetch: stub.fetch });

  await provider.get(kvOf(kv), token, record, config);
  const again = await provider.get(kvOf(kv), token, record, config);

  expect(again).toEqual({ ok: true, accessToken: "at-2" });
});
