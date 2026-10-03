# API Server

このアプリは認証、学習イベント同期、Learning Profile、Managed AI を担当する。

- 学習イベントを冪等に追記し、習熟度はサーバー側のドメイン規則から導出する。
- API の外部契約は、このアプリに置く。複数クライアントで実際に共有が必要になるまで新しい `packages` を作らない。
- コード本文・質問本文・AI回答全文は、明示的な同意なしに長期保存しない。
  確認問題（`concept_checks`、#185）は例外ではなく対象外である。入力が Concept の定義だけの
  全利用者共有コンテンツで、利用者の質問への回答ではないため保存して使い回す。
- `packages/domain` は利用してよいが、VS Code API やUIの型へ依存してはならない。

## テスト

書き方・実行方法は [`docs/testing-guide.md`](../../docs/testing-guide.md) を参照する。

- テストは対象と同じディレクトリに `*.test.ts` で置く。
- D1 も wrangler も起動しない。`repository/memory.ts` の In-Memory 実装と `now` を
  ルート生成関数へ渡し、`new Hono()` に載せて `app.request()` で叩く。
- HTTP の契約（ステータス、エラー種別、冪等性、認証の拒否）は自動テストで固定する。
