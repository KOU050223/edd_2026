import { expect, test } from "vitest";
import { Hono } from "hono";
import type { Concept, LearningEvent } from "@gakushu-sochi/domain";
import { type AuthVariables } from "../auth/middleware.js";
import { TEST_TOKEN, stubAuth } from "../auth/test-auth.js";
import { InMemoryAreaCompletionRepository } from "../repository/area-completions.js";
import { InMemoryMasteryOverrideRepository } from "../repository/mastery-overrides.js";
import {
  InMemoryIdentityRepository,
  InMemoryLearningEventRepository,
} from "../repository/memory.js";
import { createAreaCompletionsRoute } from "./area-completions.js";

/** 認証は `stubAuth` が担うので、env に資格情報は要らない。 */
const ENV = {};

const definition = (id: string): Concept => ({
  id,
  label: id,
  language: id.split(".")[0] ?? "",
  prerequisites: [],
  source: { kind: "manual" },
});

/** go は 2 件、ts は 1 件。go を「全件」にするには 2 件とも要る。 */
const DEFINITIONS = [definition("go.a"), definition("go.b"), definition("ts.a")];

const solved = (conceptId: string, id: string): LearningEvent => ({
  id,
  type: "solved_independently",
  occurredAt: "2026-09-20T00:00:00.000Z",
  origin: "vscode",
  conceptIds: [conceptId],
});

function buildApp(
  completions = new InMemoryAreaCompletionRepository(),
  overrides = new InMemoryMasteryOverrideRepository(),
  events = new InMemoryLearningEventRepository(),
  identity = new InMemoryIdentityRepository(),
) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  app.route(
    "/v1",
    createAreaCompletionsRoute(() => ({
      identity,
      events,
      overrides,
      completions,
      definitions: DEFINITIONS,
      nowIso: () => "2026-09-26T00:00:00.000Z",
      nowMs: () => 1_000,
    })),
  );
  const check = () =>
    app.request(
      "/v1/area-completions:check",
      { method: "POST", headers: { authorization: `Bearer ${TEST_TOKEN}` } },
      ENV,
    );
  return { app, check, completions, overrides, events, identity };
}

/** 手動上書きで全件 確認済みにする。イベントを組み立てるより短く済む。 */
async function confirmAll(
  overrides: InMemoryMasteryOverrideRepository,
  conceptIds: readonly string[],
) {
  for (const conceptId of conceptIds) {
    await overrides.put("user-a", conceptId, "confirmed", "2026-09-25T00:00:00.000Z");
  }
}

test("1件でも未観測が残っている分野は達成にしない", async () => {
  const { check, overrides } = buildApp();
  await confirmAll(overrides, ["go.a"]);

  const response = await check();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ completions: [], newlyCompleted: [] });
});

test("分野の Concept が全件 確認済みになったら達成として記録する", async () => {
  const { check, overrides } = buildApp();
  await confirmAll(overrides, ["go.a", "go.b"]);

  const body = (await (await check()).json()) as {
    completions: { language: string; completedAt: string }[];
    newlyCompleted: string[];
  };

  expect(body.newlyCompleted).toEqual(["go"]);
  expect(body.completions).toEqual([{ language: "go", completedAt: "2026-09-26T00:00:00.000Z" }]);
});

test("同じ分野を二重に数えず、最初の達成時刻を残す", async () => {
  const { check, completions, overrides } = buildApp();
  await completions.record("user-a", ["go"], "2026-09-01T00:00:00.000Z");
  await confirmAll(overrides, ["go.a", "go.b"]);

  const body = (await (await check()).json()) as {
    completions: { language: string; completedAt: string }[];
    newlyCompleted: string[];
  };

  // 2 回目以降は祝わない。画面を開き直すたびに同じ達成を祝わないため。
  expect(body.newlyCompleted).toEqual([]);
  expect(body.completions).toEqual([{ language: "go", completedAt: "2026-09-01T00:00:00.000Z" }]);
});

test("学習イベントだけでも達成を判定する（手動上書きは要らない）", async () => {
  const { check, events } = buildApp();
  // 自力解決が 2 件たまると confirmed になる（packages/domain の `deriveStatus`）。
  await events.append(
    "user-a",
    ["go.a", "go.b"].flatMap((conceptId, area) =>
      [0, 1].map((n) => ({
        event: solved(conceptId, `e${area}-${n}`),
        clientId: "device-a",
        receivedAtMs: 1,
      })),
    ),
  );

  const body = (await (await check()).json()) as { newlyCompleted: string[] };

  expect(body.newlyCompleted).toEqual(["go"]);
});

test("達成が無いときは users 行を作らない（書き込みを走らせない）", async () => {
  const { check, identity } = buildApp();

  await check();

  expect(identity.users.has("user-a")).toBe(false);
});

test("認証が無ければ拒否する", async () => {
  const { app } = buildApp();

  const response = await app.request("/v1/area-completions:check", { method: "POST" }, ENV);

  expect(response.status).toBe(401);
});
