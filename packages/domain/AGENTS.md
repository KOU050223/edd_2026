# Learning Domain

このパッケージは `Concept`、`LearningEvent`、`ConceptMastery` と習熟度の規則を共有する。

- VS Code、HTTP、データベース、特定AI SDK、環境変数、ファイルシステムに依存してはならない。
- クライアントの表示都合やDatabaseの内部モデルを持ち込まない。
- 習熟度は質問回数だけで上げない。詳細な更新規則は `docs/concepts.md` を正典とする。
- Concept一覧の正典は `concepts.md`。変更後はリポジトリルートで `npm run gen:concepts` と `npm run check:concepts` を実行する。
- 仕様変更には単体テストを追加し、API・Extensionの両方で同じ意味を保つ。

## テスト

書き方・実行方法は [`docs/testing-guide.md`](../../docs/testing-guide.md) を参照する。

- テストは対象と同じディレクトリに `*.test.ts` で置く。
- 依存が無いので偽物は要らない。**モックが必要になったら、それは依存が漏れた合図。**
- 習熟度の規則を変えたら、境界値（しきい値の両端とその外側）を必ず足す。
