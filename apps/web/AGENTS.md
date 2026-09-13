# Web App

このアプリは Learning Map とユーザー設定のWeb UIを担当する。

- 学習イベントと習熟度の正本を持たず、API Server から取得する。
- データベースへ直接アクセスしない。認証済みの API 契約だけを使う。
- 表示に必要な読み取りAPIが不足した場合は、画面固有の用途を明示して API に追加する。汎用GraphQLや巨大なBFFを先行して導入しない。

## テスト

書き方・実行方法は [`docs/testing-guide.md`](../../docs/testing-guide.md) を参照する。

- テストは対象と同じディレクトリに `*.test.ts` で置く。
- **jsdom も `@testing-library` も未導入。** React コンポーネントの自動テストは書けない。
  検証したいロジックは `client/api.ts` のように描画から切り離してから書く。
- Worker は `createWebApp({ fetch })` へ偽の `fetch` を渡して組み立て、`app.request()` で叩く。
  KV は `get` / `put` / `delete` を持つ最小の偽物で足りる。
