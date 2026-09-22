import { createFileRoute } from "@tanstack/react-router";

const reasonText: Record<string, string> = {
  state_mismatch: "ログインの途中で情報が食い違いました。最初からやり直してください。",
  login_state_missing: "ログインの有効期限が切れました。もう一度お試しください。",
  unsolicited: "このログイン要求には心当たりがありません。もう一度お試しください。",
  token_exchange_failed: "認証サーバーへ接続できませんでした。少し待ってからお試しください。",
};

/**
 * 認可に失敗して Worker から戻された画面。
 *
 * `/login` と `/callback` は Worker が処理するので、ここへ来るのは失敗した経路だけ。
 * 理由をそのまま出さず、利用者がやり直せる導線に倒す（原因はサーバーのログにある）。
 * ヘッダーを持たないので、枠つきの `_framed` の下には置かない。
 */
function LoginFailed() {
  const { reason } = Route.useSearch();
  const text = reason === undefined ? undefined : reasonText[reason];
  return (
    <main className="login">
      <section className="card">
        <h1>学習装置</h1>
        <p>ログインを完了できませんでした。</p>
        {text && <p className="error-text">{text}</p>}
        <a className="button" href="/login">
          ログインし直す
        </a>
      </section>
    </main>
  );
}

export const Route = createFileRoute("/login-failed")({
  validateSearch: (search: Record<string, unknown>): { reason?: string } =>
    typeof search.reason === "string" ? { reason: search.reason } : {},
  component: LoginFailed,
});
