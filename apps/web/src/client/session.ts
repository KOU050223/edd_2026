import { ApiError, requestJson } from "./api.js";

/**
 * ログイン直後の最初の 401 を数回だけ再試行してよいかを返す。
 *
 * Workers KV は結果整合で、`/callback` が張ったセッションが別のエッジへ伝わるまで
 * 遅れうる（docs/web-viewer.md）。Worker は `/?login=1` へ戻してこれを伝える。
 * 印は sessionStorage へ移して URL から消し、**再読み込みで再試行が復活しない**
 * ようにする。無限に再試行しないための一度きりの印である。
 */
const LOGIN_SESSION_RETRIES = 3;

export function takeLoginRetry(): number {
  const params = new URLSearchParams(window.location.search);
  if (params.get("login") === "1") {
    sessionStorage.setItem("web-login-retry", "1");
    params.delete("login");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }
  if (sessionStorage.getItem("web-login-retry") !== "1") return 0;
  sessionStorage.removeItem("web-login-retry");
  return LOGIN_SESSION_RETRIES;
}

/**
 * このページ読み込みがログイン直後か（印は消費しない）。
 *
 * `takeLoginRetry` は印を消すので二箇所からは使えない。`/session` 側にも
 * 伝播待ちが要るため、loader が走るより前のモジュール評価時に確定させる。
 * これは「この load で待ってよいか」だけで、再試行回数の消費とは別物。
 */
const postLoginLoad =
  typeof window !== "undefined" &&
  (new URLSearchParams(window.location.search).get("login") === "1" ||
    sessionStorage.getItem("web-login-retry") === "1");

/**
 * ログイン済みかを Worker に尋ねる（Issue #182）。
 *
 * session Cookie は HttpOnly でブラウザ側からは読めないので、Worker の
 * `/session` に委ねる。応答の形が契約と違えば失敗として扱う（RULE-004）。
 *
 * ログイン直後は KV の伝播待ちで一時的に `false` を返しうる（docs/web-viewer.md）。
 * そのときだけデータ側の再試行と同じ回数待つ。待っても false なら
 * 本当に未ログインとして返す。
 */
export async function fetchLoggedIn(
  fetcher: typeof fetch = fetch,
  wait: () => Promise<void> = () => new Promise((resolve) => window.setTimeout(resolve, 1_000)),
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    const status = await requestJson<{ loggedIn: unknown }>("/session", fetcher);
    if (typeof status.loggedIn !== "boolean") throw new ApiError("unavailable");
    if (status.loggedIn || !postLoginLoad || attempt >= LOGIN_SESSION_RETRIES)
      return status.loggedIn;
    await wait();
  }
}
