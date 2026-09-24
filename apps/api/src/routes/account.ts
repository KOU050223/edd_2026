/**
 * `DELETE /v1/me`。退会（docs/auth.md §8）。
 *
 * **順序を固定する。D1 を先に消し、その後 Auth0 のユーザーを消す。**
 * 逆にすると、Auth0 のユーザーが消えた後に D1 の削除が失敗した場合、
 * 二度と認証できない `sub` の下に学習データだけが残る（保持期間の問題になる）。
 * この順序なら、Auth0 側の削除に失敗しても利用者は空のアカウントへ
 * ログインし直せるだけで、再実行すれば済む。
 *
 * 消す対象は `c.get("user").userId` だけから決める。パスにもボディにも
 * userId を取らない。クライアントの自己申告は認可の入力にしてはならない
 * （`repository/types.ts` が `clientId` について書いているのと同じ規律）。
 */

import { Hono } from "hono";
import type { AuthVariables } from "../auth/middleware.js";
import type { IdentityRepository } from "../repository/types.js";

/**
 * Auth0 のユーザーを削除する側。
 *
 * D1 と同じく interface で切る。テストは Worker ランタイムも Auth0 も無しで
 * 順序と失敗時の振る舞いを確かめられる（docs/testing-guide.md §6）。
 */
export interface IdentityProviderUsers {
  /** IdP 上のユーザーを削除する。既に存在しない場合も成功として扱う。 */
  delete(userId: string): Promise<void>;
}

export interface AccountDeps {
  identity: IdentityRepository;
  idp: IdentityProviderUsers;
}

export type AccountDepsResolver = (env: CloudflareBindings) => AccountDeps;

export function createAccountRoute(resolve: AccountDepsResolver) {
  const route = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  route.delete("/me", async (c) => {
    const userId = c.get("user").userId;

    // 依存の組み立てを削除の**前**に済ませる。Management API の設定漏れは
    // ここで例外になる。D1 を消した後に気付く形にすると、「学習データだけ消えて
    // IdP のユーザーは生存」が確定してしまう。設定の検証は削除ではないので、
    // D1 → Auth0 の順序には反しない。
    const deps = resolve(c.env);

    // 先に退会中マーカーを永続化する。同期が users 行を再作成できる窓を作らない。
    await deps.identity.startUserDeletion(userId, Date.now());

    // D1 が先。`ON DELETE CASCADE` により learning_events / devices も消える。
    // ここが失敗したら Auth0 へは進まない（例外がそのまま上がる）。
    await deps.identity.deleteUser(userId);

    // Auth0 が後。ここで失敗しても D1 は消えたままでよい。握りつぶさずログへ残し、
    // 再実行できるよう失敗として返す（.agents/rules/rules.md RULE-004）。
    try {
      await deps.idp.delete(userId);
    } catch (error) {
      console.error("failed to delete the identity provider user after deleting D1 data", {
        userId,
        message: error instanceof Error ? error.message : String(error),
        cause: error instanceof Error ? error.cause : undefined,
      });
      return c.json(
        {
          error: "identity_provider_delete_failed",
          // 何が残っているかを呼び出し側が判断できるようにする。学習データは
          // 既に消えているため、再実行は IdP の削除だけで足りる。
          dataDeleted: true,
        },
        502,
      );
    }

    // 退会の証跡。監査ログ（audit_log）は users 行と一緒に消えるため、
    // 「いつ退会したか」はここの構造化ログで追う
    // （docs/architecture.md「監視・監査ログ・障害時の再送」）。
    console.info("account deleted", { userId });
    return c.body(null, 204);
  });

  return route;
}
