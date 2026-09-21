# API Server

Cloudflare Workers 上で動く Hono API。認証、`learning-events:sync`、`learning-profile`、
Managed AI の実装を置く。API契約を先に置かず、このアプリ固有の型を他パッケージから
参照してはならない。

```bash
npm run dev --workspace=@gakushu-sochi/api
npm run test:unit --workspace=@gakushu-sochi/api
npm run deploy --workspace=@gakushu-sochi/api
```

Bindings を変更したら、`npm run gen:worker-types --workspace=@gakushu-sochi/api` を実行する。
秘密情報は `wrangler secret put` で設定し、`wrangler.jsonc` やリポジトリに書かない。

必要な秘密情報の**名前**は `wrangler.jsonc` の `secrets.required` に宣言する。
`wrangler types` はこの宣言から型を作るため、`.dev.vars` を持たない CI でも
`check:worker-types` が通る。デプロイ時には設定済みかどうかも検証される。

## ローカル開発の準備

```bash
cp .dev.vars.example .dev.vars      # 開発用の秘密情報。gitignore 済み
npm run --workspace=@gakushu-sochi/api dev
```

`apps/api/.dev.vars` に `GEMINI_API_KEY` を設定すると、`POST /v1/ai/responses` が
Gemini の `streamGenerateContent` を中継します。Gemini キーは desktop に保存しません。

API の認証は Auth0 のアクセストークン検証です（docs/auth.md §4）。各クライアントは
自分でログインして得たトークンを送ります。開発用の共有トークン `DEV_AUTH_TOKEN` は
Auth/06 で廃止したので、手で貼り付ける共有の値はもうありません。

D1 のスキーマを適用する。

```bash
npx wrangler d1 migrations apply gakushu-sochi --local
```

リモートへ適用するには `--local` ではなく `--remote` を明示する。
どちらも付けない場合はローカルが対象になり、リモートには何も適用されない。

```bash
npx wrangler d1 migrations apply gakushu-sochi --remote
```

`wrangler.jsonc` の `database_id` は `wrangler d1 create gakushu-sochi` の出力で埋める。
作成済みなら `npx wrangler d1 list` で確認できる。ただし下記のとおり D1 は
デプロイ先アカウントのものを指す必要があるため、各自の環境で作り直して
`database_id` を書き換えてはならない。

## デプロイ先（メンバー間で統一する）

本番は**1つのアカウントに固定**する。`wrangler.jsonc` の `account_id` がそれを強制する。

| 項目       | 値                                               |
| ---------- | ------------------------------------------------ |
| Worker URL | `https://gakushu-sochi-api.uozumi05.workers.dev` |
| account_id | `996d4f5f54227fcc10dd15a2baee0a5b`               |

`.workers.dev` のホスト名は `<worker名>.<アカウントのサブドメイン>.workers.dev` であり、
`account_id` を書かないと各自のアカウントへデプロイされて URL が分岐する。
`database_id` も同じくアカウントに紐づくため、URL と D1 は必ずセットで扱う。

デプロイには対象アカウントの権限が必要になる。権限が無い状態で
`npm run deploy` すると認証エラーになる（別アカウントへ野良デプロイされない）。
`apps/vscode-extension` の既定値 `gakushuSochi.api.baseUrl` は上記 URL に揃えてある
（配布先の利用者がそのまま本番を向くため）。一方 `apps/desktop` の既定値は
`http://localhost:8787` のままにしてある。リポジトリルートの `npm run dev` が
API と desktop を同時に起動する開発用の組み合わせで、ここを本番 URL にすると
ローカル API が使われなくなるため。本番を向けたい場合は desktop の設定画面で変更する。

このアカウントへのデプロイ権限は uozumi05（アカウント所有者）が招待して付与する。
