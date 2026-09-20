/**
 * ログアウトの手順（docs/auth.md §8）。
 *
 * Electron から切り離してあるのは、**順序をテストで固定するため**である。
 * `index.ts` に置いたままだと `app` / `safeStorage` が要り、素の vitest で
 * 動かせない（`credentials.ts` や `oauth.ts` と同じ形にしてある）。
 */

/** ログアウトが触る外側。実体は `index.ts` が渡す。 */
export interface LogoutDeps {
  /** 保存済みの Refresh Token を読む。 */
  readRefreshToken: () => string | undefined;
  /** ローカルの Refresh Token を破棄する。 */
  clearRefreshToken: () => void;
  /** IdP 側で Refresh Token を撤回する。 */
  revoke: (refreshToken: string) => Promise<void>;
  /** ログイン状態の変化を画面へ伝える。 */
  notify: (state: { hasRefreshToken: boolean }) => void;
  /** 撤回の失敗を記録する。 */
  logError: (message: string, detail: Record<string, unknown>) => void;
}

/**
 * ログアウトする。
 *
 * **先にローカルの Refresh Token を破棄し、その後 `POST /oauth/revoke` を呼ぶ。**
 * 利用者を守っているのはローカルの破棄であり、撤回の成否ではない。順序が逆だと、
 * 撤回の通信で失敗したときにローカルへトークンが残り、ログアウトしたつもりの
 * 端末がログイン済みのままになる。
 *
 * 撤回の失敗は握りつぶさず記録するが、例外にはしない
 * （.agents/rules/rules.md RULE-004）。利用者から見たログアウトは
 * ローカルの破棄が終わった時点で既に成立しており、ここで投げると画面が
 * 「ログアウトに失敗した」と嘘をつく。露出はアクセストークンの寿命（15分）
 * に上限される。
 */
export async function performLogout(deps: LogoutDeps): Promise<void> {
  let refreshToken: string | undefined;
  try {
    refreshToken = deps.readRefreshToken();
  } catch (error) {
    deps.logError("failed to read the refresh token before local logout", {
      message: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error ? error.cause : undefined,
    });
  }

  // ローカルの破棄が先。撤回より前に、確実に終わらせる。
  deps.clearRefreshToken();
  deps.notify({ hasRefreshToken: false });

  // 保存されていなければ撤回する対象が無い。撤回だけを空撃ちしない。
  if (!refreshToken) return;

  try {
    await deps.revoke(refreshToken);
  } catch (error) {
    deps.logError("failed to revoke the refresh token after local logout", {
      message: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error ? error.cause : undefined,
    });
  }
}
