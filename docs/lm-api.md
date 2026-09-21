# VS Code Language Model API の検証（調査/01, #4）

AIコスト戦略は「ユーザー自身のCopilot契約を使う `vscode.lm` API」を第一優先とする前提で組まれている。ここが成立しない場合はProvider優先順位と収益構造ごと見直しになるため、実装（#11 VSCodeLMProvider）に入る前にこの前提を検証した記録。

実装の詳細ではなく、**何を確かめて何が確かめられなかったか**を残すための文書。

---

## 検証環境

- `@types/vscode`: 1.136.0（`package.json` の `engines.vscode` は `^1.90.0`）
- 検証コード: `experiment/issue-4-lm-api` ブランチの使い捨てコマンド `gakushuSochi.debugLmProbe`（mainにはマージしない）

---

## 検証結果

| #   | 項目                                 | 結果                                                                                                                                    |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 応答が実際に返るか                   | **確認できた。** `vscode.lm.selectChatModels()` で取得したモデルに `sendRequest` で送信し、応答テキストを取得できた                     |
| 2   | Copilot契約が必要か                  | **不要にできる（2026-09-21）。** `vscode.lm` 越しに Copilot 以外の vendor も選べる。下記「Copilot 未契約者の既定 provider」を参照       |
| 3   | 同意フロー・拒否時の挙動             | **同意時のみ確認、拒否時は未確認。** 一度同意すると、拡張機能ホストをリロードしても同意状態が保持され、同意ダイアログを再現できなかった |
| 4   | レート制限到達時のエラー             | **未確認。** 3と同じ理由で、意図的にエラーを起こす状態を再現できていない                                                                |
| 5   | 利用可能なモデルファミリーの取得方法 | **確認できた。** `vscode.lm.selectChatModels()` で取得する（詳細は下記）                                                                |
| 6   | 利用規約上この用途が許容されるか     | **確認できた（2026-09-21）。** 条件付きで許容される。下記「利用規約の確認」を参照                                                       |
| 7   | Copilot未契約ユーザーの見積もり      | 未確認。チームでの判断材料が必要                                                                                                        |

### 5. `selectChatModels()` の実機結果

検証環境（Copilot契約あり）で `vscode.lm.selectChatModels()` を引数なしで呼ぶと、6件返った。

| vendor     | family                         | id                             | maxInputTokens |
| ---------- | ------------------------------ | ------------------------------ | -------------- |
| copilotcli | （空）                         | auto                           | 0              |
| copilot    | gpt-4o-mini                    | gpt-4o-mini                    | 12078          |
| copilot    | claude-fable-5.1               | auto                           | 935793         |
| copilot    | copilot-utility-small          | copilot-utility-small          | 12078          |
| copilot    | copilot-utility                | copilot-utility                | 271790         |
| copilot    | copilot-dictation-cleanup-luna | copilot-dictation-cleanup-luna | 921793         |

**学び**: 一覧にはチャット用途ではないモデル（`copilotcli/auto`、`copilot-utility*`、`copilot-dictation-cleanup-luna` など）が混ざる。先頭（`models[0]`）を無条件に使うと、`maxInputTokens=0` の `copilotcli/auto` に送ってしまい応答が空になった（実際に発生した）。`family` を指定する、または `maxInputTokens > 0` 等でフィルタする必要がある。

---

## 利用規約の確認（2026-09-21）

⑥として残っていた項目。**一次情報を読んで判断した記録であり、法務レビューではない。**

### 参照した一次情報

| 文書                                                    | URL                                                                                           | 確認日     | 文書側の更新日 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------- | -------------- |
| Language Model API（VS Code 拡張 API ガイド）           | https://code.visualstudio.com/api/extension-guides/ai/language-model                          | 2026-09-21 | 記載なし       |
| GitHub Copilot Extension Developer Policy               | https://docs.github.com/en/site-policy/github-terms/github-copilot-extension-developer-policy | 2026-09-21 | 2025-10-20     |
| AI language models in VS Code（利用者向けドキュメント） | https://code.visualstudio.com/docs/agent-customization/language-models                        | 2026-09-21 | 記載なし       |
| Use your own language model key in VS Code（ブログ）    | https://code.visualstudio.com/blogs/2026/06/18/byok-vscode                                    | 2026-09-21 | 2026-06-18     |

### 読み取った内容

1. **拡張から Copilot のモデルを使うこと自体は想定された用途である。**
   Language Model API ガイドは "you can now directly access and take advantage of large language
   models ... contributed by GitHub Copilot in your own extensions" と述べている。

2. **ただし Marketplace へ公開した時点で、Copilot の利用ポリシーに従う扱いになる。**
   同ガイドいわく "By publishing to the VS Marketplace, your extension is adhering to the
   GitHub Copilot extensibility acceptable development and use policy."
   公開前に Developer Policy を満たしておく必要がある。

3. **同意は API が強制する。** "Copilot's language models require consent from the user before
   an extension can use them. Consent is implemented as an authentication dialog."
   また `selectChatModels` は利用者の操作（コマンド実行など）を起点に呼ぶこととされている。
   現行実装はコマンド → Chat Participant の流れで呼んでおり、この条件を満たす。

4. **Developer Policy が本プロダクトに課す義務**（2025-10-20 版から関係するもの）:
   - 生成 AI と対話していることを利用者へ伝える。用途・限界も示す。
   - 誤りや不適切な出力を報告する手段を用意する。
   - 個人データを同意なく収集・保存・利用しない。第三者へ売却・共有しない。
   - 未公開 API を使わない。アクセス制御を迂回しない。

5. **レート制限は拡張側の責任。** "Extensions should responsibly use the language model and be
   aware of rate limiting." 統合テストで LM API を呼ぶことは明確に非推奨とされている
   （本リポジトリのテストは `vscode.lm` をモックしており、実際には呼んでいない）。

### 本プロダクトへの影響

| Developer Policy の要求     | 現状                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| AI との対話であることの明示 | **未了。** Chat の応答に AI 生成である旨の表示が無い。公開前に対応が必要（別 Issue 化を推奨） |
| 用途・限界の明示            | 部分的。README にはあるが拡張内の導線には無い                                                 |
| フィードバック手段          | **未了。** 公開前に必要                                                                       |
| 個人データの扱い            | 対応済み。`docs/architecture.md`「何が誰へ送られるか」と同意フロー（#119）が担保する          |
| 未公開 API の不使用         | 対応済み。`vscode.lm` の公開 API のみを使う                                                   |

**結論**: 規約上この用途は禁じられていない。ただし **Marketplace 公開の前に**
「AI 生成であることの明示」と「フィードバック手段」を満たす必要がある。
今回のスコープ（既定 provider の決定）では実装せず、ここに残して公開前の条件とする。

---

## Copilot 未契約者の既定 provider（2026-09-21）

②と⑦として残っていた項目のうち、②に答えを出す。

### 前提となる事実

VS Code の BYOK（Bring Your Own Key）は **Copilot の契約なしで使える**。
利用者向けドキュメントは "BYOK models work without signing into a GitHub account and without
a Copilot plan." と明記している。課金は provider から利用者へ直接行われ、Copilot の
リクエスト枠を消費しない。対応 provider は Azure / Anthropic / Gemini / OpenAI / OpenRouter、
および Ollama などのローカルモデル。

**注意**: 2025-10-22 のブログ（https://code.visualstudio.com/blogs/2025/10/22/bring-your-own-key）は
"currently available to users on individual GitHub Copilot plans" と書いており、これと矛盾する。
VS Code 1.122（2026-05）で GitHub サインイン要件が外れたため、**古いほうの記述は現状に当てはまらない**
と判断した。判断の根拠は上記の利用者向けドキュメントと 2026-06-18 のブログ。

### 決定

**既定 provider は「VS Code に登録済みのモデルのうち、使えるものを自動で選ぶ」とする。**
新しい provider 実装は追加しない。`vscode.lm` の selector を広げるだけで達成する。

優先順位（`apps/vscode-extension/src/ai/model-selection.ts` の `selectModel()`）:

1. Copilot の `gpt-4o-mini`
2. Copilot のその他のモデル
3. Copilot 以外の vendor のモデル（利用者が登録した BYOK / ローカルモデル）

Copilot を先頭に置くのは、運営が AI 利用料を負担しない構成の要だから。
3 を足したことで、**Copilot 未契約でも BYOK さえ登録されていれば拡張が使える。**

### 却下した案

| 案                                     | 却下の理由                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| BYOK（#55）を既定にする                | #55 は未実装。独自の HTTP provider とキー管理 UI を作る必要があり、このIssueのスコープを超える。VS Code 本体の BYOK を使えば同じ効果が今すぐ得られる |
| Managed AI（運営の Gemini 経由）を既定 | Phase 2 で未実装。上限設計（設計/03）も未了。運営がコストを負う構成であり、既定にするのは判断が早い                                                  |
| 何も既定にせず起動時に選ばせる         | 利用者の大半は Copilot か BYOK のどちらかしか持たない。選べる状態が 1 つしかないのに選択を強いることになる                                           |

### 未解決のまま残すこと

- **他拡張が登録した BYOK モデルを `selectChatModels()` から選べるかは、一次情報で確認できなかった。**
  Language Model Chat Provider API のガイドは、登録側の書き方しか説明しておらず、
  他拡張から見えるかどうかに触れていない。VS Code 本体の BYOK（「Manage Models...」で登録するもの）に
  ついても同様。**実機での確認が要る。** 見えない場合、3 の経路は機能せず、#55 の BYOK provider 実装が
  改めて必要になる。
- ⑦（Copilot 未契約ユーザーの割合）は引き続き未着手。

### 同意の取り直し（レビュー指摘 P1）

送信先が Copilot だけでなくなるため、**同意の文面と版を変えないと、Copilot への送信にだけ
同意した利用者のコードが、本人の知らないうちに Anthropic / OpenAI などへ出る。**

`CONSENT_NOTICE_DETAIL` に「送信先は VS Code の設定で決まる」ことと具体的な提供元名を書き、
`CONSENT_NOTICE_VERSION` を 2 → 3 へ上げた。既存の同意は無効になり、次回の質問時に
新しい文面で取り直される（`isConsentGranted` が版の一致を見る）。

### VS Code の版による案内の出し分け（レビュー指摘 P2）

`engines.vscode` は `^1.90.0` であり、**案内を出す相手が 1.122 以降とは限らない。**
1.122 より前のホストで「Copilot の契約は要りません」と案内すると、利用者はその経路を
試して空振りする。`buildNoModelGuidance()` が `vscode.version` を見て書き分け、
古いホストには「BYOK にもサインインが要る」ことと更新の案内を出す。
読めない版は古い側に倒す（使えない経路を勧めるより安全なため）。

### チャット用途でない family の除外（レビュー指摘 P2）

`copilot-utility`（271790）や `copilot-dictation-cleanup-luna`（921793）は
**`maxInputTokens` が十分にあるためトークン数では弾けない。** family の名前で除外する。
弾かないと、Copilot にこれらしか無い利用者が BYOK へ落ちられず、用途外のモデルへ送って
空の応答を受け取る。

### モデルが 1 つも無いときの案内

`selectModel()` が `undefined` を返したとき、`AIResponse` は
`{ ok: false, error: { reason: "model-unavailable", detail: NO_MODEL_GUIDANCE } }` を返す。
`detail` には Copilot へのサインインと BYOK の登録という、**使える経路への具体的な手順**が入る。
`extension.ts` の Chat Participant はこれをそのまま利用者へ表示し、出力チャンネルにも記録する。

失敗を成功に化けさせず（RULE-004）、かつ利用者を行き止まりに置かないための形である。

---

## Fallbackが必要になる条件

型定義（`vscode.LanguageModelError` のJSDoc）から言語化できる範囲。3・4が実機で再現できなかったため、**この節は仕様書からの推測を含む。実機での裏付けが取れ次第更新する。**

| 状況                      | 判定方法                                                                                     | `AIErrorReason`（`apps/vscode-extension/src/ai/types.ts`） |
| ------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| モデルが1件も取得できない | `selectChatModels()` が空配列                                                                | `model-unavailable`                                        |
| 同意が得られない          | `sendRequest` が `LanguageModelError`、`code === LanguageModelError.NoPermissions(...).code` | `consent-denied`                                           |
| レート制限・利用上限      | `sendRequest` が `LanguageModelError`、`code === LanguageModelError.Blocked(...).code`       | `rate-limited`                                             |
| モデルが消失した          | `sendRequest` が `LanguageModelError`、`code === LanguageModelError.NotFound(...).code`      | `unknown`（現行の `AIErrorReason` に該当項目なし）         |
| その他                    | `LanguageModelError` 以外、または `code` が上記以外                                          | `unknown`                                                  |

`AIRequest` / `AIResponse` の型自体（#10で確定済み）は、この検証結果と矛盾しない。`AIErrorReason` に `NotFound` 相当の項目を足すかは #11 実装時に判断する。

---

## 未確認のまま残った項目

- **②Copilot契約なし**: 未契約アカウントでの動作は未検証。#11実装時点でも確証がないまま `model-unavailable` の案内文言を用意することになる
- **③同意拒否・④レート制限**: 同意状態が拡張機能ホストのリロードをまたいで保持され、この環境では再現できなかった。別マシン／別アカウント、または同意状態をリセットする方法が分かれば再検証する
- **⑥利用規約・⑦未契約ユーザーの割合**: 未着手。チームでの判断が必要

---

## 判断の記録

| 日付       | 判断                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-05 | ①応答取得・⑤モデル一覧取得は実機で確認できたため、AI/01のinterface設計（#10、マージ済み）は踏襲してよいと判断                                                                |
| 2026-09-05 | ②③④⑥⑦は未確認のまま#11（VSCodeLMProvider実装）に進む。同意拒否・レート制限のハンドリングは型定義上の仕様に基づいて実装し、実機での裏付けは別途行う                           |
| 2026-09-21 | ⑥利用規約: 一次情報を確認し、条件付きで許容されると判断。Marketplace 公開前に「AI 生成であることの明示」と「フィードバック手段」が要る（調査/03 #121）                       |
| 2026-09-21 | ②既定 provider: 新 provider を作らず、`selectChatModels()` の selector を全 vendor へ広げて BYOK へ落ちられるようにする。Copilot は引き続き最優先（調査/03 #121）            |
| 2026-09-21 | 他拡張・VS Code 本体が登録した BYOK モデルが `selectChatModels()` から見えるかは一次情報で確認できず、実機確認を残した。見えない場合は #55 の BYOK provider 実装が必要になる |
| 2026-09-21 | 送信先が Copilot 以外へ広がるため、同意の文面へ提供元を明記し `CONSENT_NOTICE_VERSION` を 2 → 3 へ上げて取り直す（PR#137 レビュー P1）                                       |
| 2026-09-21 | 案内は `vscode.version` で書き分ける。`engines.vscode` が `^1.90.0` のため、1.122 未満のホストへ「Copilot 不要」と案内すると空振りする（PR#137 レビュー P2）                 |
