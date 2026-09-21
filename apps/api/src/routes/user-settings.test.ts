import { expect, test } from "vitest";
import { Hono } from "hono";
import { type AuthVariables } from "../auth/middleware.js";
import { TEST_TOKEN, stubAuth } from "../auth/test-auth.js";
import { InMemoryIdentityRepository } from "../repository/memory.js";
import { InMemoryUserSettingsRepository } from "../repository/user-settings.js";
import { createUserSettingsRoute } from "./user-settings.js";

/** 認証は `stubAuth` が担うので、env に資格情報は要らない。 */
const ENV = {} as unknown as CloudflareBindings;

function buildApp(
  userId = "user-a",
  repository = new InMemoryUserSettingsRepository(),
  identity = new InMemoryIdentityRepository(),
) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(userId));
  app.route(
    "/v1",
    createUserSettingsRoute(() => ({
      identity,
      repository,
      nowIso: () => "2026-09-22T00:00:00.000Z",
      nowMs: () => 1_000,
    })),
  );
  return { app, identity, repository };
}

const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

const put = (app: Hono<never>, body: unknown) =>
  app.request(
    "/v1/user-settings",
    { method: "PUT", headers: jsonAuth, body: JSON.stringify(body) },
    ENV,
  );

test("未保存のユーザーには既定値を返す（404 にしない）", async () => {
  const { app } = buildApp();

  const response = await app.request("/v1/user-settings", { headers: auth }, ENV);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    version: 1,
    displayName: null,
    activityPeriodDays: 30,
    updatedAt: null,
  });
});

test("設定を保存し、再読み込みで同じ値が返る", async () => {
  const { app, identity } = buildApp();

  const saved = await put(app as never, { displayName: "こう", activityPeriodDays: 7 });
  const loaded = await app.request("/v1/user-settings", { headers: auth }, ENV);

  expect(saved.status).toBe(200);
  // 外部キー制約があるので、設定を書く前に users 行が要る。
  expect(identity.users.has("user-a")).toBe(true);
  const expected = {
    version: 1,
    displayName: "こう",
    activityPeriodDays: 7,
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
  await expect(saved.json()).resolves.toEqual(expected);
  await expect(loaded.json()).resolves.toEqual(expected);
});

test("表示名の前後の空白を落とし、空白だけなら未設定へ寄せる", async () => {
  const { app } = buildApp();

  const padded = await put(app as never, { displayName: "  こう  ", activityPeriodDays: 30 });
  await expect(padded.json()).resolves.toMatchObject({ displayName: "こう" });

  const blank = await put(app as never, { displayName: "   ", activityPeriodDays: 30 });
  await expect(blank.json()).resolves.toMatchObject({ displayName: null });
});

test("設定はユーザー単位で分かれる", async () => {
  const repository = new InMemoryUserSettingsRepository();
  const identity = new InMemoryIdentityRepository();
  const a = buildApp("user-a", repository, identity);
  const b = buildApp("user-b", repository, identity);

  await put(a.app as never, { displayName: "A", activityPeriodDays: 7 });
  const other = await b.app.request("/v1/user-settings", { headers: auth }, ENV);

  await expect(other.json()).resolves.toMatchObject({ displayName: null, activityPeriodDays: 30 });
});

test("不正な値は保存せず 400 を返す", async () => {
  const { app, repository } = buildApp();

  const cases = [
    { displayName: null, activityPeriodDays: 31 },
    { displayName: null, activityPeriodDays: "30" },
    { displayName: 42, activityPeriodDays: 30 },
    { displayName: "あ".repeat(41), activityPeriodDays: 30 },
    { activityPeriodDays: 30 },
  ];
  for (const body of cases) {
    const response = await put(app as never, body);
    expect(response.status, JSON.stringify(body)).toBe(400);
  }

  // 1件も保存されていないこと。検証に落ちた要求が部分的に書き込んではならない。
  await expect(repository.get("user-a")).resolves.toBeNull();
});

test("本文が JSON でなければ 400 を返す", async () => {
  const { app } = buildApp();

  const response = await app.request(
    "/v1/user-settings",
    { method: "PUT", headers: jsonAuth, body: "not-json" },
    ENV,
  );

  expect(response.status).toBe(400);
});

test("認証が無ければ読み書きとも拒否する", async () => {
  const { app } = buildApp();

  const read = await app.request("/v1/user-settings", {}, ENV);
  const write = await app.request(
    "/v1/user-settings",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: null, activityPeriodDays: 30 }),
    },
    ENV,
  );

  expect(read.status).toBe(401);
  expect(write.status).toBe(401);
});
