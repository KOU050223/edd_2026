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

`GITHUB_TOKEN`（リポジトリからのマップ、#249）も `.dev.vars` に置きます。公開リポジトリだけを読む
fine-grained token（Repository access は Public repositories、権限なし）で足ります。無い・失効しているときは
`POST /v1/repo-maps:inspect` などが 503（`github_not_configured`）を返します。本番は
`wrangler secret put GITHUB_TOKEN`、またはダッシュボードの Variables and Secrets で入れます。
有効期限があるので、切れる日を控えておいてください。

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

## プランを plus にする

AI 生成の回数上限はプランごとに決まる（`docs/ai-limits.md`、#289）。課金はまだ無いので、
plus は開発者のアカウントにだけ D1 へ手で入れる。プランを変える API は無い。

1. 対象のアカウントで一度ログインし、API を使っておく（`user_plans` は `users` を参照するため）。
2. Auth0 の管理画面（User Management → Users）で、そのユーザーの `user_id`（`auth0|...` など）を確かめる。
3. 次を実行する（`<user_id>` を置き換える）。

```bash
npx wrangler d1 execute gakushu-sochi --remote --command "INSERT INTO user_plans (user_id, plan, updated_at) VALUES ('<user_id>', 'plus', datetime('now')) ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan, updated_at = excluded.updated_at"
```

free へ戻すときは行を消す。

```bash
npx wrangler d1 execute gakushu-sochi --remote --command "DELETE FROM user_plans WHERE user_id = '<user_id>'"
```

wrangler が本番のアカウントへログインしていなくても、Cloudflare のダッシュボードから同じ SQL を流せる。
左上で本番のアカウント（`wrangler.jsonc` の `account_id`）へ切り替え、Storage & Databases → D1 で
`database_id` が一致する `gakushu-sochi` を開き、「コンソール」に `--command` の中身の SQL を貼って実行する。
別のアカウントに同じ名前の空のデータベースがあることがあるので、ID で確かめること。

## 言語別マップの作成者を入れる

言語別マップ（`packages/domain/concepts.md` の `language`）の「理解すること」を AI で作り直し、手で直せるのは、
その言語のマップの作成者だけ（#245、`fixed_map_creators`）。作成者を変える API は無い。
Auth0 の `sub` を公開リポジトリに書かないため、マイグレーションでは入れず、手で SQL を流す。

1. 上の「プランを plus にする」の 1・2 と同じく、一度ログインして `user_id` を確かめる。
   作り直しは AI の利用回数を使うので、作成者は plus にしておく。
2. 次を実行する（`<language>` は `go` などの言語、`<user_id>` を置き換える）。
   ダッシュボードの D1 コンソールでも、`--command` の中身をそのまま流せる。

```bash
npx wrangler d1 execute gakushu-sochi --remote --command "INSERT INTO fixed_map_creators (language, user_id, created_at) VALUES ('<language>', '<user_id>', datetime('now'))"
```

外すときは行を消す。

```bash
npx wrangler d1 execute gakushu-sochi --remote --command "DELETE FROM fixed_map_creators WHERE language = '<language>' AND user_id = '<user_id>'"
```

作成者が使う口は `POST /v1/fixed-maps/:language/objectives:generate`（作り直しの案を返す。保存しない）と
`PUT /v1/fixed-maps/:language/concepts/:conceptId/objectives`（確定）。確定は全利用者の理解度と確認問題に効くので、
監査ログ（`audit_log` の `fixed_objectives.replaced`）に残る。

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
