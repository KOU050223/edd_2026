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

`概要`（`Concept.summary`）は、表示名だけでは決まらない粒度と深さを補う 1〜2 文である。
**確認問題の生成（#184）が AI へ渡す入力でもある。** 表示名を言い換えただけの文や
「〜を学ぶ」のような学習の説明は書かない。その概念で何が起きるか、どこでつまずくかを書く。
全 Concept が必ず持つ（空欄は `npm run check:concepts` が落とす）。
`|` `"` `\` は使えない。

## Go

| ID                        | 表示名                       | 概要                                                                                                                 | 前提                      |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `go.variable_declaration` | 変数宣言と `:=`              | var と `:=` の使い分け。`:=` は関数の内側でしか書けず、型は右辺から推論される。                                      | —                         |
| `go.basic_types`          | 基本型とゼロ値               | int / string / bool などの基本型。宣言しただけで 0、空文字列、false が入るため、未初期化の状態が存在しない。         | `go.variable_declaration` |
| `go.control_flow`         | if / for / switch            | 条件分岐と繰り返し。ループは for だけで while は無く、switch は各 case の末尾で自動的に抜ける。                      | `go.variable_declaration` |
| `go.function_basics`      | 関数と複数戻り値             | func による定義。戻り値を複数返せるため、結果とエラーを同時に返す形が標準になっている。                              | `go.basic_types`          |
| `go.error_handling`       | error 型と `if err != nil`   | エラーは例外ではなく戻り値である。呼び出しごとに err を確認し、fmt.Errorf の %w で包んで文脈を足す。                 | `go.function_basics`      |
| `go.slice_basics`         | Slice の生成と参照           | 可変長の列。内部は配列への参照（先頭・長さ・容量）なので、コピーしても同じ配列を指す。                               | `go.basic_types`          |
| `go.slice_append`         | `append` と再割り当て        | append は容量が足りないと新しい配列へ移すため、戻り値を必ず受け取り直す。元の変数だけを見ていると変更が消える。      | `go.slice_basics`         |
| `go.map_basics`           | Map と comma-ok              | キーと値の対応表。`v, ok := m[k]` の ok で、値がゼロ値なのかキーが無いのかを区別する。                               | `go.basic_types`          |
| `go.struct_basics`        | struct の定義と埋め込み      | フィールドの集まりで型を作る。埋め込むと、その型のフィールドとメソッドをそのまま自分のものとして呼べる。             | `go.basic_types`          |
| `go.pointer_basics`       | ポインタと `&` / `*`         | `&` でアドレスを取り、`*` で指し先を読み書きする。値のコピーを避け、呼び出し先から元の値を変えるために使う。         | `go.struct_basics`        |
| `go.pointer_receiver`     | 値レシーバとポインタレシーバ | 値レシーバのメソッドには複製が渡るので、中で変えても呼び出し元へ伝わらない。状態を変えるならポインタレシーバにする。 | `go.pointer_basics`       |
| `go.interface_basics`     | interface の暗黙実装         | メソッドの集合を満たす型は、宣言なしにその interface を実装したことになる。実装側は interface を知らなくてよい。     | `go.struct_basics`        |
| `go.goroutine`            | goroutine の起動             | go で関数を並行に走らせる。呼び出しは即座に返るため、終了を待つ仕組みが無ければ main の終了で打ち切られる。          | `go.function_basics`      |
| `go.channel`              | channel の送受信             | goroutine 間で値を受け渡す通路。受信は値が来るまで待ち、バッファが無ければ送信側も受け取られるまで待つ。             | `go.goroutine`            |
| `go.select`               | `select` による多重化        | 複数の channel を同時に待ち、準備できたものから処理する。default を書くと待たずに次へ進める。                        | `go.channel`              |
| `go.context`              | `context` によるキャンセル   | 打ち切りと締め切りを呼び出しの連鎖へ伝える仕組み。Done を監視して途中で止め、cancel は defer で必ず呼ぶ。            | `go.channel`              |
| `go.defer`                | `defer` の実行順序           | 関数を抜ける直前の実行を予約する。登録の逆順に走るので、後片付けを取得処理の隣に書ける。                             | `go.function_basics`      |
| `go.package_visibility`   | パッケージと公開/非公開      | 識別子の先頭が大文字なら他パッケージから見え、小文字ならパッケージ内に閉じる。アクセス修飾子は無い。                 | `go.function_basics`      |
| `go.module_dependency`    | go.mod と依存管理            | モジュール名と依存バージョンを go.mod に記録する。go get で足し、go mod tidy で使っていない依存を落とす。            | `go.package_visibility`   |
| `go.testing_basics`       | `testing` パッケージ         | `_test.go` に `TestXxx(t *testing.T)` を書き、go test で走らせる。失敗は t.Errorf で報告し、戻り値では返さない。     | `go.function_basics`      |

## TypeScript / JavaScript

| ID                        | 表示名                                | 概要                                                                                                                           | 前提                      |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `ts.variable_declaration` | 変数宣言と `const` / `let`            | const は再代入を禁じ、let は許す。const でもオブジェクトの中身は変えられる。var はブロックスコープを持たないため使わない。     | —                         |
| `ts.primitive_types`      | プリミティブ型と値                    | string / number / boolean と、値が無いことを表す null と undefined。number は整数と小数を区別しない。                          | `ts.variable_declaration` |
| `ts.control_flow`         | if / switch / ループ                  | 条件分岐と繰り返し。条件は真偽値へ暗黙変換されるため、空文字列や 0 が偽として扱われる。                                        | `ts.variable_declaration` |
| `ts.function_basics`      | 関数宣言と引数・戻り値                | function とアロー関数。引数と戻り値に型を付けられ、既定値や可変長引数も書ける。this の扱いは両者で違う。                       | `ts.primitive_types`      |
| `ts.object_basics`        | オブジェクトとプロパティ              | キーと値の集まり。ドットや角括弧で参照し、分割代入とスプレッドで取り出しや組み替えを行う。                                     | `ts.primitive_types`      |
| `ts.array_basics`         | 配列の生成と要素アクセス              | 値を並べた可変長の列。添字は 0 から始まり、範囲外を読むと例外ではなく undefined が返る。                                       | `ts.primitive_types`      |
| `ts.array_methods`        | map / filter / reduce                 | 配列を変換・絞り込み・集約する高階関数。元の配列を書き換えず、新しい配列や値を返す。                                           | `ts.array_basics`         |
| `ts.closure`              | クロージャとレキシカルスコープ        | 関数が定義された場所の変数を覚えて持ち歩く仕組み。状態を閉じ込められる反面、捕まえた変数を後から変えると全員が新しい値を見る。 | `ts.function_basics`      |
| `ts.class_basics`         | class とインスタンス                  | class でひな形を定義し、new で実体を作る。constructor で初期化し、フィールド・メソッド・継承を持つ。                           | `ts.object_basics`        |
| `ts.module_basics`        | import / export とモジュール          | ファイル単位で公開するものを export し、使う側が import する。export していない値は外から触れない。                            | `ts.function_basics`      |
| `ts.error_handling`       | throw / try / catch                   | 例外を投げて捕まえる。catch が受け取る値は unknown なので、型を確かめてから扱う。finally は成功でも失敗でも走る。              | `ts.function_basics`      |
| `ts.promise_basics`       | Promise と状態遷移                    | 非同期処理の結果を表す値。pending から fulfilled か rejected へ一度だけ移り、then / catch で続きを繋ぐ。                       | `ts.function_basics`      |
| `ts.async_await`          | async / await                         | Promise を同期的な見た目で書く構文。await で解決を待ち、失敗は try / catch で受ける。async 関数は必ず Promise を返す。         | `ts.promise_basics`       |
| `ts.type_annotation`      | 型注釈と型推論                        | 変数や関数へ型を宣言する。多くの場所は推論で足りるので、引数・戻り値・公開する境界に付けるのが基本になる。                     | `ts.primitive_types`      |
| `ts.interface_basics`     | interface とオブジェクト型            | オブジェクトの形に名前を付ける。名前ではなく構造が一致すれば同じ型として通る。                                                 | `ts.type_annotation`      |
| `ts.union_type`           | union 型とリテラル型                  | 複数の型のどれか一方を取ることを表す型。文字列リテラルを並べると、取りうる値そのものを型で固定できる。                         | `ts.type_annotation`      |
| `ts.type_narrowing`       | 型ガードと絞り込み                    | typeof や in、null の判定で union を1つの型へ絞る。絞り込めた範囲でだけ、その型のプロパティを触れる。                          | `ts.union_type`           |
| `ts.generic`              | ジェネリクスと型パラメータ            | 型を引数として受け取り、中身の型を保ったまま使い回せる関数や型を書く。any で潰さずに汎用化する手段である。                     | `ts.interface_basics`     |
| `ts.utility_type`         | Partial / Pick などのユーティリティ型 | 既存の型から別の型を導く組み込みの型。Partial で省略可能にし、Pick や Omit でプロパティを取捨する。                            | `ts.generic`              |
| `ts.testing_basics`       | テストの構成とアサーション            | describe / test で単位を分け、期待値との一致を検証する。失敗したときに原因が特定できる粒度に分ける。                           | `ts.function_basics`      |

## Python

| ID                            | 表示名                      | 概要                                                                                                                   | 前提                          |
| ----------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `python.variable_declaration` | 変数と代入                  | 宣言は無く、代入した時点で名前が値を指す。型は値が持つので、同じ名前へ別の型を入れられる。                             | —                             |
| `python.basic_types`          | 数値・文字列・真偽値と None | int / float / str / bool と、値が無いことを表す None。str は変更できず、操作は新しい文字列を返す。                     | `python.variable_declaration` |
| `python.control_flow`         | if / for / while            | 条件分岐と繰り返し。ブロックはインデントで表し、for は反復可能オブジェクトから要素を1つずつ受け取る。                  | `python.variable_declaration` |
| `python.function_basics`      | def と引数・戻り値          | def で定義する。既定値・キーワード引数・可変長引数を取れ、return が無ければ None を返す。                              | `python.basic_types`          |
| `python.list_basics`          | list とスライス             | 順序を持つ可変長の列。負の添字で末尾から数え、`[start:end]` で部分列を新しい list として取り出す。                     | `python.basic_types`          |
| `python.dict_basics`          | dict と get / in            | キーと値の対応表。無いキーを添字で読むと例外になるため、get で既定値を返すか in で存在を確かめる。                     | `python.basic_types`          |
| `python.tuple_set`            | tuple と set                | tuple は変更できない並び、set は重複の無い集合で順序を持たない。何を保証したいかで list と使い分ける。                 | `python.basic_types`          |
| `python.comprehension`        | 内包表記                    | 繰り返しと条件を1つの式で書き、list / dict / set を作る記法。append を並べる手続きを短く表せる。                       | `python.list_basics`          |
| `python.class_basics`         | class とインスタンス        | class でひな形を定義し、`__init__` で初期化する。メソッドの第1引数 self がインスタンス自身を指す。                     | `python.function_basics`      |
| `python.error_handling`       | raise / try / except        | 例外を投げて捕まえる。except は種類を指定して受け、else と finally で後処理を分ける。                                  | `python.function_basics`      |
| `python.module_basics`        | import とモジュール         | ファイルとディレクトリがモジュールとパッケージになる。import で名前空間へ取り込み、`__name__` で直接実行かを判定する。 | `python.function_basics`      |
| `python.typing`               | 型ヒント                    | 引数や戻り値に型を注釈する。実行時には強制されないが、静的解析とエディタの補完が効くようになる。                       | `python.function_basics`      |
| `python.venv_dependency`      | venv と pip による依存管理  | プロジェクトごとに仮想環境を作り、pip で依存を入れる。環境を分けないと別のプロジェクトとバージョンが衝突する。         | `python.module_basics`        |
| `python.testing_basics`       | pytest の基本               | `test_` で始まる関数を書き、assert で期待値を確かめる。前準備は fixture にまとめて共有する。                           | `python.function_basics`      |

## Rust

| ID                          | 表示名                  | 概要                                                                                                             | 前提                        |
| --------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `rust.variable_declaration` | let と mut              | let の束縛は既定で不変で、書き換えるには mut を付ける。同じ名前を let で再束縛すると別の値になる。               | —                           |
| `rust.basic_types`          | スカラ型と複合型        | 整数・浮動小数・bool・char と、tuple や配列。整数の桁あふれはデバッグビルドで panic する。                       | `rust.variable_declaration` |
| `rust.control_flow`         | if / loop / match       | if も match も値を返す式である。繰り返しは loop / while / for で、loop は break に値を持たせられる。             | `rust.variable_declaration` |
| `rust.function_basics`      | fn と戻り値             | fn で定義し、引数と戻り値の型は必ず書く。最後の式が戻り値になり、セミコロンを付けると値が返らない。              | `rust.basic_types`          |
| `rust.ownership`            | 所有権と move           | 値の所有者は常に1つで、代入や引数渡しで移動する。所有者がスコープを抜けた時点で値は破棄される。                  | `rust.function_basics`      |
| `rust.borrowing`            | 参照と借用              | `&` で所有権を移さずに貸す。不変の借用は同時に何個でも、可変の借用は同時に1つだけ許される。                      | `rust.ownership`            |
| `rust.lifetime`             | ライフタイム注釈        | 参照が有効な範囲をコンパイラへ伝える注釈。返す参照がどの引数由来かを示し、破棄済みの値への参照を防ぐ。           | `rust.borrowing`            |
| `rust.struct_basics`        | struct と impl          | フィールドの集まりを struct で定義し、メソッドは impl に書く。self を借用するか消費するかでできることが変わる。  | `rust.basic_types`          |
| `rust.enum_match`           | enum と match           | 取りうる状態を列挙し、match で分岐する。すべての場合を書かないとコンパイルが通らない。                           | `rust.struct_basics`        |
| `rust.error_handling`       | Result / Option と `?`  | 失敗は Result、値の不在は Option で型に表す。`?` で呼び出し元へ早く返し、unwrap は失敗すると panic する。        | `rust.enum_match`           |
| `rust.trait_basics`         | trait と実装            | 共通のふるまいを trait で定義し、型ごとに impl する。ジェネリクスの境界としても使う。                            | `rust.struct_basics`        |
| `rust.cargo_dependency`     | Cargo とクレート        | Cargo.toml に依存を書き、cargo build や cargo test で解決する。Cargo.lock でバージョンを固定する。               | `rust.function_basics`      |
| `rust.testing_basics`       | `#[test]` と cargo test | `#[test]` を付けた関数を cargo test で走らせる。assert_eq! で期待値を確かめ、`#[cfg(test)]` のモジュールへ置く。 | `rust.function_basics`      |

## Java

| ID                          | 表示名                   | 概要                                                                                                         | 前提                        |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `java.variable_declaration` | 変数宣言と基本型         | 型を明記して宣言する。int や double の基本型は値そのものを持ち、String やクラスは参照を持つ。                | —                           |
| `java.control_flow`         | if / for / switch        | 条件分岐と繰り返し。拡張 for でコレクションを辿り、switch は break を書かないと次の case へ落ちる。          | `java.variable_declaration` |
| `java.class_basics`         | class とインスタンス     | class でフィールドとメソッドを定義し、new で実体を作る。コンストラクタで初期状態を決める。                   | `java.variable_declaration` |
| `java.method_basics`        | メソッドとオーバーロード | 戻り値の型と引数を宣言して定義する。同じ名前でも引数の型や個数が違えば別のメソッドとして持てる。             | `java.class_basics`         |
| `java.inheritance`          | 継承と override          | extends で親の実装を引き継ぎ、`@Override` でふるまいを差し替える。super で親の実装を呼べる。                 | `java.class_basics`         |
| `java.interface_basics`     | interface と実装         | 実装を持たないメソッドの約束を定義し、implements で満たす。1つのクラスが複数を実装できる。                   | `java.inheritance`          |
| `java.collection_basics`    | List / Map / Set         | 順序つきの List、キーと値の Map、重複の無い Set。変数の型は実装クラスではなく interface で受ける。           | `java.class_basics`         |
| `java.generics`             | ジェネリクス             | 型パラメータで中身の型を固定し、キャストなしに型安全なコレクションや API を書く。                            | `java.collection_basics`    |
| `java.stream_api`           | Stream API とラムダ      | コレクションを filter / map / collect の流れで処理する。ラムダ式で処理を渡し、元のコレクションは変えない。   | `java.generics`             |
| `java.error_handling`       | throw / try / catch      | 例外を投げて捕まえる。検査例外は throws の宣言か catch が必須で、try-with-resources は後片付けを任せられる。 | `java.method_basics`        |
| `java.package_build`        | package とビルドツール   | package でクラスを名前空間へ置き、ディレクトリ構成と対応させる。依存とビルドは Maven や Gradle が管理する。  | `java.class_basics`         |
| `java.testing_basics`       | JUnit の基本             | `@Test` を付けたメソッドを走らせ、assertEquals などで期待値を確かめる。前準備は `@BeforeEach` に置く。       | `java.method_basics`        |

## C#

| ID                            | 表示名                | 概要                                                                                                            | 前提                          |
| ----------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `csharp.variable_declaration` | var と型宣言          | 型を明記するか var で推論させる。var でも型は宣言時に確定し、後から別の型は入らない。                           | —                             |
| `csharp.basic_types`          | 値型と参照型          | int や struct は値としてコピーされ、class は参照が渡る。どちらかで代入と引数渡しの意味が変わる。                | `csharp.variable_declaration` |
| `csharp.control_flow`         | if / for / switch     | 条件分岐と繰り返し。foreach で列挙し、switch 式はパターンに応じた値を返せる。                                   | `csharp.variable_declaration` |
| `csharp.class_basics`         | class とプロパティ    | class でフィールドとメソッドを定義する。プロパティは get / set に手続きを挟める、フィールドに見える窓口である。 | `csharp.basic_types`          |
| `csharp.method_basics`        | メソッドと引数        | 戻り値の型と引数を宣言する。既定値と名前付き引数を取れ、ref / out で参照渡しや追加の戻り値を扱う。              | `csharp.class_basics`         |
| `csharp.inheritance`          | 継承と override       | 基底クラスを継承し、virtual なメソッドを override で差し替える。base で基底の実装を呼ぶ。                       | `csharp.class_basics`         |
| `csharp.interface_basics`     | interface と実装      | 実装を持たない約束を定義し、クラスや struct が満たす。依存を具体的な型から切り離すのに使う。                    | `csharp.inheritance`          |
| `csharp.collection_basics`    | List / Dictionary     | 可変長の List と、キーと値の Dictionary。無いキーの参照は例外になるため、TryGetValue で確認と取得を同時に行う。 | `csharp.basic_types`          |
| `csharp.linq`                 | LINQ とラムダ         | Where / Select / OrderBy でコレクションを問い合わせる。評価は遅延し、列挙した時点で初めて実行される。           | `csharp.collection_basics`    |
| `csharp.async_await`          | async / await と Task | 非同期処理を Task で表し、await で完了を待つ。async void は例外を捕まえられないため避ける。                     | `csharp.method_basics`        |
| `csharp.error_handling`       | throw / try / catch   | 例外を投げて捕まえる。catch を型で分け、finally や using で後片付けを確実に行う。                               | `csharp.method_basics`        |
| `csharp.dotnet_project`       | csproj と dotnet CLI  | csproj に依存とターゲットを書き、dotnet build / run / test で操作する。                                         | `csharp.class_basics`         |
| `csharp.testing_basics`       | xUnit の基本          | `[Fact]` や `[Theory]` を付けたメソッドを走らせ、Assert で期待値を確かめる。                                    | `csharp.method_basics`        |

## PHP

| ID                         | 表示名                       | 概要                                                                                                            | 前提                       |
| -------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `php.variable_declaration` | $変数と代入                  | 変数は $ で始め、宣言せず代入で作る。関数の外にある変数は、中から自動では見えない。                             | —                          |
| `php.basic_types`          | スカラ型と null              | int / float / string / bool と null。== は型を変換して比べるため、意図しない一致を避けるには === を使う。       | `php.variable_declaration` |
| `php.control_flow`         | if / foreach / while         | 条件分岐と繰り返し。foreach は配列のキーと値を順に受け取り、HTML へ埋め込む書き方もできる。                     | `php.variable_declaration` |
| `php.function_basics`      | function と引数・戻り値      | function で定義し、引数と戻り値に型を宣言できる。既定値と可変長引数も取れる。                                   | `php.basic_types`          |
| `php.array_basics`         | array と連想配列             | 添字配列と連想配列が同じ array 型である。キーの有無は isset か array_key_exists で確かめる。                    | `php.basic_types`          |
| `php.string_basics`        | 文字列操作とヒアドキュメント | 二重引用符の中では変数が展開され、単引用符では展開されない。連結は . で行い、長い文面はヒアドキュメントで書く。 | `php.basic_types`          |
| `php.class_basics`         | class とインスタンス         | class でプロパティとメソッドを定義し、new で作る。自身は $this で参照し、メンバへは -> でアクセスする。         | `php.function_basics`      |
| `php.error_handling`       | throw / try / catch          | 例外を投げて捕まえる。Throwable を受けて記録し、握りつぶさずに呼び出し元へ伝える。                              | `php.function_basics`      |
| `php.web_request`          | $_GET / $_POST とレスポンス  | リクエストの値は `$_GET` や `$_POST` から読む。外部入力なので必ず検証し、出力するときにエスケープする。         | `php.basic_types`          |
| `php.composer`             | Composer と autoload         | composer.json に依存を書き、vendor の autoload で読み込む。composer.lock でバージョンを固定する。               | `php.function_basics`      |
| `php.testing_basics`       | PHPUnit の基本               | TestCase を継承したクラスに test メソッドを書き、assertSame などで期待値を確かめる。                            | `php.function_basics`      |

## Ruby

| ID                          | 表示名                       | 概要                                                                                                        | 前提                        |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------- |
| `ruby.variable_declaration` | 変数と代入                   | 宣言せず代入で作る。先頭の記号でスコープが変わり、`@` はインスタンス変数、大文字で始まる名前は定数になる。  | —                           |
| `ruby.basic_types`          | 数値・文字列・シンボルと nil | Integer / Float / String と、名前を表す Symbol。値が無いことは nil で表し、nil と false だけが偽になる。    | `ruby.variable_declaration` |
| `ruby.control_flow`         | if / each / while            | 条件分岐と繰り返し。if は値を返す式であり、繰り返しは while より each などのイテレータで書く。              | `ruby.variable_declaration` |
| `ruby.method_basics`        | def と引数・戻り値           | def で定義する。最後に評価した式が戻り値になり、キーワード引数や既定値を取れる。                            | `ruby.basic_types`          |
| `ruby.block_basics`         | ブロックと each / map        | メソッドへ処理の塊を渡す仕組み。each は元の要素を順に渡し、map は変換した新しい配列を返す。                 | `ruby.method_basics`        |
| `ruby.array_hash`           | Array と Hash                | 順序つきの Array と、キーと値の Hash。Hash のキーには文字列よりシンボルを使うのが一般的である。             | `ruby.basic_types`          |
| `ruby.class_basics`         | class とインスタンス変数     | class で定義し、initialize で初期化する。`@` で始まる変数は外から直接触れず、attr_accessor などで公開する。 | `ruby.method_basics`        |
| `ruby.module_mixin`         | module と mixin              | module に共通のふるまいをまとめ、include でクラスへ混ぜ込む。名前空間としても使う。                         | `ruby.class_basics`         |
| `ruby.error_handling`       | raise / rescue / ensure      | raise で例外を投げ、rescue で種類ごとに捕まえる。ensure は成功でも失敗でも必ず走る。                        | `ruby.method_basics`        |
| `ruby.gem_bundler`          | gem と Bundler               | Gemfile に依存を書き、bundle install で入れる。Gemfile.lock でバージョンを固定する。                        | `ruby.class_basics`         |
| `ruby.testing_basics`       | Minitest / RSpec の基本      | テストの単位を定義し、期待値との一致を検証する。前準備は setup や before にまとめる。                       | `ruby.method_basics`        |

## Git

| ID                | 表示名                        | 概要                                                                                                      | 前提             |
| ----------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------- |
| `git.repository`  | init / clone とリポジトリ     | git init で履歴の入れ物を作り、clone で既存のリポジトリを複製する。履歴は .git の中に全部ある。           | —                |
| `git.staging`     | add とステージング            | 作業ツリーの変更のうち、次のコミットに含めるものを add で選ぶ。status と diff で選んだ内容を確かめる。    | `git.repository` |
| `git.commit`      | コミットとメッセージ          | ステージした内容を1つの変更として履歴へ記録する。メッセージには何を、なぜ変えたかを書く。                 | `git.staging`    |
| `git.log_history` | log / diff で履歴を読む       | log で変更の並びを辿り、diff や show で中身を見る。いつ何が入ったかを調べる起点になる。                   | `git.commit`     |
| `git.branch`      | ブランチと切り替え            | 履歴を分けて並行に作業する。switch で作業ツリーを別のブランチへ移し、未コミットの変更は持ち越される。     | `git.commit`     |
| `git.merge`       | マージとコンフリクト解消      | 分かれた履歴を1つに合わせる。同じ箇所が両方で変わっているとコンフリクトになり、手で解決してコミットする。 | `git.branch`     |
| `git.rebase`      | rebase と履歴の書き換え       | コミットを別の土台へ付け替えて履歴を直線にする。共有済みのコミットを書き換えると、他の人の履歴とずれる。  | `git.merge`      |
| `git.remote`      | remote / push / pull          | リモートリポジトリと履歴をやり取りする。push で送り、fetch や pull で取り込む。                           | `git.commit`     |
| `git.stash`       | stash と一時退避              | コミットしたくない変更を一時的に退避し、後で戻す。作業の途中で別の対応へ移るときに使う。                  | `git.commit`     |
| `git.undo`        | reset / revert による取り消し | reset は履歴やステージを巻き戻し、revert は打ち消すコミットを新しく積む。共有済みなら revert を選ぶ。     | `git.commit`     |

## 設計

| ID                          | 表示名                 | 概要                                                                                                               | 前提                   |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `design.naming`             | 命名と意図の表現       | 名前で、それが何であり何のためにあるかを示す。読み手が実装を追わずに意図を掴めるかで良し悪しを判断する。           | —                      |
| `design.function_size`      | 関数の分割と責務       | 1つの関数に1つの責務を持たせる。行数ではなく、やっていることを1文で言えるかで分割を決める。                        | `design.naming`        |
| `design.dry`                | 重複と抽象化           | 同じ知識の重複は減らす。ただし形が似ているだけのコードをまとめると、後から別々に変えられなくなる。                 | `design.function_size` |
| `design.dependency`         | 依存の方向と結合度     | どちらがどちらを知るかを決める。呼ばれる側が呼ぶ側を知らない形にすると、変更の影響が広がらない。                   | `design.function_size` |
| `design.interface_contract` | インターフェースと契約 | 境界で交わす約束（引数・戻り値・失敗の表し方）を決める。実装の詳細を約束へ漏らさない。                             | `design.dependency`    |
| `design.error_design`       | エラーの表現と伝播     | 失敗を戻り値と例外のどちらで表し、どこで扱うかを決める。握りつぶさず、呼び出し側が判断できる形で伝える。           | `design.function_size` |
| `design.state`              | 状態と副作用の管理     | 変わる状態をどこに置くかを決める。純粋な計算と副作用を分けると、動きを追いやすくなる。                             | `design.function_size` |
| `design.testability`        | テストしやすい設計     | 外部依存を境界へ追い出し、判断のロジックは引数と戻り値だけで書く。偽物が大量に要るのは設計が漏れている合図である。 | `design.dependency`    |

## データベース

| ID                    | 表示名                         | 概要                                                                                                     | 前提                  |
| --------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------- |
| `db.relational_model` | テーブルとリレーション         | データを行と列の表で表し、キーで表どうしを関係づける。1行が何を表すかを決めるのが出発点になる。          | —                     |
| `db.sql_select`       | SELECT と WHERE                | 必要な列と行を問い合わせる。条件で絞り、並び順と件数を指定して取り出す。                                 | `db.relational_model` |
| `db.sql_join`         | JOIN と結合                    | 複数の表をキーで繋いで1つの結果にする。内部結合と外部結合で、対応が無い行の扱いが変わる。                | `db.sql_select`       |
| `db.sql_aggregate`    | GROUP BY と集約                | 行をまとめて件数や合計を求める。集約の前に絞るか後に絞るかで、WHERE と HAVING のどちらを使うかが変わる。 | `db.sql_select`       |
| `db.sql_write`        | INSERT / UPDATE / DELETE       | 行の追加・更新・削除。UPDATE と DELETE は条件を書き忘れると全行に及ぶ。                                  | `db.relational_model` |
| `db.normalization`    | 正規化と冗長性                 | 重複した事実を別の表へ分け、更新の食い違いを防ぐ。読み取りの都合で崩すときは理由を決めておく。           | `db.relational_model` |
| `db.index`            | インデックスと検索性能         | 検索を速くする索引。書き込みは遅くなり容量も増えるため、実際に効く条件を見て張る。                       | `db.sql_select`       |
| `db.transaction`      | トランザクションと整合性       | 複数の変更をまとめて、全部成功か全部取り消しにする。途中の状態を他から見せない。                         | `db.sql_write`        |
| `db.migration`        | スキーマ変更とマイグレーション | スキーマの変更を順序つきの差分として記録し、どの環境でも同じ手順で同じ状態にする。                       | `db.relational_model` |

## HTTP

| ID                      | 表示名                        | 概要                                                                                                                         | 前提                    |
| ----------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `http.request_response` | リクエストとレスポンスの構造  | クライアントが要求を送り、サーバーが応答を返す。どちらも開始行・ヘッダ・本文で構成される。                                   | —                       |
| `http.method_semantics` | GET / POST などメソッドの意味 | 操作の種類をメソッドで表す。GET は取得で状態を変えず、状態を変える要求には POST などを使う。                                 | `http.request_response` |
| `http.status_code`      | ステータスコードの区分        | 2xx は成功、3xx は転送、4xx は要求側の誤り、5xx はサーバー側の失敗。区分を守ると呼び出し側が機械的に判断できる。             | `http.request_response` |
| `http.header`           | ヘッダと Content-Type         | 本文の形式やキャッシュの指示をヘッダで伝える。Content-Type が実際の本文と違うと、受け取り側の解釈がずれる。                  | `http.request_response` |
| `http.rest`             | REST のリソース指向           | URL でリソースを指し、操作はメソッドで表す。URL へ動詞を入れず、状態の変化を統一した形で扱う。                               | `http.method_semantics` |
| `http.cors`             | CORS とオリジン               | ブラウザは別オリジンへの要求を既定で制限する。サーバーが許可を応答ヘッダで示し、資格情報つきの要求では許可を無制限にしない。 | `http.header`           |
| `http.auth`             | 認証ヘッダとトークン          | Authorization ヘッダでトークンを渡す。転送先が変わると資格情報が漏れるため、送る相手を限定する。                             | `http.header`           |

MVP 時点ではすべて `source.kind` が `manual` である。
