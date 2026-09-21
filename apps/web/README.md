# Web App

Learning Map を表示する Cloudflare Worker + React UI。学習イベントの正本は保持せず、
認証済みの API Server から集計済みの読み取りモデルだけを取得する。

```bash
npm run dev --workspace=@gakushu-sochi/web
npm run test:unit --workspace=@gakushu-sochi/web
npm run build --workspace=@gakushu-sochi/web
```

## ログイン

Auth0 の Authorization Code + PKCE で個人を識別する（`docs/auth.md` §5.3）。
**Worker が認可コードを交換する confidential client** なので、`client_secret` を持つ。

| パス        | 役割                                                                |
| ----------- | ------------------------------------------------------------------- |
| `/login`    | `state` と PKCE を作り、Auth0 の `/authorize` へ 302 で送る         |
| `/callback` | `state` を確かめ、認可コードを交換し、セッション Cookie を張る      |
| `/logout`   | KV のセッションを消し、その後 Auth0 の Refresh Token を撤回する     |
| `/api/*`    | **そのセッションの利用者**のアクセストークンを載せて API へ中継する |

KV に置くのは Refresh Token と `sub` だけで、**アクセストークンは Worker のメモリに
だけ置く**（KV 書き込みは読み取りの 10 倍の単価）。

`/login` と `/callback` は `wrangler.jsonc` の `run_worker_first` に入っていなければ
ならない。**落とすと assets バインディングが `index.html` を返し、認可コードの交換が
Worker に届かないまま静かに失敗する**（`docs/web-viewer.md` の警告）。

## 設定

`client_id` と issuer は秘密ではないので `wrangler.jsonc` の `vars` にある。
secret は `AUTH_CLIENT_SECRET` だけで、ローカルでは `.dev.vars.example` を
`.dev.vars` にコピーして入れる。**この値をブラウザへ送ってはならない。**

GitHub Actions による本番 CD / Preview には、次の `production` environment secrets を
設定する。

- `CLOUDFLARE_API_TOKEN`: 対象 Cloudflare アカウントへ必要最小限にスコープした API token
- `WEB_AUTH_CLIENT_SECRET`: Auth0 の Web アプリ（`regular_web`）の client secret

CD はこれを一時的な secrets file として `wrangler deploy` に渡し、完了時に削除する。
Worker 作成後に手動で `wrangler secret put` する必要はない。

### Auth0 側に登録が要る URL

`redirect_uri` は Worker が**自分のオリジンから組み立てる**（`https://<host>/callback`）。
したがって**アクセスするホストごとに Auth0 の Allowed Callback URLs へ登録が要る**。
未登録のホストから入ると Auth0 が `Callback URL mismatch` で弾く。

- 本番: `https://gakushu-sochi-web.<サブドメイン>.workers.dev/callback`
- ローカル: `http://localhost:8788/callback`

**PR ごとの Preview URL（`pr-<番号>` の alias）は登録されていないので、
Preview 環境ではログインできない。** Allowed Callback URLs はホスト部にワイルドカードを
使えないため、PR 番号ごとの URL を事前に登録できない。Preview で認証まで確かめたい場合は、
その回の URL を Auth0 へ手で足す。
