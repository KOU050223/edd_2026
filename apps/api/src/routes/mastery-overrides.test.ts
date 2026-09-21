import { expect, test } from "vitest";
import { Hono } from "hono";
import { type AuthVariables } from "../auth/middleware.js";
import { TEST_TOKEN, stubAuth } from "../auth/test-auth.js";
import { InMemoryIdentityRepository } from "../repository/memory.js";
import { InMemoryMasteryOverrideRepository } from "../repository/mastery-overrides.js";
import { createMasteryOverridesRoute } from "./mastery-overrides.js";

/** 認証は `stubAuth` が担うので、env に資格情報は要らない。 */
const ENV = {};

function buildApp(
  repository = new InMemoryMasteryOverrideRepository(),
  identity = new InMemoryIdentityRepository(),
) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  app.route(
    "/v1",
    createMasteryOverridesRoute(() => ({
      identity,
      repository,
      nowIso: () => "2026-09-21T00:00:00.000Z",
      nowMs: () => 1_000,
    })),
  );
  return { app, identity, repository };
}

test("手動上書きをユーザー単位で保存し、再読み込みできる", async () => {
  const { app, identity } = buildApp();

  const saved = await app.request(
    "/v1/mastery-overrides",
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conceptId: "go.pointer", status: "confirmed" }),
    },
    ENV as unknown as CloudflareBindings,
  );
  const loaded = await app.request(
    "/v1/mastery-overrides",
    { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
    ENV as unknown as CloudflareBindings,
  );

  expect(saved.status).toBe(200);
  expect(identity.users.has("user-a")).toBe(true);
  await expect(loaded.json()).resolves.toEqual({
    "go.pointer": { status: "confirmed", updatedAt: "2026-09-21T00:00:00.000Z" },
  });
});

test("不正な上書きは保存せず400を返す", async () => {
  const { app, repository } = buildApp();

  const response = await app.request(
    "/v1/mastery-overrides",
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conceptId: "go.pointer", status: "mastered" }),
    },
    ENV as unknown as CloudflareBindings,
  );

  expect(response.status).toBe(400);
  await expect(repository.listByUser("user-a")).resolves.toEqual({});
});

test("形式が不正なConcept IDは保存せず400を返す", async () => {
  const { app, repository } = buildApp();

  const response = await app.request(
    "/v1/mastery-overrides",
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conceptId: "__proto__", status: "confirmed" }),
    },
    ENV as unknown as CloudflareBindings,
  );

  expect(response.status).toBe(400);
  await expect(repository.listByUser("user-a")).resolves.toEqual({});
});

test("異なるユーザーの上書きを混ぜない", async () => {
  const repository = new InMemoryMasteryOverrideRepository();
  await repository.put("user-a", "go.pointer", "confirmed", "2026-09-21T00:00:00.000Z");

  await expect(repository.listByUser("user-b")).resolves.toEqual({});
});

test("nullで上書きを削除する", async () => {
  const { app } = buildApp();
  const put = (status: string | null) =>
    app.request(
      "/v1/mastery-overrides",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conceptId: "go.pointer", status }),
      },
      ENV as unknown as CloudflareBindings,
    );

  await put("confirmed");
  const cleared = await put(null);

  await expect(cleared.json()).resolves.toEqual({});
});

test("退会マーカーがあるユーザーの上書きを再作成しない", async () => {
  const { app, identity, repository } = buildApp();
  await identity.startUserDeletion("user-a", 1_000);

  const response = await app.request(
    "/v1/mastery-overrides",
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conceptId: "go.pointer", status: "confirmed" }),
    },
    ENV as unknown as CloudflareBindings,
  );

  expect(response.status).toBe(500);
  expect(identity.users.has("user-a")).toBe(false);
  await expect(repository.listByUser("user-a")).resolves.toEqual({});
});
