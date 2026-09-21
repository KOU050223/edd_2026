import { expect, test } from "vitest";
import { Hono } from "hono";
import { createAuth, requireAuth, type AuthVariables } from "./middleware.js";
import { AuthVerificationError, type AuthFailureKind, type VerifiedToken } from "./verifier.js";

// ---------------------------------------------------------------------------
// createAuth: 認証ミドルウェア（docs/auth.md §4 / §11 の Auth/11 ①）
//
// ここで挿すのは偽の `AuthVerifier` である。この層で固定するのは
// 「検証器の判断を HTTP の応答へどう変換するか」だけであって、
// 署名や `nbf` の検証そのものではない。偽の検証器には検証すべき署名が無いため、
// それらは `verifier.test.ts` が本物の JWT で固定する。
// ---------------------------------------------------------------------------

/** 指定した結果を返すだけの検証器を挿したアプリを組む。 */
function buildAuthApp(verify: (token: string) => Promise<VerifiedToken>) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use(
    "/protected",
    createAuth(() => ({ verify })),
  );
  app.get("/protected", (c) => c.json({ userId: c.get("user").userId }));
  return (headers: Record<string, string> = {}) =>
    app.request("/protected", { headers }, {} as CloudflareBindings);
}

/** 常に指定の種別で失敗する検証器を挿したアプリ。 */
function buildFailingAuthApp(kind: AuthFailureKind) {
  return buildAuthApp(() =>
    Promise.reject(new AuthVerificationError(kind, `検証に失敗した: ${kind}`)),
  );
}

test("検証器が通したトークンのsubをuserIdにする", async () => {
  // userId は IdP の sub をそのまま使う。可変なメールアドレスを主キーにしない。
  const request = buildAuthApp((token) => {
    expect(token).toBe("valid-token");
    return Promise.resolve({ sub: "auth0|user-a" });
  });

  const res = await request({ Authorization: "Bearer valid-token" });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ userId: "auth0|user-a" });
});

test("検証器が拒否したら401にする", async () => {
  const request = buildFailingAuthApp("invalid_token");

  expect((await request({ Authorization: "Bearer bad-token" })).status).toBe(401);
});

test("設定が欠けていたら401ではなく500にする", async () => {
  // 設定漏れを 401 に丸めると、利用者には「トークンが不正」として現れ、
  // 障害の原因が見えなくなる（.agents/rules/rules.md RULE-004）。
  const request = buildFailingAuthApp("configuration");

  expect((await request({ Authorization: "Bearer any-token" })).status).toBe(500);
});

test("IdPへ到達できなければ503にする", async () => {
  // 到達不能はこちら側の一時的な障害であって、トークンの不正ではない。
  // 401 にすると利用者は無駄に再ログインを試みることになる。
  const request = buildFailingAuthApp("unavailable");

  expect((await request({ Authorization: "Bearer any-token" })).status).toBe(503);
});

test("検証器が想定外の例外を投げても素通りさせず500にする", async () => {
  // 種別の判らない失敗を通してしまうのが最悪である。落とす側へ倒す。
  const request = buildAuthApp(() => Promise.reject(new TypeError("想定外")));

  expect((await request({ Authorization: "Bearer any-token" })).status).toBe(500);
});

test("Authorizationヘッダが無ければ検証器を呼ばずに401にする", async () => {
  let called = false;
  const request = buildAuthApp(() => {
    called = true;
    return Promise.resolve({ sub: "auth0|user-a" });
  });

  expect((await request()).status).toBe(401);
  expect(called).toBe(false);
});

test("Bearerを省いた生のトークンは検証器へ渡さない", async () => {
  // 形式を緩めると、認証方式を差し替えるときに古い形式が残っているか判定できない。
  let called = false;
  const request = buildAuthApp(() => {
    called = true;
    return Promise.resolve({ sub: "auth0|user-a" });
  });

  expect((await request({ Authorization: "raw-token" })).status).toBe(401);
  expect(called).toBe(false);
});

test("検証器の組み立てで落ちても種別を保って500にする", async () => {
  // 設定欠落は `resolve` の側で投げられる。組み立てを try の外に出すと種別が失われ、
  // 本文が「internal server error」になってしまう。
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use(
    "/protected",
    createAuth(() => {
      throw new AuthVerificationError(
        "configuration",
        "AUTH_ISSUER and AUTH_AUDIENCE are not configured",
      );
    }),
  );
  app.get("/protected", (c) => c.json({ ok: true }));

  const res = await app.request(
    "/protected",
    { headers: { Authorization: "Bearer any-token" } },
    {} as CloudflareBindings,
  );

  expect(res.status).toBe(500);
  expect(await res.text()).toContain("authentication is not configured");
});

test("AUTH_ISSUERとAUTH_AUDIENCEが未設定なら素通りさせず500にする", async () => {
  // docs/auth.md §4 は「未設定なら 500 で落とす」と定めている。
  // 「設定が無いから全員通す」は、設定漏れがそのまま認証の無効化になる。
  //
  // ここだけは `requireAuth`（本番の組み立て）を直接叩く。設定の欠落を見るのは
  // `resolveVerifier` であり、注入した検証器では通らない経路だからである。
  // 欠落の判定は検証器をモジュール水準のキャッシュへ入れる前に落ちるので、
  // 他のテストへ影響しない。
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/protected", requireAuth);
  app.get("/protected", (c) => c.json({ ok: true }));

  const res = await app.request(
    "/protected",
    { headers: { Authorization: "Bearer any-token" } },
    {} as CloudflareBindings,
  );

  expect(res.status).toBe(500);
  expect(await res.text()).toContain("authentication is not configured");
});
