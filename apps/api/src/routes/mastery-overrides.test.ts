import { expect, test } from "vitest";
import { Hono } from "hono";
import { devAuth, type AuthVariables } from "../auth/middleware.js";
import { InMemoryMasteryOverrideRepository } from "../repository/mastery-overrides.js";
import { createMasteryOverridesRoute } from "./mastery-overrides.js";

const ENV = { DEV_AUTH_TOKEN: "secret", DEV_AUTH_USER_ID: "user-a" };

function buildApp(repository = new InMemoryMasteryOverrideRepository()) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", devAuth);
  app.route(
    "/v1",
    createMasteryOverridesRoute(() => ({ repository, nowIso: () => "2026-09-21T00:00:00.000Z" })),
  );
  return { app, repository };
}

test("手動上書きをユーザー単位で保存し、再読み込みできる", async () => {
  const { app } = buildApp();

  const saved = await app.request(
    "/v1/mastery-overrides",
    {
      method: "PUT",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ conceptId: "go.pointer", status: "confirmed" }),
    },
    ENV as unknown as CloudflareBindings,
  );
  const loaded = await app.request(
    "/v1/mastery-overrides",
    { headers: { Authorization: "Bearer secret" } },
    ENV as unknown as CloudflareBindings,
  );

  expect(saved.status).toBe(200);
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
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ conceptId: "go.pointer", status: "mastered" }),
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
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ conceptId: "go.pointer", status }),
      },
      ENV as unknown as CloudflareBindings,
    );

  await put("confirmed");
  const cleared = await put(null);

  await expect(cleared.json()).resolves.toEqual({});
});
