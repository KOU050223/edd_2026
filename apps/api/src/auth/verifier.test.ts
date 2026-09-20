/**
 * 検証器層のテスト（docs/auth.md §4 / §11 の Auth/11 ②）。
 *
 * 偽の `AuthVerifier` では足りない。偽の検証器には検証すべき署名が存在しないため、
 * そこに「不正な署名」を並べても、確かめているのは「検証器が拒否したら
 * ミドルウェアが 401 にする」という別の命題になる。ここでは RS256 の鍵を実際に
 * 生成し、スタブの JWKS を返す `fetch` を注入して、**本物の JWT** を検証する。
 * 署名や `nbf` の検証が壊れたら、このファイルが落ちる。
 *
 * WebCrypto は Node にあるので `test:unit` は素の vitest のまま（Worker ランタイム
 * 不要）で通る。
 *
 * ## §4 の検証項目との対応
 *
 * | docs/auth.md §4 の項目            | テスト                                          |
 * | --------------------------------- | ----------------------------------------------- |
 * | 署名                              | 「正しい署名の…通す」「署名が改ざん…401」        |
 * |                                   | 「別の鍵で署名した…401」「RS256以外…401」        |
 * | `iss` が設定した issuer と一致    | 「issが設定値と違えば401」                       |
 * | `aud` が自 API の audience と一致 | 「audが自APIと違えば401」「audが配列…」          |
 * | `exp`                             | 「expが切れていれば401」「expが無ければ401」     |
 * | `nbf`                             | 「nbfが未来なら401」                             |
 * | 起動時: Discovery の `issuer` 一致 | 「Discoveryのissuerが…一致しなければ500」        |
 * | 起動時: `AUTH_ISSUER` が https    | 「AUTH_ISSUERがhttpsでなければ500」              |
 * | 起動時: `jwks_uri` が許可ホスト   | 「jwks_uriが許可外のホスト…500」                 |
 * |                                   | 「jwks_uriがissuerと別のホスト…500」             |
 *
 * `AUTH_ISSUER` / `AUTH_AUDIENCE` 自体の欠落（§4「未設定なら 500 で落とす」）は
 * `middleware.ts` の `resolveVerifier` が判定するため、`middleware.test.ts` の
 * 「AUTH_ISSUERとAUTH_AUDIENCEが未設定なら素通りさせず500にする」が固定している。
 */

import { expect, test } from "vitest";
import { Auth0Verifier, AuthVerificationError } from "./verifier.js";

/**
 * 許可された issuer のホストを使う。
 *
 * `ALLOWED_ISSUER_HOSTS` は設定項目ではなくコードの定数である（docs/auth.md §4 が
 * 「設定できなくして消す」ことを求めている）。したがってテストもそのホストに従う。
 * 末尾のスラッシュまで含めて、Discovery 文書の `issuer` と**完全一致**させる必要がある。
 */
const ISSUER = "https://gakushu-sochi.jp.auth0.com/";
const JWKS_URI = "https://gakushu-sochi.jp.auth0.com/.well-known/jwks.json";
const AUDIENCE = "https://api.gakushu-sochi.dev";
const KID = "key-1";

/**
 * 署名に使う鍵。
 *
 * 2048bit の RSA 鍵の生成は安くないので、モジュールで一度だけ作って使い回す。
 * 検証器の側はテストごとに作り直す（取り込んだ鍵と Discovery の結果を
 * インスタンスが抱えるため）。
 */
const signingKey = await generateSigningKey();
/** 「別の鍵で署名されたトークン」を作るための、JWKS に載せない鍵。 */
const foreignKey = await generateSigningKey();

interface SigningKey {
  privateKey: CryptoKey;
  jwk: JsonWebKey;
}

async function generateSigningKey(): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  return { privateKey: pair.privateKey, jwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

/** 公開鍵を JWKS の1件として表す。`kid` はこちらで付ける。 */
function jwksEntry(key: SigningKey, kid = KID): Record<string, unknown> {
  return { kty: "RSA", alg: "RS256", use: "sig", kid, n: key.jwk.n, e: key.jwk.e };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodeSegment(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * 本物の署名を持つ JWT を組み立てる。
 *
 * 既定は「通るはずのトークン」。個々のテストは、確かめたい1項目だけを崩す。
 */
async function signJwt(
  options: {
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    key?: SigningKey;
  } = {},
): Promise<string> {
  const key = options.key ?? signingKey;
  const header = { alg: "RS256", typ: "JWT", kid: KID, ...options.header };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "auth0|user-a",
    exp: nowSeconds() + 3600,
    ...options.claims,
  };

  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

interface StubOptions {
  /** Discovery 文書。既定は `ISSUER` と一致する正しいもの。 */
  discovery?: Record<string, unknown>;
  /** JWKS に載せる鍵。既定は署名に使った鍵だけ。 */
  jwks?: Record<string, unknown>;
  /** 検証器へ渡す `AUTH_ISSUER`。既定は許可されたホスト。 */
  issuer?: string;
}

/**
 * Discovery と JWKS を返すスタブの `fetch` を挿した検証器を組み立てる。
 *
 * これが docs/auth.md §4 の言う2つ目の継ぎ目である。外向きの通信はここで止まる。
 * 取得した URL も記録し、「取りに行かせていないこと」を確かめられるようにする。
 */
function buildVerifier(options: StubOptions = {}) {
  const issuer = options.issuer ?? ISSUER;
  const discovery = options.discovery ?? { issuer: ISSUER, jwks_uri: JWKS_URI };
  const jwks = options.jwks ?? { keys: [jwksEntry(signingKey)] };
  const requested: string[] = [];

  const stubFetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const body = url.endsWith("openid-configuration") ? discovery : jwks;
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }),
    );
  }) as typeof fetch;

  return {
    requested,
    verifier: new Auth0Verifier({ issuer, audience: AUDIENCE, fetch: stubFetch }),
  };
}

/**
 * 検証が指定した種別で失敗することを確かめる。
 *
 * 種別まで見る。`invalid_token`（401）と `configuration`（500）を区別しないと、
 * 設定の誤りがトークンの不正として現れる経路を見逃す
 * （.agents/rules/rules.md RULE-004）。
 */
async function expectRejection(
  promise: Promise<unknown>,
  kind: "invalid_token" | "configuration" | "unavailable",
): Promise<AuthVerificationError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error, "検証が失敗するはずのところで成功した").toBeInstanceOf(AuthVerificationError);
  const failure = error as AuthVerificationError;
  expect(failure.kind).toBe(kind);
  return failure;
}

// ---------------------------------------------------------------------------
// 署名（§4「署名」）
// ---------------------------------------------------------------------------

test("正しい署名のトークンはsubを返して通す", async () => {
  const { verifier } = buildVerifier();

  expect(await verifier.verify(await signJwt())).toEqual({ sub: "auth0|user-a" });
});

test("署名が改ざんされていれば401にする", async () => {
  // 署名の最後の1文字だけを差し替える。他はすべて正しいトークンのまま。
  const { verifier } = buildVerifier();
  const token = await signJwt();
  const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

  await expectRejection(verifier.verify(tampered), "invalid_token");
});

test("JWKSに無い別の鍵で署名したトークンは401にする", async () => {
  // kid は JWKS にある鍵を指すが、実際の署名は別の鍵で作られている。
  // 鍵を引く処理だけで満足して署名を確かめないと、これが通ってしまう。
  const { verifier } = buildVerifier();

  await expectRejection(verifier.verify(await signJwt({ key: foreignKey })), "invalid_token");
});

test("JWKSに無いkidを名乗るトークンは401にする", async () => {
  const { verifier } = buildVerifier();

  await expectRejection(
    verifier.verify(await signJwt({ header: { kid: "unknown" } })),
    "invalid_token",
  );
});

test("RS256以外のalgを名乗るトークンは鍵を引く前に401にする", async () => {
  // ヘッダの `alg` を信じると `none` で署名検証を飛ばす古典的な攻撃が成立する。
  const { requested, verifier } = buildVerifier();

  await expectRejection(
    verifier.verify(await signJwt({ header: { alg: "HS256" } })),
    "invalid_token",
  );
  expect(requested).toEqual([]);
});

test("JWTの形をしていない文字列は401にする", async () => {
  const { verifier } = buildVerifier();

  await expectRejection(verifier.verify("not-a-jwt"), "invalid_token");
});

// ---------------------------------------------------------------------------
// iss / aud / exp / nbf（§4 の検証項目）
// ---------------------------------------------------------------------------

test("issが設定したissuerと違えば401にする", async () => {
  const { verifier } = buildVerifier();
  const token = await signJwt({ claims: { iss: "https://evil.example.com/" } });

  await expectRejection(verifier.verify(token), "invalid_token");
});

test("audが自APIのaudienceと違えば401にする", async () => {
  // これを省くと、同じ Auth0 テナントの別アプリ向けトークンで自 API を呼べる。
  const { verifier } = buildVerifier();
  const token = await signJwt({ claims: { aud: "https://other-api.example.com" } });

  await expectRejection(verifier.verify(token), "invalid_token");
});

test("audが配列でも自APIが含まれていれば通す", async () => {
  // Auth0 は audience が複数あるとき配列を返す。配列を扱えないと正当なトークンを拒む。
  const { verifier } = buildVerifier();
  const token = await signJwt({ claims: { aud: ["https://other-api.example.com", AUDIENCE] } });

  expect(await verifier.verify(token)).toEqual({ sub: "auth0|user-a" });
});

test("audが配列で自APIを含まなければ401にする", async () => {
  const { verifier } = buildVerifier();
  const token = await signJwt({
    claims: { aud: ["https://a.example.com", "https://b.example.com"] },
  });

  await expectRejection(verifier.verify(token), "invalid_token");
});

test("expが切れていれば401にする", async () => {
  // 時計のずれに許す 60 秒を十分に超えた過去にする。境界ぎりぎりだと、
  // 検証が壊れていても実行の速さで緑になることがある。
  const { verifier } = buildVerifier();
  const token = await signJwt({ claims: { exp: nowSeconds() - 3600 } });

  await expectRejection(verifier.verify(token), "invalid_token");
});

test("expが無いトークンは401にする", async () => {
  // 期限の無いトークンは失効しない。無期限の資格情報として扱わない。
  const { verifier } = buildVerifier();
  const token = await signJwt({ claims: { exp: undefined } });

  await expectRejection(verifier.verify(token), "invalid_token");
});

test("nbfが未来ならまだ有効でないとして401にする", async () => {
  const { verifier } = buildVerifier();
  const token = await signJwt({ claims: { nbf: nowSeconds() + 3600 } });

  await expectRejection(verifier.verify(token), "invalid_token");
});

test("nbfが過去なら通す", async () => {
  const { verifier } = buildVerifier();
  const token = await signJwt({ claims: { nbf: nowSeconds() - 3600 } });

  expect(await verifier.verify(token)).toEqual({ sub: "auth0|user-a" });
});

test("subが無いトークンは401にする", async () => {
  // userId の実体が無いまま通すと、全員が同じ空文字として数えられる。
  const { verifier } = buildVerifier();

  await expectRejection(
    verifier.verify(await signJwt({ claims: { sub: undefined } })),
    "invalid_token",
  );
});

test("クレームの検証は署名を確かめた後に行う", async () => {
  // 逆順にすると、署名されていない値に基づいて判断することになる。
  // 署名が壊れていれば、クレームがすべて不正でも「署名が不正」として落ちる。
  const { verifier } = buildVerifier();
  const token = await signJwt({
    key: foreignKey,
    claims: { iss: "https://evil.example.com/", exp: nowSeconds() - 3600 },
  });

  const error = await expectRejection(verifier.verify(token), "invalid_token");
  expect(error.message).toContain("signature");
});

// ---------------------------------------------------------------------------
// 起動時の拒否（§4「起動時に確かめ、外れたら 500 で落とす」）
// ---------------------------------------------------------------------------

test("AUTH_ISSUERがhttpsでなければ500にする", async () => {
  // 平文 HTTP を許すと、経路上で鍵をすり替えられる。
  const { requested, verifier } = buildVerifier({ issuer: "http://gakushu-sochi.jp.auth0.com/" });

  await expectRejection(verifier.verify(await signJwt()), "configuration");
  // 取りに行く前に落ちている。
  expect(requested).toEqual([]);
});

test("AUTH_ISSUERが許可外のホストなら500にする", async () => {
  // 許可リストはコードにある。設定で任意の issuer を指せるなら、JWKS の取得先を
  // 設定できなくした意味が無くなる。
  const { requested, verifier } = buildVerifier({ issuer: "https://evil.example.com/" });

  await expectRejection(verifier.verify(await signJwt()), "configuration");
  expect(requested).toEqual([]);
});

test("AUTH_ISSUERがURLとして壊れていれば500にする", async () => {
  const { verifier } = buildVerifier({ issuer: "not a url" });

  await expectRejection(verifier.verify(await signJwt()), "configuration");
});

test("Discoveryのissuerが AUTH_ISSUER と一致しなければ500にする", async () => {
  const { verifier } = buildVerifier({
    discovery: { issuer: "https://gakushu-sochi.jp.auth0.com/other/", jwks_uri: JWKS_URI },
  });

  await expectRejection(verifier.verify(await signJwt()), "configuration");
});

test("jwks_uriが許可外のホストなら500にする", async () => {
  // Discovery 自体が乗っ取られた場合に、鍵の取得先だけ逃がされるのを防ぐ。
  const { verifier } = buildVerifier({
    discovery: { issuer: ISSUER, jwks_uri: "https://evil.example.com/.well-known/jwks.json" },
  });

  await expectRejection(verifier.verify(await signJwt()), "configuration");
});

test("jwks_uriがhttpsでなければ500にする", async () => {
  const { verifier } = buildVerifier({
    discovery: {
      issuer: ISSUER,
      jwks_uri: "http://gakushu-sochi.jp.auth0.com/.well-known/jwks.json",
    },
  });

  await expectRejection(verifier.verify(await signJwt()), "configuration");
});

test("jwks_uriが許可ホストでもissuerと別のホストなら500にする", async () => {
  // 許可リストに載っているだけでは足りない。許可された別テナントへ鍵の取得先を
  // 逃がされると、そのテナントの鍵で署名したトークンが通る。
  const { verifier } = buildVerifier({
    discovery: { issuer: ISSUER, jwks_uri: "https://auth.gakushu-sochi.dev/.well-known/jwks.json" },
  });

  await expectRejection(verifier.verify(await signJwt()), "configuration");
});

// ---------------------------------------------------------------------------
// 取得の失敗を「トークンの不正」に丸めない（RULE-004）
// ---------------------------------------------------------------------------

test("Discoveryが取得できなければ401ではなく到達不能として扱う", async () => {
  // 401 に丸めると、Auth0 への到達不能が「トークンが違う」として現れ、
  // 利用者は無駄に再ログインを試みることになる。
  const failingFetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
  const verifier = new Auth0Verifier({ issuer: ISSUER, audience: AUDIENCE, fetch: failingFetch });

  await expectRejection(verifier.verify(await signJwt()), "unavailable");
});

test("Discoveryが2xxでも本文を解析できなければ到達不能として扱う", async () => {
  // HTTP 2xx でも本文の解析に失敗したなら、それは失敗である（RULE-004）。
  const brokenFetch = (() =>
    Promise.resolve(
      new Response("<html>not json</html>", { headers: { "Content-Type": "application/json" } }),
    )) as typeof fetch;
  const verifier = new Auth0Verifier({ issuer: ISSUER, audience: AUDIENCE, fetch: brokenFetch });

  await expectRejection(verifier.verify(await signJwt()), "unavailable");
});

test("JWKSの取得が5xxなら到達不能として扱う", async () => {
  const stubFetch = ((input: RequestInfo | URL) =>
    Promise.resolve(
      String(input).endsWith("openid-configuration")
        ? new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: JWKS_URI }))
        : new Response("upstream error", { status: 503 }),
    )) as typeof fetch;
  const verifier = new Auth0Verifier({ issuer: ISSUER, audience: AUDIENCE, fetch: stubFetch });

  await expectRejection(verifier.verify(await signJwt()), "unavailable");
});

// ---------------------------------------------------------------------------
// 取得の抑制（§4 / §10.4 のコスト要件）
// ---------------------------------------------------------------------------

test("取り込んだ鍵は使い回し、2回目はJWKSを取りに行かない", async () => {
  // リクエストごとに取りに行くと Auth0 への外向き通信が費用になる（§10.4）。
  const { requested, verifier } = buildVerifier();

  await verifier.verify(await signJwt());
  const afterFirst = requested.length;
  await verifier.verify(await signJwt());

  expect(requested.length).toBe(afterFirst);
});

test("未知のkidを投げ続けても外向き通信は回数に比例して増えない", async () => {
  // 未知の `kid` を持つトークンを投げるだけで外向き通信を1リクエストずつ
  // 増やせてはならない（§4）。レート制限は認証の後段なのでここには効かない。
  //
  // 上限を定数で書くと、回数が減る側の退行（予算を使い切る前に諦める）を
  // 見逃す。「試行を5倍にしても通信は増えない」という性質で押さえる。
  const fetchCountFor = async (attempts: number) => {
    const { requested, verifier } = buildVerifier();
    for (let i = 0; i < attempts; i += 1) {
      await expectRejection(
        verifier.verify(await signJwt({ header: { kid: `unknown-${i}` } })),
        "invalid_token",
      );
    }
    return requested.length;
  };

  const few = await fetchCountFor(4);
  const many = await fetchCountFor(20);

  expect(many).toBe(few);
  // 内訳は Discovery の取得1回と、窓あたりの予算ぶんの JWKS 取得3回
  // （JWKS_REFRESH_BUDGET_PER_WINDOW = 3）。予算を使い切った後は取りに行かない。
  expect(few).toBe(4);
});
