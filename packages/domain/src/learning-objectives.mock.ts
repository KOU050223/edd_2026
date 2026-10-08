import type { LearningObjective } from "./learning-objective.js";
import type { ConceptId } from "./profile.js";

/**
 * 「理解すること」のモック（設計/05 #224）。Go の Concept だけを持つ。
 *
 * AI で生成する口ができるまでの仮置きで、各 Concept の `summary`
 * （`packages/domain/concepts.md`）を元に手で起こした。1 Concept あたり 4〜5 項目。
 *
 * API は同じ ID で D1 へ移した表（`apps/api/migrations/0017_fixed_objectives.sql`）を読み、
 * これを使わない（#245）。Web と VS Code が API から読むように変えたら消す。
 */
const GO_OBJECTIVES: Record<ConceptId, readonly (readonly [key: string, label: string])[]> = {
  "go.variable_declaration": [
    ["var_vs_short", "var と := の使い分け"],
    ["short_inside_function", ":= は関数の内側でしか書けない"],
    ["type_inference", "型が右辺から推論される"],
    ["redeclare_rule", ":= は左辺に新しい変数が1つ以上あるときだけ使える"],
  ],
  "go.basic_types": [
    ["builtin_types", "int / string / bool などの基本型"],
    ["zero_value", "宣言しただけで入るゼロ値（0・空文字列・false）"],
    ["no_uninitialized", "未初期化の状態が存在しない"],
    ["explicit_conversion", "異なる型どうしは明示的に変換しないと演算できない"],
  ],
  "go.control_flow": [
    ["if_with_init", "if の条件の前に初期化文を書ける"],
    ["for_only_loop", "ループは for だけで while は無い"],
    ["for_range", "for range でスライスや map を走査する"],
    ["switch_no_fallthrough", "switch は各 case の末尾で自動的に抜ける"],
  ],
  "go.function_basics": [
    ["func_definition", "func による関数の定義と引数・戻り値の型"],
    ["multiple_returns", "戻り値を複数返せる"],
    ["result_and_error", "結果とエラーを同時に返す形が標準"],
    ["blank_identifier", "使わない戻り値は _ で捨てる"],
  ],
  "go.error_handling": [
    ["error_as_value", "エラーは例外ではなく戻り値"],
    ["check_err", "呼び出しごとに if err != nil で確認する"],
    ["wrap_with_w", "fmt.Errorf の %w で包んで文脈を足す"],
    ["errors_is_as", "errors.Is / errors.As で包まれたエラーを判別する"],
    ["return_early", "エラー時は早めに return して正常系を左に寄せる"],
  ],
  "go.slice_basics": [
    ["create_slice", "リテラルと make によるスライスの生成"],
    ["len_and_cap", "長さ（len）と容量（cap）の違い"],
    ["backing_array", "内部は配列への参照（先頭・長さ・容量）"],
    ["shared_on_copy", "コピーや部分スライスは同じ配列を指す"],
  ],
  "go.slice_append": [
    ["append_basics", "append で要素を末尾に足す"],
    ["reallocation", "容量が足りないと新しい配列へ移る"],
    ["reassign_result", "戻り値を必ず受け取り直す"],
    ["lost_update", "元の変数だけを見ていると変更が消える"],
  ],
  "go.map_basics": [
    ["create_map", "make とリテラルによる map の生成"],
    ["read_write_delete", "値の読み書きと delete"],
    ["comma_ok", "v, ok := m[k] でキーの有無を確かめる"],
    ["zero_vs_missing", "値がゼロ値なのかキーが無いのかを区別する"],
    ["nil_map_write", "nil の map に書き込むと panic する"],
  ],
  "go.struct_basics": [
    ["define_struct", "フィールドの集まりで型を定義する"],
    ["struct_literal", "フィールド名付きのリテラルで値を作る"],
    ["embedding", "別の型を埋め込む"],
    ["promoted_members", "埋め込んだ型のフィールドとメソッドをそのまま呼べる"],
  ],
  "go.pointer_basics": [
    ["address_of", "& でアドレスを取る"],
    ["dereference", "* で指し先を読み書きする"],
    ["avoid_copy", "値のコピーを避けるために使う"],
    ["mutate_caller", "呼び出し先から元の値を変えられる"],
    ["nil_pointer", "nil ポインタを参照すると panic する"],
  ],
  "go.pointer_receiver": [
    ["value_receiver_copy", "値レシーバには複製が渡る"],
    ["change_not_visible", "値レシーバの中で変えても呼び出し元へ伝わらない"],
    ["pointer_receiver_mutate", "状態を変えるならポインタレシーバにする"],
    ["consistent_receivers", "1つの型のレシーバはどちらかにそろえる"],
  ],
  "go.interface_basics": [
    ["method_set", "interface はメソッドの集合"],
    ["implicit_impl", "宣言なしに満たすだけで実装したことになる"],
    ["decoupled_impl", "実装側は interface を知らなくてよい"],
    ["type_assertion", "型アサーションで中身の具体型を取り出す"],
  ],
  "go.goroutine": [
    ["go_keyword", "go で関数を並行に走らせる"],
    ["returns_immediately", "go の呼び出しは即座に返る"],
    ["main_exit", "待つ仕組みが無ければ main の終了で打ち切られる"],
    ["wait_group", "sync.WaitGroup で終了を待つ"],
  ],
  "go.channel": [
    ["send_receive", "<- による値の送受信"],
    ["receive_blocks", "受信は値が来るまで待つ"],
    ["unbuffered_sync", "バッファが無ければ送信側も受け取られるまで待つ"],
    ["buffered", "バッファ付き channel は容量まで待たずに送れる"],
    ["close_and_range", "close して range で受け取り終える"],
  ],
  "go.select": [
    ["wait_multiple", "複数の channel を同時に待つ"],
    ["ready_first", "準備できたものから処理する"],
    ["default_case", "default を書くと待たずに次へ進む"],
    ["timeout", "time.After と組み合わせてタイムアウトを作る"],
  ],
  "go.context": [
    ["propagate", "打ち切りと締め切りを呼び出しの連鎖へ伝える"],
    ["with_cancel_timeout", "WithCancel / WithTimeout で派生させる"],
    ["watch_done", "Done を監視して途中で止める"],
    ["defer_cancel", "cancel は defer で必ず呼ぶ"],
    ["first_argument", "context は関数の第1引数で受け渡す"],
  ],
  "go.defer": [
    ["execution_timing", "実行タイミング（関数を抜けるとき）"],
    ["argument_evaluation", "引数が評価されるタイミング（defer を書いたとき）"],
    ["lifo_order", "複数あるときの実行順（登録の逆順）"],
    ["cleanup_near_acquire", "後片付けを取得処理の隣に書ける"],
    ["named_result", "名前付き戻り値を書き換えられる"],
  ],
  "go.package_visibility": [
    ["package_unit", "ディレクトリ単位のパッケージ"],
    ["uppercase_exported", "先頭が大文字なら他パッケージから見える"],
    ["lowercase_unexported", "先頭が小文字ならパッケージ内に閉じる"],
    ["no_access_modifier", "アクセス修飾子は無い"],
  ],
  "go.module_dependency": [
    ["module_name", "go.mod にモジュール名を記録する"],
    ["dependency_versions", "依存とそのバージョンを go.mod に記録する"],
    ["go_get", "go get で依存を足す"],
    ["go_mod_tidy", "go mod tidy で使っていない依存を落とす"],
    ["go_sum", "go.sum で依存の中身を検証する"],
  ],
  "go.testing_basics": [
    ["test_file", "_test.go にテストを書く"],
    ["test_func_signature", "TestXxx(t *testing.T) の形"],
    ["go_test", "go test で走らせる"],
    ["report_with_t", "失敗は t.Errorf で報告し、戻り値では返さない"],
    ["table_driven", "テーブル駆動で入力と期待値を並べる"],
  ],
};

export const MOCK_LEARNING_OBJECTIVES: readonly LearningObjective[] = Object.entries(
  GO_OBJECTIVES,
).flatMap(([conceptId, objectives]) =>
  objectives.map(([key, label]) => ({ id: `${conceptId}:${key}`, conceptId, label })),
);
