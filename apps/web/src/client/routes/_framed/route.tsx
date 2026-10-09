import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { fetchLoggedIn } from "../../session.js";

// ログアウトは単発リクエスト。応答が返らないまま待ち続けると画面が固まるので、
// 締め切りを設ける（.agents/rules/rules.md RULE-001）。
const AUTH_REQUEST_TIMEOUT_MS = 10_000;

/**
 * ログアウトして、Worker が返す IdP のログアウトの URL へ移る（#301）。IdP のセッションも消すので、
 * 次のログインでアカウントを選び直せる。IdP からはトップへ戻る。
 *
 * 応答が読めなければトップへ移る。Worker が KV のセッションと Cookie を消せていればログアウトは済んでいる
 * （IdP のセッションだけが残る）。
 */
async function logout() {
  let next = "/";
  try {
    const response = await fetch("/logout", {
      method: "POST",
      signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json()) as { redirectTo?: unknown };
    if (typeof body.redirectTo === "string") next = body.redirectTo;
  } catch (error) {
    // 失敗してもトップへ移る（RULE-004: 記録して先へ進む）。ヘッダーがログインの状態を出し直すので、
    // セッションが残っていれば画面で分かる。
    console.error("logout failed", error);
  }
  window.location.href = next;
}

function Header() {
  const { loggedIn } = Route.useLoaderData();
  return (
    <header>
      <Link to="/" className="brand">
        学習装置 <small>Learning Map</small>
      </Link>
      <nav>
        <Link to="/">マップ</Link>
        <Link to="/maps">自分のマップ</Link>
        <Link to="/activity">推移</Link>
        <Link to="/history">履歴</Link>
        <Link to="/settings">設定</Link>
        {loggedIn ? (
          <button onClick={() => void logout()}>ログアウト</button>
        ) : (
          // `/login` は Worker が受けて IdP へ転送するので、SPA の Link ではなく
          // ページ遷移になる通常のリンクで出す。
          <a href="/login">ログイン</a>
        )}
      </nav>
    </header>
  );
}

/** ヘッダー付きの画面に共通の枠。URL には現れない（pathless layout）。 */
export const Route = createFileRoute("/_framed")({
  // ヘッダーの「ログイン / ログアウト」を切り替えるためにだけ使う（Issue #182）。
  loader: async () => ({ loggedIn: await fetchLoggedIn() }),
  component: () => (
    <>
      <Header />
      <main>
        <Outlet />
      </main>
    </>
  ),
});
