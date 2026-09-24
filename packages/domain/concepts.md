# Concept 一覧

このファイルは Concept 一覧の**正典**である。
`concepts.generated.ts` はここから機械的に書き出したものなので、
編集したら `npm run gen:concepts` を実行する。

命名規則・追加手順・習熟度の更新ルールは [`docs/concepts.md`](../../docs/concepts.md) を参照。

MVP の対象は Go と TypeScript / JavaScript。JavaScript の共通概念は `js.*` を作らず、
`ts.*` に統合する。詳細は [`docs/concepts.md`](../../docs/concepts.md) を参照。
それ以外の言語（Python / Rust / Java / C# / PHP / Ruby）と、言語を横断する領域
（Git / 設計 / DB / HTTP）は暫定の一覧として持つ。
Skill Tree の自動生成は行わず、ここで手で定義する。
`prerequisites` は Skill Tree の辺にあたる。定義順は学習の推奨順を兼ねる。
前提は同じプレフィックスの Concept のみを指す（プレフィックスをまたぐ辺は
Learning Map の木に描かれない）。

## Go

| ID                        | 表示名                       | 前提                      |
| ------------------------- | ---------------------------- | ------------------------- |
| `go.variable_declaration` | 変数宣言と `:=`              | —                         |
| `go.basic_types`          | 基本型とゼロ値               | `go.variable_declaration` |
| `go.control_flow`         | if / for / switch            | `go.variable_declaration` |
| `go.function_basics`      | 関数と複数戻り値             | `go.basic_types`          |
| `go.error_handling`       | error 型と `if err != nil`   | `go.function_basics`      |
| `go.slice_basics`         | Slice の生成と参照           | `go.basic_types`          |
| `go.slice_append`         | `append` と再割り当て        | `go.slice_basics`         |
| `go.map_basics`           | Map と comma-ok              | `go.basic_types`          |
| `go.struct_basics`        | struct の定義と埋め込み      | `go.basic_types`          |
| `go.pointer_basics`       | ポインタと `&` / `*`         | `go.struct_basics`        |
| `go.pointer_receiver`     | 値レシーバとポインタレシーバ | `go.pointer_basics`       |
| `go.interface_basics`     | interface の暗黙実装         | `go.struct_basics`        |
| `go.goroutine`            | goroutine の起動             | `go.function_basics`      |
| `go.channel`              | channel の送受信             | `go.goroutine`            |
| `go.select`               | `select` による多重化        | `go.channel`              |
| `go.context`              | `context` によるキャンセル   | `go.channel`              |
| `go.defer`                | `defer` の実行順序           | `go.function_basics`      |
| `go.package_visibility`   | パッケージと公開/非公開      | `go.function_basics`      |
| `go.module_dependency`    | go.mod と依存管理            | `go.package_visibility`   |
| `go.testing_basics`       | `testing` パッケージ         | `go.function_basics`      |

## TypeScript / JavaScript

| ID                        | 表示名                                | 前提                      |
| ------------------------- | ------------------------------------- | ------------------------- |
| `ts.variable_declaration` | 変数宣言と `const` / `let`            | —                         |
| `ts.primitive_types`      | プリミティブ型と値                    | `ts.variable_declaration` |
| `ts.control_flow`         | if / switch / ループ                  | `ts.variable_declaration` |
| `ts.function_basics`      | 関数宣言と引数・戻り値                | `ts.primitive_types`      |
| `ts.object_basics`        | オブジェクトとプロパティ              | `ts.primitive_types`      |
| `ts.array_basics`         | 配列の生成と要素アクセス              | `ts.primitive_types`      |
| `ts.array_methods`        | map / filter / reduce                 | `ts.array_basics`         |
| `ts.closure`              | クロージャとレキシカルスコープ        | `ts.function_basics`      |
| `ts.class_basics`         | class とインスタンス                  | `ts.object_basics`        |
| `ts.module_basics`        | import / export とモジュール          | `ts.function_basics`      |
| `ts.error_handling`       | throw / try / catch                   | `ts.function_basics`      |
| `ts.promise_basics`       | Promise と状態遷移                    | `ts.function_basics`      |
| `ts.async_await`          | async / await                         | `ts.promise_basics`       |
| `ts.type_annotation`      | 型注釈と型推論                        | `ts.primitive_types`      |
| `ts.interface_basics`     | interface とオブジェクト型            | `ts.type_annotation`      |
| `ts.union_type`           | union 型とリテラル型                  | `ts.type_annotation`      |
| `ts.type_narrowing`       | 型ガードと絞り込み                    | `ts.union_type`           |
| `ts.generic`              | ジェネリクスと型パラメータ            | `ts.interface_basics`     |
| `ts.utility_type`         | Partial / Pick などのユーティリティ型 | `ts.generic`              |
| `ts.testing_basics`       | テストの構成とアサーション            | `ts.function_basics`      |

## Python

| ID                            | 表示名                      | 前提                          |
| ----------------------------- | --------------------------- | ----------------------------- |
| `python.variable_declaration` | 変数と代入                  | —                             |
| `python.basic_types`          | 数値・文字列・真偽値と None | `python.variable_declaration` |
| `python.control_flow`         | if / for / while            | `python.variable_declaration` |
| `python.function_basics`      | def と引数・戻り値          | `python.basic_types`          |
| `python.list_basics`          | list とスライス             | `python.basic_types`          |
| `python.dict_basics`          | dict と get / in            | `python.basic_types`          |
| `python.tuple_set`            | tuple と set                | `python.basic_types`          |
| `python.comprehension`        | 内包表記                    | `python.list_basics`          |
| `python.class_basics`         | class とインスタンス        | `python.function_basics`      |
| `python.error_handling`       | raise / try / except        | `python.function_basics`      |
| `python.module_basics`        | import とモジュール         | `python.function_basics`      |
| `python.typing`               | 型ヒント                    | `python.function_basics`      |
| `python.venv_dependency`      | venv と pip による依存管理  | `python.module_basics`        |
| `python.testing_basics`       | pytest の基本               | `python.function_basics`      |

## Rust

| ID                          | 表示名                  | 前提                        |
| --------------------------- | ----------------------- | --------------------------- |
| `rust.variable_declaration` | let と mut              | —                           |
| `rust.basic_types`          | スカラ型と複合型        | `rust.variable_declaration` |
| `rust.control_flow`         | if / loop / match       | `rust.variable_declaration` |
| `rust.function_basics`      | fn と戻り値             | `rust.basic_types`          |
| `rust.ownership`            | 所有権と move           | `rust.function_basics`      |
| `rust.borrowing`            | 参照と借用              | `rust.ownership`            |
| `rust.lifetime`             | ライフタイム注釈        | `rust.borrowing`            |
| `rust.struct_basics`        | struct と impl          | `rust.basic_types`          |
| `rust.enum_match`           | enum と match           | `rust.struct_basics`        |
| `rust.error_handling`       | Result / Option と `?`  | `rust.enum_match`           |
| `rust.trait_basics`         | trait と実装            | `rust.struct_basics`        |
| `rust.cargo_dependency`     | Cargo とクレート        | `rust.function_basics`      |
| `rust.testing_basics`       | `#[test]` と cargo test | `rust.function_basics`      |

## Java

| ID                          | 表示名                   | 前提                        |
| --------------------------- | ------------------------ | --------------------------- |
| `java.variable_declaration` | 変数宣言と基本型         | —                           |
| `java.control_flow`         | if / for / switch        | `java.variable_declaration` |
| `java.class_basics`         | class とインスタンス     | `java.variable_declaration` |
| `java.method_basics`        | メソッドとオーバーロード | `java.class_basics`         |
| `java.inheritance`          | 継承と override          | `java.class_basics`         |
| `java.interface_basics`     | interface と実装         | `java.inheritance`          |
| `java.collection_basics`    | List / Map / Set         | `java.class_basics`         |
| `java.generics`             | ジェネリクス             | `java.collection_basics`    |
| `java.stream_api`           | Stream API とラムダ      | `java.generics`             |
| `java.error_handling`       | throw / try / catch      | `java.method_basics`        |
| `java.package_build`        | package とビルドツール   | `java.class_basics`         |
| `java.testing_basics`       | JUnit の基本             | `java.method_basics`        |

## C#

| ID                            | 表示名                | 前提                          |
| ----------------------------- | --------------------- | ----------------------------- |
| `csharp.variable_declaration` | var と型宣言          | —                             |
| `csharp.basic_types`          | 値型と参照型          | `csharp.variable_declaration` |
| `csharp.control_flow`         | if / for / switch     | `csharp.variable_declaration` |
| `csharp.class_basics`         | class とプロパティ    | `csharp.basic_types`          |
| `csharp.method_basics`        | メソッドと引数        | `csharp.class_basics`         |
| `csharp.inheritance`          | 継承と override       | `csharp.class_basics`         |
| `csharp.interface_basics`     | interface と実装      | `csharp.inheritance`          |
| `csharp.collection_basics`    | List / Dictionary     | `csharp.basic_types`          |
| `csharp.linq`                 | LINQ とラムダ         | `csharp.collection_basics`    |
| `csharp.async_await`          | async / await と Task | `csharp.method_basics`        |
| `csharp.error_handling`       | throw / try / catch   | `csharp.method_basics`        |
| `csharp.dotnet_project`       | csproj と dotnet CLI  | `csharp.class_basics`         |
| `csharp.testing_basics`       | xUnit の基本          | `csharp.method_basics`        |

## PHP

| ID                         | 表示名                       | 前提                       |
| -------------------------- | ---------------------------- | -------------------------- |
| `php.variable_declaration` | $変数と代入                  | —                          |
| `php.basic_types`          | スカラ型と null              | `php.variable_declaration` |
| `php.control_flow`         | if / foreach / while         | `php.variable_declaration` |
| `php.function_basics`      | function と引数・戻り値      | `php.basic_types`          |
| `php.array_basics`         | array と連想配列             | `php.basic_types`          |
| `php.string_basics`        | 文字列操作とヒアドキュメント | `php.basic_types`          |
| `php.class_basics`         | class とインスタンス         | `php.function_basics`      |
| `php.error_handling`       | throw / try / catch          | `php.function_basics`      |
| `php.web_request`          | $_GET / $_POST とレスポンス  | `php.basic_types`          |
| `php.composer`             | Composer と autoload         | `php.function_basics`      |
| `php.testing_basics`       | PHPUnit の基本               | `php.function_basics`      |

## Ruby

| ID                          | 表示名                       | 前提                        |
| --------------------------- | ---------------------------- | --------------------------- |
| `ruby.variable_declaration` | 変数と代入                   | —                           |
| `ruby.basic_types`          | 数値・文字列・シンボルと nil | `ruby.variable_declaration` |
| `ruby.control_flow`         | if / each / while            | `ruby.variable_declaration` |
| `ruby.method_basics`        | def と引数・戻り値           | `ruby.basic_types`          |
| `ruby.block_basics`         | ブロックと each / map        | `ruby.method_basics`        |
| `ruby.array_hash`           | Array と Hash                | `ruby.basic_types`          |
| `ruby.class_basics`         | class とインスタンス変数     | `ruby.method_basics`        |
| `ruby.module_mixin`         | module と mixin              | `ruby.class_basics`         |
| `ruby.error_handling`       | raise / rescue / ensure      | `ruby.method_basics`        |
| `ruby.gem_bundler`          | gem と Bundler               | `ruby.class_basics`         |
| `ruby.testing_basics`       | Minitest / RSpec の基本      | `ruby.method_basics`        |

## Git

| ID                | 表示名                        | 前提             |
| ----------------- | ----------------------------- | ---------------- |
| `git.repository`  | init / clone とリポジトリ     | —                |
| `git.staging`     | add とステージング            | `git.repository` |
| `git.commit`      | コミットとメッセージ          | `git.staging`    |
| `git.log_history` | log / diff で履歴を読む       | `git.commit`     |
| `git.branch`      | ブランチと切り替え            | `git.commit`     |
| `git.merge`       | マージとコンフリクト解消      | `git.branch`     |
| `git.rebase`      | rebase と履歴の書き換え       | `git.merge`      |
| `git.remote`      | remote / push / pull          | `git.commit`     |
| `git.stash`       | stash と一時退避              | `git.commit`     |
| `git.undo`        | reset / revert による取り消し | `git.commit`     |

## 設計

| ID                          | 表示名                 | 前提                   |
| --------------------------- | ---------------------- | ---------------------- |
| `design.naming`             | 命名と意図の表現       | —                      |
| `design.function_size`      | 関数の分割と責務       | `design.naming`        |
| `design.dry`                | 重複と抽象化           | `design.function_size` |
| `design.dependency`         | 依存の方向と結合度     | `design.function_size` |
| `design.interface_contract` | インターフェースと契約 | `design.dependency`    |
| `design.error_design`       | エラーの表現と伝播     | `design.function_size` |
| `design.state`              | 状態と副作用の管理     | `design.function_size` |
| `design.testability`        | テストしやすい設計     | `design.dependency`    |

## データベース

| ID                    | 表示名                         | 前提                  |
| --------------------- | ------------------------------ | --------------------- |
| `db.relational_model` | テーブルとリレーション         | —                     |
| `db.sql_select`       | SELECT と WHERE                | `db.relational_model` |
| `db.sql_join`         | JOIN と結合                    | `db.sql_select`       |
| `db.sql_aggregate`    | GROUP BY と集約                | `db.sql_select`       |
| `db.sql_write`        | INSERT / UPDATE / DELETE       | `db.relational_model` |
| `db.normalization`    | 正規化と冗長性                 | `db.relational_model` |
| `db.index`            | インデックスと検索性能         | `db.sql_select`       |
| `db.transaction`      | トランザクションと整合性       | `db.sql_write`        |
| `db.migration`        | スキーマ変更とマイグレーション | `db.relational_model` |

## HTTP

| ID                      | 表示名                        | 前提                    |
| ----------------------- | ----------------------------- | ----------------------- |
| `http.request_response` | リクエストとレスポンスの構造  | —                       |
| `http.method_semantics` | GET / POST などメソッドの意味 | `http.request_response` |
| `http.status_code`      | ステータスコードの区分        | `http.request_response` |
| `http.header`           | ヘッダと Content-Type         | `http.request_response` |
| `http.rest`             | REST のリソース指向           | `http.method_semantics` |
| `http.cors`             | CORS とオリジン               | `http.header`           |
| `http.auth`             | 認証ヘッダとトークン          | `http.header`           |

MVP 時点ではすべて `source.kind` が `manual` である。
