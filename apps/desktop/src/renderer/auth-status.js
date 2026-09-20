// ログイン状態の表示文言を決める。renderer.js から切り出してあるのは、
// DOM なしで表示規則だけをテストするため（markdown.js と同じ形）。

/** @typedef {{ loggingIn: boolean, hasRefreshToken: boolean }} AuthView */

export const AUTH_LABELS = {
  loggingIn: "ブラウザでログインしています…",
  loggedIn: "ログイン済み",
  loggedOut: "未ログイン",
  failed: "ログインに失敗しました",
};

/**
 * 表示すべきログイン状態の文言を返す。
 *
 * ログイン処理中は保存済みトークンの有無より進行中の表示を優先する。
 * 主処理の途中に届いた更新で「未ログイン」へ戻すと、実際には走っている
 * ログインについて画面が嘘をつく（.agents/rules/rules.md RULE-005 / RULE-007）。
 *
 * @param {AuthView} view
 * @returns {string}
 */
export function authStatusLabel(view) {
  if (view.loggingIn) return AUTH_LABELS.loggingIn;
  return view.hasRefreshToken ? AUTH_LABELS.loggedIn : AUTH_LABELS.loggedOut;
}

/**
 * main から届いたログイン状態を取り込んでよいかを返す。
 *
 * ログイン処理中は取り込まない。押下の無効化（disabled）は見た目でしかなく、
 * 別経路から届く更新は素通りするため、状態で弾く（RULE-007）。
 *
 * @param {AuthView} view
 * @returns {boolean}
 */
export function shouldApplyAuthState(view) {
  return !view.loggingIn;
}
