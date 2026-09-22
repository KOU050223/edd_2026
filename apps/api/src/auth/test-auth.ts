/**
 * テスト用の認証ミドルウェア。
 *
 * ルートやレート制限のテストが確かめたいのは「認証が決めた userId が後段へ
 * 正しく渡るか」であって、トークンの検証方式ではない。以前は `devAuth` を
 * この用途に流用していたが、それは開発用の共有トークンを消せない理由に
 * なっていた（Auth/06）。本番の継ぎ目である `createAuth` へ偽の検証器を挿す形に
 * 揃えることで、資格情報を1つも持たずに同じことができる。
 *
 * 検証方式そのもの（署名・`iss`・`aud`・`exp`）は `verifier.test.ts` が
 * 本物の JWT で固定する。ここはその責務を持たない。
 */

import { createAuth } from "./middleware.js";
import { AuthVerificationError } from "./verifier.js";

/** 既定のテスト用トークン。これ以外を送ると 401 になる。 */
export const TEST_TOKEN = "test-token";

/**
 * トークンを `userId` へ対応付ける認証ミドルウェアを組み立てる。
 *
 * `userId` を1つ渡すと `TEST_TOKEN` だけがその `userId` を通す。対応表を渡すと、
 * 1つのアプリが複数の利用者を受け付ける。レート制限のように「誰の分として
 * 数えるか」を確かめる層は、アプリを分けて再現しても意味がない。本番では
 * 同じアプリに別人のトークンが届くので、その形のまま固定する必要がある。
 *
 * 誤ったトークンを 401 にするのは、認証より後ろの層（レート制限など）が
 * 「認証を通っていないリクエスト」をどう扱うかをテストできるようにするため。
 */
export function stubAuth(users: string | Record<string, string>) {
  // Map で持つ。素のオブジェクトの添字アクセスは `constructor` のような
  // プロトタイプ由来のキーに当たるため、渡していないトークンが通りうる。
  const tokenToUserId = new Map(
    Object.entries(typeof users === "string" ? { [TEST_TOKEN]: users } : users),
  );
  return createAuth(() => ({
    verify: (token: string) => {
      const userId = tokenToUserId.get(token);
      return userId === undefined
        ? Promise.reject(new AuthVerificationError("invalid_token", "テスト用トークンと一致しない"))
        : Promise.resolve({ sub: userId });
    },
  }));
}

/** `stubAuth` が通すリクエストヘッダ。 */
export const AUTHORIZED_HEADERS = { Authorization: `Bearer ${TEST_TOKEN}` };
