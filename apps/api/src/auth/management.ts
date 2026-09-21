/**
 * Auth0 Management API のうち、退会で使うユーザー削除だけを扱う。
 *
 * 退会は D1 → Auth0 の順で行う（docs/auth.md §8）。ここはその後半である。
 *
 * `fetch` を注入可能にするのは検証器（`verifier.ts`）と同じ理由で、
 * `test:unit` を素の vitest のまま保つため。
 */

import type { IdentityProviderUsers } from "../routes/account.js";

const REQUEST_TIMEOUT_MS = 10_000;

/** Management API の設定。どれか一つでも欠けたら組み立てない。 */
export interface ManagementConfig {
  /** Auth0 の issuer。`AUTH_ISSUER` をそのまま使う（末尾スラッシュの有無は問わない）。 */
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
}

/** 設定の欠落と Auth0 側の失敗を区別する。前者は 500、後者は再実行可能な失敗。 */
export class ManagementConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagementConfigurationError";
  }
}

export class ManagementRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ManagementRequestError";
  }
}

/**
 * 設定から Management API の入口を組み立てる。
 *
 * **設定が欠けていたら素通りさせず落とす。** 「設定が無いから何もしない」に
 * すると、退会が D1 だけ消して成功を返し、IdP にユーザーが残っていることを
 * 誰も知らないまま進む（.agents/rules/rules.md RULE-004）。
 *
 * `issuer` は https に限る。Management API のトークンは全ユーザーを消せる
 * 資格情報であり、平文 HTTP の相手へ送ってよいものではない（RULE-003）。
 * ここに loopback の例外は置かない。Auth0 はローカルに立たない。
 */
export function createManagementUsers(config: {
  issuer: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  fetch: typeof fetch;
}): IdentityProviderUsers {
  const { issuer, clientId, clientSecret } = config;
  if (!issuer || !clientId || !clientSecret) {
    throw new ManagementConfigurationError(
      "AUTH_ISSUER, AUTH_MANAGEMENT_CLIENT_ID and AUTH_MANAGEMENT_CLIENT_SECRET are required to delete an account",
    );
  }

  let origin: URL;
  try {
    origin = new URL(issuer);
  } catch (cause) {
    // 元の失敗を捨てない。どう壊れていたかが分からないと設定を直せない。
    throw new ManagementConfigurationError(
      `AUTH_ISSUER must be a valid URL: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (origin.protocol !== "https:") {
    throw new ManagementConfigurationError("AUTH_ISSUER must use HTTPS");
  }

  return new Auth0ManagementUsers({
    issuer: origin.origin,
    clientId,
    clientSecret,
    fetch: config.fetch,
  });
}

class Auth0ManagementUsers implements IdentityProviderUsers {
  constructor(private readonly config: ManagementConfig) {}

  async delete(userId: string): Promise<void> {
    const token = await this.accessToken();

    // `sub` は `auth0|abc` のように `|` を含む。エンコードしないとパスが壊れる。
    const url = `${this.config.issuer}/api/v2/users/${encodeURIComponent(userId)}`;
    let response: Response;
    try {
      response = await this.config.fetch(url, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
        // 資格情報を載せるのでリダイレクトを追跡しない（RULE-002）。
        redirect: "error",
        // 単発の外向きリクエスト。応答が返らないまま待ち続けない（RULE-001）。
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new ManagementRequestError("failed to reach the Auth0 Management API", { cause });
    }

    // 204 が成功。404 は「既に居ない」で、退会としては達成されている
    // （前回の退会が Auth0 まで通っていた場合の再実行がこれに当たる）。
    if (response.status === 204 || response.status === 404) return;

    // 2xx 以外を成功に丸めない。本文は失敗の診断のためだけに読む。
    const detail = await response.text().catch(() => "");
    throw new ManagementRequestError(
      `Auth0 Management API returned ${response.status}: ${detail.slice(0, 200)}`,
    );
  }

  /**
   * client_credentials で Management API のアクセストークンを得る。
   *
   * キャッシュしない。退会は利用者一人につき一度きりの操作で、頻度が
   * トークンの寿命に対して十分低い。持ち回す価値より、全ユーザーを消せる
   * 資格情報をメモリに残す時間を短くすることを採る。
   */
  private async accessToken(): Promise<string> {
    let response: Response;
    try {
      response = await this.config.fetch(`${this.config.issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          audience: `${this.config.issuer}/api/v2/`,
        }),
      });
    } catch (cause) {
      throw new ManagementRequestError("failed to reach the Auth0 token endpoint", { cause });
    }

    if (!response.ok) {
      throw new ManagementRequestError(
        `Auth0 token endpoint returned ${response.status} for the management client`,
      );
    }

    // 2xx でも本文の解析に失敗したなら、それは失敗である（RULE-004）。
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new ManagementRequestError("failed to parse the Auth0 token response", { cause });
    }
    const accessToken =
      typeof body === "object" && body !== null
        ? (body as { access_token?: unknown }).access_token
        : undefined;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new ManagementRequestError("the Auth0 token response has no access_token");
    }
    return accessToken;
  }
}
