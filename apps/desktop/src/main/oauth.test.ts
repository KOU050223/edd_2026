import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  parseCallbackUrl,
  refreshAccessToken,
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
});
