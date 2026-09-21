import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  parseCallbackUrl,
  refreshAccessToken,
  revokeRefreshToken,
  OAuthTokenError,
  type OAuthConfig,
} from "./oauth.js";

const config: OAuthConfig = {
  issuer: "https://example.auth0.com",
  clientId: "desktop-client",
  audience: "https://api.example.com",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OAuth authorization code flow", () => {
  it("builds an authorization URL with PKCE and offline access", () => {
    const url = buildAuthorizationUrl(
      config,
      "http://127.0.0.1:43123/callback",
      "state-value",
      "challenge-value",
    );

    const params = new URL(url).searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe(config.clientId);
    expect(params.get("audience")).toBe(config.audience);
    expect(params.get("scope")).toBe("openid profile email offline_access");
    expect(params.get("state")).toBe("state-value");
    expect(params.get("code_challenge")).toBe("challenge-value");
    expect(params.get("code_challenge_method")).toBe("S256");
  });

  it("rejects a callback whose state does not match", () => {
    expect(() =>
      parseCallbackUrl(
        "http://127.0.0.1/callback?code=authorization-code&state=attacker-state",
        "expected-state",
      ),
    ).toThrow("OAuth state が一致しません");
  });

  it("returns the authorization code only after validating state", () => {
    expect(
      parseCallbackUrl(
        "http://127.0.0.1/callback?code=authorization-code&state=expected-state",
        "expected-state",
      ),
    ).toBe("authorization-code");
  });

  it("creates a verifier and its S256 challenge", () => {
    const pair = createPkcePair();

    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  it("exchanges an authorization code and requires a refresh token", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const tokens = await exchangeAuthorizationCode(
      config,
      "authorization-code",
      "http://127.0.0.1:43123/callback",
      "verifier",
      fetchMock,
    );

    expect(tokens).toEqual({ accessToken: "access", refreshToken: "refresh" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.auth0.com/oauth/token",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
  });

  it("treats an invalid successful token response as a failure", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("not-json", { status: 200 }));

    await expect(
      exchangeAuthorizationCode(config, "code", "http://127.0.0.1/callback", "verifier", fetchMock),
    ).rejects.toThrow("OAuth トークン応答を解析できません");
  });

  it("refreshes an access token without replacing the stored refresh token", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ access_token: "new-access", refresh_token: "rotated-refresh" }),
          {
            status: 200,
          },
        ),
    );

    await expect(refreshAccessToken(config, "stored-refresh", fetchMock)).resolves.toEqual({
      accessToken: "new-access",
      refreshToken: "rotated-refresh",
    });
  });

  it("exposes invalid_grant as a machine-readable code", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Unknown or invalid refresh token.",
          }),
          { status: 403 },
        ),
    );

    const error = await refreshAccessToken(config, "revoked-refresh", fetchMock).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(OAuthTokenError);
    expect((error as OAuthTokenError).code).toBe("invalid_grant");
    expect((error as OAuthTokenError).status).toBe(403);
    expect((error as OAuthTokenError).message).toContain("Unknown or invalid refresh token.");
  });

  it("keeps a transient server error distinguishable from invalid_grant", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 }),
    );

    const error = await refreshAccessToken(config, "stored-refresh", fetchMock).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(OAuthTokenError);
    expect((error as OAuthTokenError).code).toBe("server_error");
  });

  it("does not report a parse failure as an OAuth error code", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("not-json", { status: 200 }));

    const error = await refreshAccessToken(config, "stored-refresh", fetchMock).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).not.toBeInstanceOf(OAuthTokenError);
  });

  it("does not report a network failure as an OAuth error code", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });

    const error = await refreshAccessToken(config, "stored-refresh", fetchMock).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).not.toBeInstanceOf(OAuthTokenError);
  });
});

describe("revokeRefreshToken", () => {
  it("posts the refresh token without a client secret", async () => {
    // public client なので client_secret は送らない（配布物に隠せない）。
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

    await revokeRefreshToken(config, "refresh-token-value", fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.auth0.com/oauth/revoke");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: config.clientId,
      token: "refresh-token-value",
    });
    expect(JSON.parse(init.body as string)).not.toHaveProperty("client_secret");
  });

  it("does not follow redirects and gives up after a timeout", () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

    return revokeRefreshToken(
      config,
      "refresh-token-value",
      fetchMock as unknown as typeof fetch,
    ).then(() => {
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      // 資格情報を載せるので転送先へ渡さない（RULE-002）。
      expect(init.redirect).toBe("error");
      // 応答が返らないまま待ち続けない（RULE-001）。
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  it("throws when the identity provider rejects the revocation", async () => {
    // 2xx 以外を成功に丸めない。呼び出し側がログへ残せるよう投げる（RULE-004）。
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }),
    );

    await expect(
      revokeRefreshToken(config, "refresh-token-value", fetchMock as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(OAuthTokenError);
  });
});
