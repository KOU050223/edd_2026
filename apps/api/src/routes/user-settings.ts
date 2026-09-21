/**
 * `GET` / `PUT /v1/user-settings`。ログインした個人の設定の読み書き。
 *
 * 対象のユーザーは `c.get("user").userId` だけから決める。パスにもボディにも
 * userId を取らない（`routes/account.ts` と同じ規律）。
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_USER_SETTINGS, validateUserSettings } from "../contract/user-settings.js";
import type { AuthVariables } from "../auth/middleware.js";
import type { IdentityRepository, UserSettingsRepository } from "../repository/types.js";

export interface UserSettingsDeps {
  identity: IdentityRepository;
  repository: UserSettingsRepository;
  nowIso: () => string;
  nowMs: () => number;
}

export type UserSettingsDepsResolver = (env: CloudflareBindings) => UserSettingsDeps;

export function createUserSettingsRoute(resolve: UserSettingsDepsResolver) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  app.get("/user-settings", async (c) => {
    const settings = await resolve(c.env).repository.get(c.get("user").userId);
    // 未保存なら既定値を返す。404 にしない。画面から見れば「まだ何も設定していない」
    // は正常な状態であり、エラーとして扱うと初回表示が必ず失敗経路を通る。
    return c.json(settings ?? DEFAULT_USER_SETTINGS, 200, { "cache-control": "no-store" });
  });

  app.put("/user-settings", async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "invalid request body" });
    }
    const validated = validateUserSettings(payload);
    if (!validated.ok) throw new HTTPException(400, { message: validated.message });

    const deps = resolve(c.env);
    // `user_settings.user_id` は `users(id)` を参照しており、D1 は外部キーを
    // 実際に強制する。行が無いまま INSERT すると FOREIGN KEY constraint failed で落ちる
    // （repository/types.ts の `ensureUser` の説明を参照）。
    await deps.identity.ensureUser({ userId: c.get("user").userId, nowMs: deps.nowMs() });
    const saved = await deps.repository.put(c.get("user").userId, validated.value, deps.nowIso());
    // 保存後の値をそのまま返す。画面はこれを採用するので、
    // 表示している内容と保存された内容が食い違わない。
    return c.json(saved, 200, { "cache-control": "no-store" });
  });

  return app;
}
