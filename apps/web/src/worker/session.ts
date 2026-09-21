/** 撤回可能な opaque session を Workers KV に保存する。 */
const SESSION_PREFIX = "session:";
const LOGIN_PREFIX = "login:";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** `/login` から `/callback` へ戻るまでの寿命。認可画面の操作時間に足りる長さで切る。 */
const LOGIN_TTL_SECONDS = 10 * 60;

/**
 * セッションに紐づく値。
 *
 * **アクセストークンをここに入れない**（docs/auth.md §5.3）。KV 書き込みは読み取りの
 * 10倍の単価で、AT の寿命 15 分だとセッションあたり最大 4 回/時の書き込みになる。
 * AT は Worker のメモリにだけ置き、KV に置くのは Refresh Token と `sub` だけにする。
 */
export interface SessionRecord {
  refreshToken: string;
  sub: string;
}

/**
 * `/login` が発行し `/callback` が消費する、認可完了前の状態。
 *
 * `state` は**ログイン CSRF を防ぐためにある**。PKCE は認可コードの横取りを防ぐが、
 * 攻撃者が自分の認可コードを被害者に踏ませる攻撃は防がない（docs/auth.md §5.3）。
 * `codeVerifier` は PKCE の検証値で、同じく Cookie 経由では渡さず KV に置く。
 */
export interface LoginRecord {
  state: string;
  codeVerifier: string;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function createSession(sessions: KVNamespace, record: SessionRecord): Promise<string> {
  const token = randomToken();
  await writeSession(sessions, token, record);
  return token;
}

/**
 * セッションの値を書き戻す。Refresh Token Rotation で新しい RT を保存するときに使う。
 *
 * TTL を毎回振り直すので、使い続けている限りセッションは 7 日で切れない。
 */
export async function writeSession(
  sessions: KVNamespace,
  token: string,
  record: SessionRecord,
): Promise<void> {
  await sessions.put(`${SESSION_PREFIX}${token}`, JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

/**
 * セッションを読む。
 *
 * 値が壊れている（JSON として読めない、必要な項目が無い）場合は `undefined` を返す。
 * **これは握りつぶしではない**（RULE-004）。形式が違う値は「このセッションは使えない」
 * という判定そのものであり、呼び出し側は再ログインへ倒せる。
 */
export async function readSession(
  sessions: KVNamespace,
  token: string | undefined,
): Promise<SessionRecord | undefined> {
  if (!token) return undefined;
  const raw = await sessions.get(`${SESSION_PREFIX}${token}`);
  if (raw === null) return undefined;
  return parseSessionRecord(raw);
}

function parseSessionRecord(raw: string): SessionRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    console.error("session record is not valid JSON");
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { refreshToken, sub } = value as { refreshToken?: unknown; sub?: unknown };
  if (typeof refreshToken !== "string" || refreshToken.length === 0) return undefined;
  if (typeof sub !== "string" || sub.length === 0) return undefined;
  return { refreshToken, sub };
}

export async function deleteSession(
  sessions: KVNamespace,
  token: string | undefined,
): Promise<void> {
  if (token) await sessions.delete(`${SESSION_PREFIX}${token}`);
}

export async function createLogin(sessions: KVNamespace, record: LoginRecord): Promise<string> {
  const token = randomToken();
  await sessions.put(`${LOGIN_PREFIX}${token}`, JSON.stringify(record), {
    expirationTtl: LOGIN_TTL_SECONDS,
  });
  return token;
}

/**
 * ログイン中の状態を読み、**同時に消す**（一度しか使えない）。
 *
 * 認可コードの再送で同じ `state` を二度通さないための使い捨てにしている。
 */
export async function takeLogin(
  sessions: KVNamespace,
  token: string | undefined,
): Promise<LoginRecord | undefined> {
  if (!token) return undefined;
  const key = `${LOGIN_PREFIX}${token}`;
  const raw = await sessions.get(key);
  await sessions.delete(key);
  return raw === null ? undefined : parseLoginRecord(raw);
}

/**
 * ログイン中の状態を**消さずに**読む。
 *
 * IdP が `error` を返した `/callback` で、それが自分の始めたログインへの応答かを
 * 確かめるために使う。`takeLogin` を使うと、確かめる行為そのものが
 * 進行中のログインを壊してしまう（攻撃者に誘導されるだけで中断できてしまう）。
 */
export async function peekLogin(
  sessions: KVNamespace,
  token: string | undefined,
): Promise<LoginRecord | undefined> {
  if (!token) return undefined;
  const raw = await sessions.get(`${LOGIN_PREFIX}${token}`);
  return raw === null ? undefined : parseLoginRecord(raw);
}

function parseLoginRecord(raw: string): LoginRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    console.error("login record is not valid JSON");
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { state, codeVerifier } = value as { state?: unknown; codeVerifier?: unknown };
  if (typeof state !== "string" || state.length === 0) return undefined;
  if (typeof codeVerifier !== "string" || codeVerifier.length === 0) return undefined;
  return { state, codeVerifier };
}

export const sessionCookie = (token: string) =>
  `session=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;

export const expiredSessionCookie = "session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

/**
 * 認可完了前だけ有効な Cookie。
 *
 * `SameSite=Lax` は IdP からのトップレベル GET リダイレクトには載る。
 * `None` にすると必要のないクロスサイト送信まで許すことになるので広げない。
 */
export const loginCookie = (token: string) =>
  `login=${token}; Path=/; Max-Age=${LOGIN_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;

export const expiredLoginCookie = "login=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

export function cookieValue(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
