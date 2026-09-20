import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createAuth, type AuthVariables } from "../auth/middleware.js";
import type { AuthVerifier } from "../auth/verifier.js";
import { InMemoryIdentityRepository } from "../repository/memory.js";
import { createAccountRoute, type IdentityProviderUsers } from "./account.js";

const VERIFIER: AuthVerifier = {
  verify: (token) =>
    token === "valid-token"
      ? Promise.resolve({ sub: "auth0|user-a" })
      : Promise.reject(new Error("unexpected token in test")),
};

/**
 * 呼び出しの順序を記録する組。
 *
 * 退会の不変条件は「D1 が先、Auth0 が後」なので、どちらが呼ばれたかではなく
 * **どの順で呼ばれたか**を見る必要がある（docs/auth.md §8）。
 */
function buildDeps(options: { d1Fails?: boolean; idpFails?: boolean } = {}) {
  const calls: string[] = [];
  const identity = new InMemoryIdentityRepository();
  const originalDelete = identity.deleteUser.bind(identity);
  identity.deleteUser = (userId: string) => {
    calls.push("d1");
    if (options.d1Fails) return Promise.reject(new Error("D1 is unavailable"));
    return originalDelete(userId);
  };

  const idp: IdentityProviderUsers = {
    delete: () => {
      calls.push("auth0");
      return options.idpFails
        ? Promise.reject(new Error("Auth0 Management API returned 500"))
        : Promise.resolve();
    },
  };

  return { calls, identity, idp };
}

function buildApp(deps: { identity: InMemoryIdentityRepository; idp: IdentityProviderUsers }) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use(
    "/v1/*",
    createAuth(() => VERIFIER),
  );
  app.route(
    "/v1",
    createAccountRoute(() => deps),
  );
  return app;
}

function request(app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>) {
  return app.request(
    "/v1/me",
    { method: "DELETE", headers: { Authorization: "Bearer valid-token" } },
    {} as CloudflareBindings,
  );
}

describe("DELETE /v1/me", () => {
  it("D1 を先に消し、その後 Auth0 のユーザーを消す", async () => {
    const deps = buildDeps();
    deps.identity.users.set("auth0|user-a", { createdAtMs: 0 });

    const response = await request(buildApp(deps));

    expect(response.status).toBe(204);
    expect(deps.calls).toEqual(["d1", "auth0"]);
    expect(deps.identity.users.has("auth0|user-a")).toBe(false);
  });

  it("D1 の削除が失敗したら Auth0 のユーザーを消しに行かない", async () => {
    // 逆順になっていると、二度と認証できない sub の下に学習データだけが残る。
    // 順序の記録だけでは Promise.all の実装も通ってしまうため、
    // 「前段が落ちたら後段が呼ばれない」ことを直接確かめる（docs/auth.md §8）。
    const deps = buildDeps({ d1Fails: true });

    const response = await request(buildApp(deps));

    expect(response.status).toBe(500);
    expect(deps.calls).toEqual(["d1"]);
    expect(deps.calls).not.toContain("auth0");
  });

  it("Auth0 の削除に失敗しても D1 は消えたままで、失敗を握りつぶさない", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = buildDeps({ idpFails: true });
    deps.identity.users.set("auth0|user-a", { createdAtMs: 0 });

    const response = await request(buildApp(deps));

    // 成功として返さない。2xx を返すと、IdP にユーザーが残ったことを誰も知らない。
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "identity_provider_delete_failed",
      dataDeleted: true,
    });
    // 学習データは消えたまま。ここを巻き戻すと Auth0 の一時障害で退会が進まなくなる。
    expect(deps.identity.users.has("auth0|user-a")).toBe(false);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("認証が無ければ何も消さない", async () => {
    const deps = buildDeps();
    deps.identity.users.set("auth0|user-a", { createdAtMs: 0 });

    const response = await buildApp(deps).request(
      "/v1/me",
      { method: "DELETE" },
      {} as CloudflareBindings,
    );

    expect(response.status).toBe(401);
    expect(deps.calls).toEqual([]);
    expect(deps.identity.users.has("auth0|user-a")).toBe(true);
  });

  it("消す対象はトークンの sub であり、リクエストの指定を受け付けない", async () => {
    // userId をパスやボディから取る実装にすると、他人のアカウントを消せる。
    const deps = buildDeps();
    const deleted: string[] = [];
    deps.identity.deleteUser = (userId: string) => {
      deleted.push(userId);
      return Promise.resolve();
    };

    const response = await buildApp(deps).request(
      "/v1/me",
      {
        method: "DELETE",
        headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "auth0|victim" }),
      },
      {} as CloudflareBindings,
    );

    expect(response.status).toBe(204);
    expect(deleted).toEqual(["auth0|user-a"]);
  });

  it("依存の組み立てが失敗したら D1 を消さない", async () => {
    // Management API の設定漏れは削除の前に現れる必要がある。削除の途中で
    // 気付く形だと、学習データだけ消えて IdP のユーザーが残る状態が確定する。
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const identity = new InMemoryIdentityRepository();
    identity.users.set("auth0|user-a", { createdAtMs: 0 });

    const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
    app.use(
      "/v1/*",
      createAuth(() => VERIFIER),
    );
    app.route(
      "/v1",
      createAccountRoute(() => {
        throw new Error("AUTH_MANAGEMENT_CLIENT_SECRET is not configured");
      }),
    );

    const response = await request(app);

    expect(response.status).toBe(500);
    expect(identity.users.has("auth0|user-a")).toBe(true);

    consoleError.mockRestore();
  });
});
