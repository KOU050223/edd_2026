// OAuth ログイン・ログアウト・アクセストークンの更新
// （Issue #279 ステップ 3 で index.ts から分離）。
import { shell } from "electron";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { appState } from "../app-state.js";
import { send } from "../ipc/helpers.js";
import { performLogout } from "../logout.js";
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  parseCallbackUrl,
  refreshAccessToken,
  OAuthTokenError,
  revokeRefreshToken,
  type OAuthConfig,
} from "../oauth.js";
import { refreshTokenStore } from "../token-store.js";
import { EVENT_CHANNELS } from "../../shared/ipc.js";

export const OAUTH_CONFIG: OAuthConfig = {
  issuer: "https://gakushu-sochi.jp.auth0.com",
  clientId: "r9zPMIsOS9qezfcLkDQq6HC423e0ui0x",
  audience: "https://api.gakushu-sochi.dev",
};
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;
// Auth0 の Allowed Callback URLs はポートにワイルドカードを使えない。ポート 0（OS 任せ）
// にすると起動ごとに redirect_uri が変わり、毎回 "Callback URL mismatch" で弾かれる。
// そのため固定する。この値を変えるときは Auth0 側の登録も同時に変えること。
export const OAUTH_CALLBACK_PORT = 53682;
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/callback`;

export async function loginWithBrowser(): Promise<void> {
  const generation = appState.authOperation.beginLogin();
  try {
    const pkce = createPkcePair();
    const state = randomState();
    const callback = await waitForOAuthCallback(state);
    try {
      const redirectUri = callback.redirectUri;
      const authorizationUrl = buildAuthorizationUrl(
        OAUTH_CONFIG,
        redirectUri,
        state,
        pkce.challenge,
      );

      await shell.openExternal(authorizationUrl);
      const code = await callback.code;
      const tokens = await exchangeAuthorizationCode(
        OAUTH_CONFIG,
        code,
        redirectUri,
        pkce.verifier,
      );
      if (!appState.authOperation.isCurrent(generation)) {
        throw new Error("認証状態が変更されたため、ログイン結果を破棄しました。");
      }
      refreshTokenStore().set(tokens.refreshToken);
    } finally {
      callback.close();
    }
  } finally {
    appState.authOperation.finishLogin();
  }
}

/** ログアウトの順序は `logout.ts` が固定する（docs/auth.md §8）。ここは配線だけ。 */
export async function logout(): Promise<void> {
  appState.authOperation.begin();
  const store = refreshTokenStore();
  await performLogout({
    readRefreshToken: () => store.get(),
    clearRefreshToken: () => store.clear(),
    revoke: (refreshToken) => revokeRefreshToken(OAUTH_CONFIG, refreshToken),
    notify: (state) => send(appState.popup?.webContents, EVENT_CHANNELS.authState, state),
    logError: (message, detail) => console.error(message, detail),
  });
}

function randomState(): string {
  return randomBytes(32).toString("base64url");
}

async function waitForOAuthCallback(
  expectedState: string,
): Promise<{ redirectUri: string; code: Promise<string>; close: () => void }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      // 握りつぶして別ポートへ逃げない。逃げた先は Auth0 に登録されておらず、
      // どのみち "Callback URL mismatch" になる（.agents/rules/rules.md RULE-004）。
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `OAuth のコールバック待受ポート ${OAUTH_CALLBACK_PORT} が使用中です。` +
                "このポートを使っているアプリを終了してから、もう一度ログインしてください。",
              { cause: error },
            )
          : error,
      );
    });
    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => resolve());
  });
  const redirectUri = OAUTH_REDIRECT_URI;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (timer) clearTimeout(timer);
    server.close();
  };
  const code = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      close();
      reject(new Error("OAuth ログインがタイムアウトしました。"));
    }, OAUTH_CALLBACK_TIMEOUT_MS);
    server.on("request", (request, response) => {
      if (request.url?.split("?", 1)[0] !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const callbackUrl = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${request.url}`;
      try {
        const authorizationCode = parseCallbackUrl(callbackUrl, expectedState);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<h1>ログインが完了しました</h1><p>この画面を閉じてください。</p>");
        close();
        resolve(authorizationCode);
      } catch (error) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : "OAuth コールバックが不正です。");
        close();
        reject(error);
      }
    });
  });
  return { redirectUri, code, close };
}

/**
 * 保存済みの refresh token でアクセストークンを取り直す。
 *
 * 取り消し・期限切れの refresh token（RFC 6749 の `invalid_grant`）のときだけ
 * 保存済みトークンを消す。ネットワーク障害やその他の OAuth エラーでは残す
 * （消すと、復旧すれば使えたはずのトークンを捨てて再ログインを強いることになる）。
 */
export async function refreshAccessTokenOrClearOnInvalidGrant(
  refreshToken: string,
  generation: number,
) {
  try {
    return await refreshAccessToken(OAUTH_CONFIG, refreshToken);
  } catch (error) {
    if (error instanceof OAuthTokenError && error.code === "invalid_grant") {
      if (!appState.authOperation.isCurrent(generation)) {
        throw new Error("認証状態が変更されたため、古い更新結果を破棄しました。", {
          cause: error,
        });
      }
      refreshTokenStore().clear();
      // 消したことを画面へ伝える。伝えないと設定を開き直すまで「ログイン済み」のままになる。
      send(appState.popup?.webContents, EVENT_CHANNELS.authState, { hasRefreshToken: false });
      throw new Error("ログインの有効期限が切れました。設定から再ログインしてください。", {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * 保存済みの refresh token からアクセストークンを取る。
 * askManagedAI と同じ更新経路を使い、履歴インポート系 API 呼び出しに供する。
 */
export async function getAccessToken(): Promise<string> {
  const generation = appState.authOperation.current();
  if (appState.authOperation.isLoginInProgress()) {
    throw new Error("ログイン中は履歴インポートを実行できません。");
  }
  const refreshToken = refreshTokenStore().get();
  if (!refreshToken) throw new Error("ログインが必要です。設定からログインしてください。");
  const refreshed = await refreshAccessTokenOrClearOnInvalidGrant(refreshToken, generation);
  if (!appState.authOperation.isCurrent(generation)) {
    throw new Error("認証状態が変更されたため、処理を中止しました。");
  }
  if (refreshed.refreshToken) refreshTokenStore().set(refreshed.refreshToken);
  return refreshed.accessToken;
}
