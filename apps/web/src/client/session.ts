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
