# Concept と Learner Profile

このドキュメントは Learner Profile に関する**契約**である。
命名規則・追加手順・習熟度の更新ルール・マイグレーション方針についてはこのドキュメントが
正典であり、コードはこれに従う。型定義は `packages/domain/src/profile.ts` にある。

Concept 一覧そのものはこのドキュメントには置かず、`packages/domain/concepts.md` を正典とする。
一覧は実行時にも必要なため、その表から `packages/domain/src/concepts.generated.ts` を機械的に
書き出す。生成物は新しい情報を持たず、表と同じ内容を import できる形にしたものである。

```bash
npm run gen:concepts     # 表から生成する
npm run check:concepts   # 表と生成物がズレていないか検査する
```

---

## Concept ID

学習概念には `<prefix>.<concept>` 形式の ID を付ける。prefix は言語
（`go` / `ts` / `python` …）か、言語を横断する領域（`git` / `design` / `db` / `http`）を表す。

```text
go.pointer_receiver
ts.type_narrowing
git.rebase
```

形式は `^[a-z0-9]+\.[a-z0-9_]+$`（`packages/domain/src/profile.ts` の `CONCEPT_ID_PATTERN`）。

### プレフィックスをフィールドではなく ID に含める理由

ID 単体で一意になるため、学習イベントやログに ID だけを載せれば意味が確定する。
プレフィックスを別フィールドに分けると、イベントを記録するすべての箇所で `conceptId` と
`language` を必ずセットで運ぶ必要があり、片方を落とした瞬間に名寄せ不能なデータが残る。

なお `Concept.language` フィールドも別に持つが、これは ID プレフィックスの
再掲であり、フィルタリング用の冗長な情報である。**ID とプレフィックスが食い違う
Concept を定義してはならない。**
領域の Concept でもフィールド名は `language` のままである。改名すると
`LearnerProfile` の互換性を壊すため、意味の広がりはドキュメントで吸収する。

### 「学習元」の扱い

学習元が広がっても Concept ID は変えない。可変なものは2つの直交する軸に逃がす。

| 軸               | 何を表すか                                        | 型                     |
| ---------------- | ------------------------------------------------- | ---------------------- |
| Concept の出所   | roadmap.sh / 教材 / 書籍 のどれを参考にした概念か | `Concept.source`       |
| イベントの観測元 | VS Code / GitHub / Web のどこで詰まったか         | `LearningEvent.origin` |

「roadmap.sh で学ぶ概念に、VS Code で詰まった」のように両者は独立して組み合わさる。
`go.pointer_receiver` という概念自体は、どの教材から来ても、どこで観測しても同じものなので、
ID を安定させ、変わるものだけをこの2フィールドに持たせる。

### なぜ Concept 一覧を自前で持つか

外部ロードマップから一覧を取り込む案を検討した上で、MVP では自前で持つことにした。

roadmap.sh（`nilbuild/developer-roadmap`）の Go ロードマップは、各トピックの
**解説文しか持たない**。「ポインタを学ぶには struct が必要」という前提関係のデータがなく、
`prerequisites` は取り込んでも埋まらない。また粒度が学習単位ではなく、
`break` や `boolean` のような文法要素と `echo` や `bubbletea` のような
ライブラリ名が同列に並ぶ（172件）。そのまま取り込むと大半が永久に `unobserved` になる。

自前で抱えるのは **ID と前提関係だけ**であり、これは Go の言語仕様が変わらない限り
更新が発生しない。重くて変化し続ける解説文は書かず、必要なら
`Concept.source` に外部の参照先を持たせてリンクする。

将来、一覧の管理自体をやめる判断もありうる。その場合は外部から取り込んだ結果を
生成物としてコミットし、実行時に外部へ取りに行かない形にする。
調査時点で上記リポジトリは移管を経験しており、外部の可用性に実行時依存させない。

---

## Concept 一覧

一覧の正典は **[`packages/domain/concepts.md`](../packages/domain/concepts.md)** にある。
生成物 `packages/domain/src/concepts.generated.ts` の隣に置き、
生成の入力と出力を並べて確認できるようにしている。

表の列は `ID | 表示名 | 概要 | 前提` である。
`packages/domain/scripts/gen-concepts.mjs` は**列を位置で読む**ので、
列を増やす・並べ替えるときはパーサとこの手順を同時に変える。

`概要`（`Concept.summary`）は 1〜2 文で、次の2か所が読む。

- UI での補足表示
- **確認問題の生成（#184）が AI へ渡す入力**

表示名だけでは問題の粒度と深さが決まらないため、生成の入力はここに依存する。
全 Concept が必ず持ち、空欄は `npm run check:concepts` が落とす。
表示名を言い換えただけの文や「〜を学ぶ」のような学習の説明は書かない。
その概念で何が起きるか、どこでつまずくかを書く。
`|` `"` `\` は使えない（表と生成物が壊れる）。

一覧は手で定義する。MVP の主対象は Go と TypeScript / JavaScript で、それ以外の言語
（Python / Rust / Java / C# / PHP / Ruby）と、言語を横断する領域（Git / 設計 /
データベース / HTTP）は暫定の一覧を持つ。
追加するときは次の手順に従う。

### TypeScript / JavaScript の扱い

TypeScript と JavaScript の共通概念は、**`ts.*` の単一体系**に定義する。JavaScript 用の
`js.*` は作らない。TypeScript は JavaScript の上位互換であり、変数・関数・配列・非同期処理
のような概念を別 ID にすると、同じ理解に対する mastery が二重に分かれるためである。

VS Code の `typescript` と `javascript` の languageId は、Concept を検索する際にどちらも
`ts` へ対応付ける。`Concept.language` は ID プレフィックスと一致させるため `ts` のまま保持し、
言語 ID をそのまま保存しない。TypeScript 固有の型システムも同じ `ts.*` に置く。

それ以外の言語（`python` / `rust` / `java` / `csharp` / `php` / `ruby`）は、
VS Code の languageId と一致するプレフィックスを使う。対応付けの表を増やさず、
languageId がそのまま prefix になる。

### 言語以外の領域

`git` / `design` / `db` / `http` のような言語を横断する領域も同じ `<prefix>.<concept>`
形式で定義する。これらはファイルの languageId に対応付かないため、VS Code 拡張の
プロンプトでは言語の Concept と別扱いで、languageId の有無に関わらず常に
「既知の概念一覧」へ載せる。載せる領域の一覧は
`apps/vscode-extension/src/ai/prompt/index.ts` の `CROSS_DOMAIN_PREFIXES` が持つ。

---

## Concept を新規追加する手順

1. **既存の一覧を確認する。** 表記違いの重複（`go.slice` と `go.slice_basics` など）は
   後から名寄せが必要になるため、近い ID がすでにないかを必ず見る。
2. **ID を決める。** `^[a-z0-9]+\.[a-z0-9_]+$` を満たすこと。単数形・スネークケースに揃える。
3. **`packages/domain/concepts.md` の表に行を追加する。** 前提となる Concept があれば
   `前提` 列に書く。
   前提は既存 ID のみを指し、循環してはならない。かつ、同じプレフィックスの
   Concept に限る。プレフィックスをまたぐ辺は Learning Map の木に描かれない。
   **`概要` 列は空にできない。** 1〜2 文で、その概念で何が起きるか・どこでつまずくかを書く
   （上の「Concept 一覧」を参照）。確認問題の生成（#184）がこの文を AI へ渡すため、
   ここが薄いと、その Concept の問題だけ粒度が浅くなる。
4. **`source` は `manual` になる。** 表に `source` 列はなく、
   `packages/domain/scripts/gen-concepts.mjs` が全件を `{ kind: "manual" }` として書き出す。
   MVP では Concept をすべて手で定義するためである。
   roadmap.sh や教材由来の Concept を登録するには、テーブルに `source` 列を足し、
   生成スクリプトのパーサを合わせて変更する必要がある。型（`ConceptSource`）は
   その日のために先に用意してあるが、**入口はまだ開いていない。**
5. **`npm run gen:concepts` を実行する。** 生成物を表と同時にコミットする。
6. **PR を出す。** Concept の追加で人が編集するのは `packages/domain/concepts.md` だけであり、
   `packages/domain/src/profile.ts` もこのドキュメントも変更不要
   （`ConceptId` が `string` であるため）。

既存の言語・領域への Concept 追加は上の手順で足りるが、**新しい言語や領域の
プレフィックスを足すとき**は表示と抽出側にも登録が要る。

- Web のツリー見出し: `apps/web/src/client/learning-map-view.tsx` の `languageLabel`
- 言語ではない領域を追加するとき: `apps/vscode-extension/src/ai/prompt/index.ts` の
  `CROSS_DOMAIN_PREFIXES`。登録しないとその領域の Concept がプロンプトの
  一覧に乗らず、拡張から観測されない。

`ConceptId` を literal union にしないのはこの手順のためである。union にすると
Concept を1つ足すたびに型ファイルが変更され、並行して動いている他の実装 PR と衝突する。

`packages/domain/src/concepts.generated.ts` を直接編集してはならない。次の生成で失われる。

---

## 習熟度の更新ルール

### 前提

**質問回数を習熟度の根拠として使わない。** 質問が多いことは、理解が浅いことも、
熱心に学んでいることも意味しうるため、単独では判別材料にならない。
同様に、質問が減ったことも「理解した」と「諦めて離脱した」を区別できない。

そのため `questionCount` は `MasteryEvidence` に記録するが、**`score` の計算には
用いない**。表示上の補助情報として扱う。

### status の判定

`status` は `evidence` から導出する。

| status       | 条件                                   |
| ------------ | -------------------------------------- |
| `unobserved` | その Concept のイベントが1件もない     |
| `confirmed`  | 下の2条件をどちらも満たす              |
| `learning`   | 上記以外（観測はあるが根拠が足りない） |

`confirmed` の条件:

1. `solvedIndependentlyCount + checkPassedCount >= 2`
2. `recentTypes` の直近5件に `error_recurred` と `check_failed` が含まれない

条件2を「累積の再発回数が0」にしてはならない。累積カウントは減らないため、
一度でも再発した Concept が二度と `confirmed` に戻れなくなる。
それは「同じエラーの再発減少を根拠にする」という方針と矛盾する。
再発したあとに自力解決を重ねれば回復できる形にする。

`recentTypes` はその Concept の直近 **5件** のイベント種別を古い順に保持し、
超えた分は先頭から捨てる。

`unobserved` のとき `score` は 0 とするが、これは「習熟度が低い」ではなく
「判断材料がない」を意味する。UI で 0% として表示してはならない。

### score の更新

イベント1件ごとに `score` を加減する。範囲は 0.0〜1.0 にクランプする。

| イベント               | score への影響 |
| ---------------------- | -------------- |
| `solved_independently` | +0.25          |
| `check_passed`         | +0.20          |
| `hint_used`            | +0.05          |
| `answer_viewed`        | 0              |
| `check_failed`         | −0.15          |
| `error_recurred`       | −0.20          |
| `question_asked`       | 0              |

`hint_used` をわずかに正とするのは、ヒントで前進した事実は完全な無情報ではないため。
`answer_viewed` を 0 とするのは、答えを見たこと自体は理解を示さないため。

クライアント（VS Code の globalState）では、`score` はイベントごとの加減算を
積み上げた**保存値**であり、`events` から再計算はしない。履歴は1000件で
切り詰められ、クランプ後の値から元の値も復元できないため、係数を変えても既存の
`score` は変わらず、以後のイベントから新しい係数が効く。

**この「再計算しない」規則はクライアントのローカルキャッシュに限った話である。**
API Server は全件のイベントログを持ち、切り詰めの前提が成立しないため、
習熟度をログから導出する。詳細は後述の「サーバー側の導出」を参照。

この係数は MVP 時点の暫定値である。デモで挙動を確認した上で調整してよいが、
**`question_asked` を正の値にする変更だけは行わない。** それはこのプロダクトが
否定している「AI を使った回数で理解度を測る」ことそのものになる。

### status と score を矛盾させない

加減したあと、`score` を status ごとの範囲へクランプする
（`packages/domain/src/profile.ts` の `MASTERY_SCORE_RANGE`）。

| status       | score の範囲 |
| ------------ | ------------ |
| `unobserved` | 0.0          |
| `learning`   | 0.0 〜 0.69  |
| `confirmed`  | 0.7 〜 1.0   |

順序は **status を先に判定し、そのあと score をクランプする**。
これを省くと「確認済み（45%）」のように status と score が食い違った表示になる。
score は status を補足する数値であり、status を上書きするものではない。

### サーバー側の導出

API Server は習熟度を**イベントログから導出する**。累積した保存値を持たない。
実装は `packages/domain/src/mastery.ts` の `deriveMasteryFromEvents`。

クライアントと異なる扱いにするのは、上の「再計算しない」規則が
globalState の1000件切り詰めを前提にしているためである。サーバーは全件のログを
正本として保持するので、その前提が成立しない。

さらに、オフラインキューを同期する以上、**発生時刻が過去のイベントが後から届くのが
正常系**である。累積した保存値では後着イベントを畳み込めず、`recentTypes` の
直近5件も壊れる。`docs/architecture.md` が「習熟度のルールはイベント到着順ではなく、
発生時刻と安定したタイブレーク規則を前提に設計する」と定めるのはこのためである。

導出の順序は **発生時刻の昇順、同時刻はイベント ID の昇順**とする。
ID によるタイブレークが無いと、同じイベント集合でも入力順で結果が変わり、
サーバーの導出結果を「正本」と呼べなくなる。

`occurredAt` はタイムゾーンオフセットや小数秒の桁数がクライアントごとに
異なりうるため、**文字列の辞書順で比較してはならない**。必ず時刻としてパースする。
解釈できない値は 0 や NaN へ丸めず例外にする。丸めると壊れた時刻のイベントが
黙って先頭に並び、汚染された習熟度が正常応答として返るためである。
そのため同期 API は、`occurredAt` がパースできないイベントを**受理前に拒否する**。

係数と判定条件はクライアントと共有する（`foldEventIntoMastery`）。二重に定義すると
クライアントとサーバーで習熟度の意味がずれる。

### クライアントとサーバーで結果が食い違う場合

イベントが発生順と異なる順に到着したとき、クライアント（到着順に加算）と
サーバー（発生時刻順に導出）の `score` は食い違う。**これは不具合ではない。**

`docs/architecture.md` の通りサーバーの導出結果が正本であり、クライアントは
同期後にサーバーの Profile を取り込んで差異を解消する。クライアントのローカル値は、
オフライン時と同期完了までの間に表示を止めないための楽観的なキャッシュである。

---

## 同じエラーの再発

`error_recurred` は、**一度解説したエラーが、時間窓の内に再び解説対象になったとき**に
記録する（診断/02 #76）。質問の回数が減っただけでは「理解した」と「未解決のまま離脱した」を
区別できないため、再発を習熟度を下げる根拠として観測する。

判定の実装は `apps/vscode-extension/src/learning/recurrence.ts`、
識別キーの生成は `apps/vscode-extension/src/context/diagnostics.ts` の `errorKeyOf`。

### 同じエラーの同一性

選択範囲に重なる Diagnostic ごとに、次の順で識別キーを作る。

| 条件          | キー                            | 例                          |
| ------------- | ------------------------------- | --------------------------- |
| `code` がある | `source` と `code` の組         | `code:ts:2345`              |
| `code` が無い | `source` と正規化した `message` | `message:go:missing return` |

- **`code` を優先する。** TypeScript の `TS2345` のように、`message` には変数名や
  型名が埋め込まれ、同じ種類の誤りでも出現ごとに文面が変わる。`code` ならそれに左右されない。
- **`source` を必ず含める。** `code` は発生元ごとの名前空間であり、TypeScript の番号と
  ESLint のルール名が衝突しうる。
- **`message` を正規化する。** 引用された部分（`'…'` `"…"` `` `…` ``）と数値を
  プレースホルダへ置き換え、空白をまとめる。
- **ファイル名と行番号は含めない。** 編集で動くため、同じ誤りを別物と判定してしまう。

サーバーへ同期する `LearningEvent.diagnosticCode` には、`code` 由来のキー
（`ts:2345` の形）だけを載せる。`message` 由来のキーは正規化しても利用者のコード片が
残りうるため、端末の中の判定にだけ使う。

ターミナル・クリップボード経由の質問は Diagnostic を持たないため、再発を判定しない。

### 再発とみなす時間窓

**14日**（`RECURRENCE_WINDOW_MS`）。最後に解説した時刻から14日以内に同じキーが
解説対象になったら再発とみなす。解説し直すたびに時刻は更新する。

- **無期限にしない。** 数ヶ月前に一度出したエラーが再発扱いになると、
  直近の理解を不当に下げる。`confirmed` の判定が直近5件だけを見る
  （累積の再発回数を見ない）のと同じ考え方で、再発も「最近の」事実に限る。
- **2週間にするのは、同じ題材に取り組み続ける期間を覆うため。** 学習者が1つの
  課題やスプリントに取り組む期間はおおむね1〜2週間で、その間に同じ誤りを繰り返すなら
  前回の解説は定着していない。これより短いと、週をまたいで同じ題材に戻ったときの
  再発を取りこぼす。
- **下限は設けない。** 解説を読んだ直後に同じエラーを選び直すのは、理解できずに
  もう一度聞いている状態であり、再発として扱ってよい。

この値は MVP 時点の暫定値である。係数と同じく、デモで挙動を確認したうえで調整してよい。

### 記録の仕方

- 再発した Concept は、**前回の解説で抽出した Concept と今回の Concept の和集合**にする。
  前回学んだはずの Concept が定着していなかったことが再発の意味であり、今回の抽出だけに
  頼ると、モデルがたまたま Concept を返さなかったときに再発が消える。
- Concept が1つも無い再発はイベントにしない。習熟度へ反映されないためで、
  出力チャンネルにだけ残す。
- 1回の選択に同じキーの Diagnostic が複数あっても、再発は1件にまとめる。
  別々のキーが再発した場合はキーごとに1件記録する。
- 判定・保存に失敗しても質問フローは止めない。回答はすでに表示済みであり、
  `recordEvent` と同じく失敗は出力チャンネルへ記録する。

---

## 保存

`ExtensionContext.globalState` に単一キーで保存する。

| 項目 | 値                            |
| ---- | ----------------------------- |
| キー | `gakushuSochi.learnerProfile` |
| 値   | `LearnerProfile`              |

再発判定のために解説済みのエラーを別キーに保存する（上の「同じエラーの再発」）。

| 項目 | 値                                                         |
| ---- | ---------------------------------------------------------- |
| キー | `gakushuSochi.explainedErrors`                             |
| 値   | 識別キー → `{ explainedAt: string, conceptIds: string[] }` |

時間窓を過ぎた記録は、次に保存するときに捨てる。壊れた値は使わずに空から始めるが、
出力チャンネルへ記録して黙って捨てない。失うのは再発判定の記憶だけで、
`LearnerProfile` は影響を受けない。

実装は旧キー `codeCompanion.learnerProfile` も読む。プロダクト名を変更する前に
保存された学習履歴は再取得できないため、キーの変更だけで読めなくする扱いにしない。
新しいキーが空のときに限り読み替え、次の保存で新しいキーへ移る。
旧キーの値は消さない（移行に失敗した場合の退避先として残す）。

Learner Profile はプロジェクトではなく人に紐づくため、`workspaceState` ではなく
`globalState` を使う。別端末との同期は API Server の `learning-events:sync` が担い、
`globalState` はサーバー導出の正本に対するローカルキャッシュである
（`docs/architecture.md`「オフラインと競合」）。

### 削除

`Gakushu Sochi: 学習データを削除する` は、この端末の学習データのコピーをすべて消す。
対象は `gakushuSochi.learnerProfile`・旧キー `codeCompanion.learnerProfile`・
`gakushuSochi.explainedErrors` の3キー。`gakushuSochi.clientId`（端末の識別子）と
`gakushuSochi.consent`（同意の記録）、`gakushuSochi.appliedHistoryResetAtMs`（同期状態）は
学習データではないため残す。
サーバー側の削除との順序と、他端末への追従は
[data-privacy.md](data-privacy.md)「クライアント側に残るコピー」を参照。

### 型を JSON serializable に保つ

globalState は値を JSON として直列化する。そのため `LearnerProfile` の型に
`Date` や `Map` や `Set` を含めない。日時は ISO 8601 の `string`、
コレクションは配列かプレーンオブジェクトで表現する。

この制約を守っている限り、後から「プロファイルを JSON ファイルへ書き出す」
コマンドを追加するのは値をそのまま出力するだけで済む。

### イベント履歴の上限

`events` は追記のみで増え続けるため、上限を **1000件** とし、
超えた分は古いものから捨てる。捨てる前に、そのイベントの寄与は
`mastery[].evidence` のカウントに積算済みであるため、習熟度は失われない。

---

## マイグレーション方針

`LearnerProfile.version` は `packages/domain/src/profile.ts` の `LEARNER_PROFILE_VERSION` に
現在値を持つ。MVP 時点では `1`。

### version を上げる場合・上げない場合

| 変更                                              | version                                |
| ------------------------------------------------- | -------------------------------------- |
| 省略可能フィールドの追加                          | **上げない**                           |
| `ConceptSourceKind` や `EventOrigin` への値の追加 | **上げない**                           |
| Concept 一覧への追加・削除                        | **上げない**（データ構造ではないため） |
| 必須フィールドの追加                              | 上げる                                 |
| フィールドの削除・改名                            | 上げる                                 |
| 既存フィールドの意味や単位の変更                  | 上げる                                 |

省略可能フィールドの追加で上げないのは、読み込み側が `undefined` を扱えるためである。
逆に、**既存データを読んだときに壊れる変更はすべて version を上げる。**

### 読み込み時の処理

```text
保存値なし              → createEmptyProfile() で新規作成する
version === 現在値      → そのまま使う
version < 現在値        → 順にマイグレーション関数を適用する
version > 現在値        → 新しい拡張が書いたデータ。破棄せず読み取りを諦め、
                          警告を出して読み取り専用として扱う
version が無い/不正     → 破損とみなし、新規作成する
```

**古いデータを黙って捨てない。** 学習履歴は再取得できないため、
マイグレーションできない場合も上書きせず、別キーへ退避してから新規作成する。

### マイグレーション関数の置き場所

`packages/domain/src/migrate.ts` に `migrateV1ToV2` のような形で version ごとに1関数ずつ置く。
1つの関数で複数バージョンをまたがない。連鎖適用で任意の古いバージョンから現在値へ上げる。

---

## 関連

- 型定義: `packages/domain/src/profile.ts`
- 習熟度の導出実装: `packages/domain/src/mastery.ts`
- Concept 一覧の正典: `packages/domain/concepts.md`
- Concept 一覧の生成物（編集しない）: `packages/domain/src/concepts.generated.ts`
- 生成スクリプト: `packages/domain/scripts/gen-concepts.mjs`
- 長期構想: `docs/idea.md`
