import { expect, test, vi } from "vitest";
import { Hono } from "hono";
import { type AuthVariables } from "./middleware.js";
import { AUTHORIZED_HEADERS, stubAuth } from "./test-auth.js";
import { rateLimit, useMapRateLimit } from "./rate-limit.js";

/** 呼ばれた key を記録し、指定回数を超えたら拒否するテスト用のリミッタ。 */
function fakeLimiter(allowed: number) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    limiter: {
      limit: ({ key }: { key: string }) => {
        keys.push(key);
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return Promise.resolve({ success: next <= allowed });
      },
    } as unknown as RateLimit,
  };
}

function buildApp(limiter: RateLimit | undefined, userId = "user-a") {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/limited", stubAuth(userId));
  app.use(
    "/limited",
    rateLimit((env) => env.SYNC_RATE_LIMITER),
  );
  app.get("/limited", (c) => c.json({ ok: true }));

  const env = { SYNC_RATE_LIMITER: limiter };
  return () =>
    app.request("/limited", { headers: AUTHORIZED_HEADERS }, env as unknown as CloudflareBindings);
}

/** 別人の2つのトークン。同じアプリが両方を受け付ける。 */
const TOKEN_A = "token-a";
const TOKEN_B = "token-b";

/** 1つのアプリで `TOKEN_A` / `TOKEN_B` を別の userId として受け付ける。 */
function buildMultiUserApp(limiter: RateLimit) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/limited", stubAuth({ [TOKEN_A]: "user-a", [TOKEN_B]: "user-b" }));
  app.use(
    "/limited",
    rateLimit((env) => env.SYNC_RATE_LIMITER),
  );
  app.get("/limited", (c) => c.json({ ok: true }));

  const env = { SYNC_RATE_LIMITER: limiter };
  return (token: string) =>
    app.request(
      "/limited",
      { headers: { Authorization: `Bearer ${token}` } },
      env as unknown as CloudflareBindings,
    );
}

test("上限内のリクエストは通す", async () => {
  const { limiter } = fakeLimiter(2);
  const request = buildApp(limiter);

  expect((await request()).status).toBe(200);
  expect((await request()).status).toBe(200);
});

test("上限を超えたら429にする", async () => {
  const { limiter } = fakeLimiter(1);
  const request = buildApp(limiter);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  await request();

  expect((await request()).status).toBe(429);
  warn.mockRestore();
});

test("上限への到達はどの経路で誰が止まったかをログに残す", async () => {
  // レート制限到達数は監視指標の1つ（docs/api-ops.md）。
  // 429 の応答だけではダッシュボードから経路と利用者が読めない。
  const { limiter } = fakeLimiter(1);
  const request = buildApp(limiter);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  await request();
  await request();

  expect(warn).toHaveBeenCalledWith("rate limit reached", {
    path: "/limited",
    userId: "user-a",
  });
  warn.mockRestore();
});

test("認証済みのuserIdを単位として数える", async () => {
  // IP で数えると NAT の内側で同僚を巻き添えにし、かつ IP は変えられるので回避も容易。
  const { limiter, keys } = fakeLimiter(10);
  const request = buildApp(limiter, "user-b");

  await request();

  expect(keys).toEqual(["user-b"]);
});

test("別のユーザーの消費は影響しない", async () => {
  const { limiter } = fakeLimiter(1);

  await buildApp(limiter, "user-a")();

  expect((await buildApp(limiter, "user-b")()).status).toBe(200);
});

test("同じアプリに届いた別トークンでも上限は独立して消費される", async () => {
  // アプリを分けて確かめても、本番の形にならない。実際には1つの Worker へ
  // 別人のトークンが混ざって届く。その状態で鍵が userId ごとに分かれることを固定する。
  const { limiter, keys } = fakeLimiter(2);
  const request = buildMultiUserApp(limiter);

  // user-a だけを上限いっぱいまで使い切る。
  expect((await request(TOKEN_A)).status).toBe(200);
  expect((await request(TOKEN_A)).status).toBe(200);
  expect((await request(TOKEN_A)).status).toBe(429);

  // user-b の残りは削られていない。
  expect((await request(TOKEN_B)).status).toBe(200);
  expect((await request(TOKEN_B)).status).toBe(200);
  expect((await request(TOKEN_B)).status).toBe(429);

  expect(keys).toEqual(["user-a", "user-a", "user-a", "user-b", "user-b", "user-b"]);
});

test("リミッタが未設定なら素通りさせず500にする", async () => {
  // 「設定が無いから無制限」にすると、設定漏れがそのまま制限の解除になる。
  const request = buildApp(undefined);

  expect((await request()).status).toBe(500);
});

test("リミッタが未設定ならハンドラまで到達しない", async () => {
  // ステータスだけでは足りない。500 を返しつつ本体を実行していたら、
  // 制限の無い書き込みがそのまま通ってしまう。
  let handled = false;
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/limited", stubAuth("user-a"));
  app.use(
    "/limited",
    rateLimit((env) => env.SYNC_RATE_LIMITER),
  );
  app.get("/limited", (c) => {
    handled = true;
    return c.json({ ok: true });
  });

  const res = await app.request("/limited", { headers: AUTHORIZED_HEADERS }, {
    SYNC_RATE_LIMITER: undefined,
  } as unknown as CloudflareBindings);

  expect(res.status).toBe(500);
  expect(handled).toBe(false);
});

test("認証が無ければレート制限より前に401で止める", async () => {
  const { limiter, keys } = fakeLimiter(10);
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/limited", stubAuth("user-a"));
  app.use(
    "/limited",
    rateLimit((env) => env.SYNC_RATE_LIMITER),
  );
  app.get("/limited", (c) => c.json({ ok: true }));

  const res = await app.request("/limited", { headers: { Authorization: "Bearer wrong" } }, {
    SYNC_RATE_LIMITER: limiter,
  } as unknown as CloudflareBindings);

  expect(res.status).toBe(401);
  // userId が決まっていない状態で数えていない。
  expect(keys).toEqual([]);
});

/** `app.ts` と同じく `useMapRateLimit` を付けたアプリ。`/v1/learning-profile` は Profile の枠で数える。 */
function buildMapApp(env: { MAP_RATE_LIMITER: RateLimit; PROFILE_RATE_LIMITER: RateLimit }) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  useMapRateLimit(app);
  app.use(
    "/v1/learning-profile",
    rateLimit((env) => env.PROFILE_RATE_LIMITER),
  );
  app.all("/v1/*", (c) => c.json({ ok: true }));
  return (path: string, method = "GET") =>
    app.request(
      path,
      { method, headers: AUTHORIZED_HEADERS },
      env as unknown as CloudflareBindings,
    );
}

const MAP_PATHS = [
  "/v1/learning-maps",
  "/v1/learning-maps/m1234abcd",
  "/v1/learning-maps:concepts",
  "/v1/shared-maps",
  "/v1/shared-maps/m1234abcd",
  "/v1/fixed-maps",
  "/v1/repo-maps:inspect",
  "/v1/repo-map-drafts",
  "/v1/repo-map-drafts/r1234abcd",
];

test("マップ系の経路は Profile ではなくマップの枠で数える（#299）", async () => {
  const map = fakeLimiter(Number.POSITIVE_INFINITY);
  const profile = fakeLimiter(0);
  const request = buildMapApp({
    MAP_RATE_LIMITER: map.limiter,
    PROFILE_RATE_LIMITER: profile.limiter,
  });

  for (const path of MAP_PATHS) expect((await request(path)).status).toBe(200);
  expect(map.keys).toHaveLength(MAP_PATHS.length);
  expect(profile.keys).toEqual([]);
});

test("マップの枠を使い切ってもマップ系だけが止まり、Profile は止まらない（#299）", async () => {
  const map = fakeLimiter(0);
  const profile = fakeLimiter(Number.POSITIVE_INFINITY);
  const request = buildMapApp({
    MAP_RATE_LIMITER: map.limiter,
    PROFILE_RATE_LIMITER: profile.limiter,
  });

  for (const path of MAP_PATHS) expect((await request(path)).status).toBe(429);
  expect((await request("/v1/learning-maps:generate", "POST")).status).toBe(429);
  expect((await request("/v1/learning-profile")).status).toBe(200);
});
