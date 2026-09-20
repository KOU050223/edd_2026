import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MasteryStatus } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import type { MasteryOverrideRepository } from "../repository/types.js";

const statuses = [
  "unobserved",
  "learning",
  "confirmed",
] as const satisfies readonly MasteryStatus[];

export interface MasteryOverrideDeps {
  repository: MasteryOverrideRepository;
  nowIso: () => string;
}

export type MasteryOverrideDepsResolver = (env: CloudflareBindings) => MasteryOverrideDeps;

function isStatus(value: unknown): value is MasteryStatus {
  return typeof value === "string" && statuses.includes(value as MasteryStatus);
}

export function createMasteryOverridesRoute(resolve: MasteryOverrideDepsResolver) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  app.get("/mastery-overrides", async (c) => {
    const overrides = await resolve(c.env).repository.listByUser(c.get("user").userId);
    return c.json(overrides, 200, { "cache-control": "no-store" });
  });

  app.put("/mastery-overrides", async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "invalid request body" });
    }
    if (typeof payload !== "object" || payload === null) {
      throw new HTTPException(400, { message: "invalid request body" });
    }
    const { conceptId, status } = payload as { conceptId?: unknown; status?: unknown };
    if (typeof conceptId !== "string" || conceptId.length === 0) {
      throw new HTTPException(400, { message: "conceptId must be a non-empty string" });
    }
    if (status !== null && !isStatus(status)) {
      throw new HTTPException(400, { message: "status must be a valid mastery status or null" });
    }
    const deps = resolve(c.env);
    const overrides = await deps.repository.put(
      c.get("user").userId,
      conceptId,
      status as MasteryStatus | null,
      deps.nowIso(),
    );
    return c.json(overrides, 200, { "cache-control": "no-store" });
  });

  return app;
}
