# Desktop App

このアプリは常駐トレイ、グローバルショートカット、他アプリからの選択テキスト取得を担当する。

- OS 依存の処理（アクセシビリティ、SendKeys、Keychain / Credential Manager）はここだけで扱う。
- API トークンは OS の資格情報ストアに預ける。本文・質問・AI回答をこの端末へ永続化しない。
  サーバーへの履歴保存は「質問履歴の保存」オプトイン時のみ行う
  （`src/main/conversations-api.ts`、正本は `docs/conversation-history.md`）。
- AI プロバイダのキーを持たない。生成は API Server 経由で行う。
- `packages/domain` は利用してよいが、Electron の型を持ち込んではならない。

## テスト

書き方・実行方法は [`docs/testing-guide.md`](../../docs/testing-guide.md) を参照する。

- テストは対象と同じディレクトリに `*.test.ts` で置く。拾う範囲は `vitest.config.ts`。
- **このワークスペースだけ `describe` / `it` と英語名で書かれている。** 既存に合わせる。
  揃えるためだけに他を書き換えない。
- Electron の実ウィンドウは起動しない。`stream.ts` や `markdown.js` のように、
  検証したいロジックを `app` / `BrowserWindow` から切り離してから書く。
- `test:watch` は未定義。監視したいときはこのディレクトリで `npx vitest` を叩く。
