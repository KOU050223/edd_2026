# アーキテクチャ方針

この文書は、Gakushu Sochi を複数クライアントで Personal Learning Map を利用できる
プロダクトとして本番へ持っていくためのアーキテクチャ方針である。

実装詳細や特定のクラウド事業者の選定ではなく、何をどこに置き、どの順番で分離するかを
決めるための設計判断を扱う。

## 結論

複数クライアント、端末間同期、Pro を前提にするなら、初期構築からモノレポと独立した
API Server を採用する。API Server が担うのは次の責務である。

- ユーザー・端末の認証
- 学習イベントの正本の保存と、習熟度の導出
- 複数端末・複数クライアント間の同期
- 運営が提供する AI の実行、利用量制御、課金

ただし、すべての AI リクエストを API Server に通すものではない。
VS Code Language Model API、Local LLM、ユーザー自身の BYOK のような経路は、
ユーザーの契約・鍵・ローカル性を尊重してクライアントから直接呼べるようにする。

```text
VS Code Extension ─┐
Web App            ├── API Server ── Database
将来の CLI / 他IDE ─┘       │
                            ├── 認証・端末同期・課金
                            ├── 学習イベント・習熟度の正本
                            └── 運営提供 AI

VS Code Extension ── VS Code LM / Copilot  # ユーザー契約を直接利用
VS Code Extension ── Local LLM              # ローカル完結
```

この構成により、「どのクライアントでも同じ学習の軌跡を扱える」ことと、
「AIを使うほど運営コストやプライバシー負担が増える」ことを切り離せる。

## 背景と目標

Gakushu Sochi の中心的な資産は、単発のAI回答ではなく、ユーザーが何を理解し、
どこで再発し、何を自力解決できたかという Personal Learning Map である。

現時点の VS Code Extension は、最初の学習行動を観測し支援するコネクタである。
将来 Web、CLI、他IDE、教材連携を追加する場合、学習履歴を各クライアントに閉じ込めると、
同じユーザーの理解度を一貫して扱えない。

そのため、以下を満たすことを目標とする。

- クライアントが増えても、学習イベントと習熟度の意味がぶれない
- ユーザー持ち込みのAIと運営提供AIを併存できる
- コード・質問文などのセンシティブな内容を必要以上に保存しない
- ネットワーク不通でも VS Code での学習体験を止めない
- Free / Pro の境界をAIトークン消費だけに依存させない

## コンポーネントと責務

### Client connectors

VS Code Extension、Desktop App、Web App、将来のCLIや他IDE連携を指す。

- 各環境からコード文脈・診断・ユーザー操作を収集する
- 回答を表示し、Hint → 自力解決 → Answer の対話を成立させる
- 学習イベントを生成し、送信できないものはローカルキューに残す
- ユーザー持ち込みAIを使う場合は、各クライアントから直接呼ぶ

クライアントは表示や環境固有の取得を担当する。習熟度の最終計算や、
ほかの端末と共有する履歴の正本を持たない。ローカル保存は、オフライン時の操作を保つための
キャッシュおよび送信キューであり、サーバーと並ぶ正本ではない。

### Web App と API Server の境界

Web App は React による画面と、ブラウザからの認証要求を受け付ける Web Worker で構成する。
React は学習プロフィールを表示し、Web Worker はブラウザに API の資格情報を渡さずに
`apps/api` へ要求を中継する。ブラウザには HttpOnly のセッション Cookie だけを渡し、
API 用の Access Token やサービス用トークンを保存させない。

以下は認証方式を Auth0 に統一した後の責務である。移行は完了しており、開発用の
共有トークンを使う経路は残っていない（docs/auth.md §7、Auth/06）。

Web Worker は次の処理を担当する。

- Auth0 のログイン開始とコールバック処理
- HttpOnly・Secure・SameSite Cookie による Web セッションの発行と失効
- セッションに対応する Auth0 Access Token の取得と更新
- 認証済み要求への Access Token 付与
- `/api/*` の同一オリジン中継

API Server は次の処理を担当する。

- Auth0 JWT の署名・発行者・Audience の検証
- JWT の Subject に基づくユーザー特定
- 学習イベント、Learner Profile、Concept Mastery の処理
- API の認可、レート制限、データ永続化

Web Worker は API の認証方式を独自に持たず、取得した Access Token を付与するだけである。
JWT の検証と認可は API Server が行う。

この構成では、ブラウザは API Server と直接通信しない。そのため、Web 用の CORS 設定を
必要とせず、API の資格情報をブラウザへ公開せずに済む。Web Worker を削除してブラウザから
API Server を直接呼ぶ構成へ移行する場合は、Auth0 の SPA 認証、トークンの保持、CORS、
本番 API URL の設定を別途設計してから変更する。

### API Server

複数クライアントから利用する、プロダクトのバックエンド境界である。
実装基盤は Hono を使う Cloudflare Workers とする。

- 認証されたユーザーと端末を識別する
- 学習イベントを冪等に受け付け、永続化する
- `LearningEvent` から `ConceptMastery` を導出する
- 現在の Profile と必要な履歴要約を返す
- 運営提供AIを使う場合に限り、モデル呼び出し・利用上限・課金を管理する

API Server は VS Code API や UI の型に依存しない。HTTP API の契約だけを通じて
クライアントと接続する。

WorkerのBindings型は `wrangler types` で生成し、手書きしない。Worker設定を変更したら
`npm run gen:worker-types --workspace=@gakushu-sochi/api` を実行する。

### Database

サーバー側の正本を保存する。

- user
- device / session
- learning event
- concept mastery のスナップショットまたは導出結果
- 監査ログ（誰がいつデータを取り出し・消したか。[`docs/api-ops.md`](api-ops.md)）
- 課金・運営提供AIの利用記録（導入時）

Concept 定義自体は、初期段階ではリポジトリでバージョン管理する。
実行時に外部ロードマップへ依存しないという `docs/concepts.md` の方針は維持する。

### AI providers

AIは単一のバックエンド実装ではなく、同じ `AIRequest` / `AIResponse` 契約を実装する
複数の経路として扱う。

| 経路                 | 呼び出し元          | 主な用途                          | 秘密情報・コスト                   |
| -------------------- | ------------------- | --------------------------------- | ---------------------------------- |
| VS Code LM / Copilot | VS Code Extension   | ユーザーが持つCopilot契約を利用   | ユーザー契約。運営は鍵を保持しない |
| Local LLM            | Client              | オフラインまたはローカル完結      | ユーザー端末                       |
| BYOK                 | Client を原則とする | ユーザー指定のAIを使う            | ユーザーの鍵を運営へ保存しない     |
| Managed AI           | API Server          | Pro機能、統一された品質・利用制御 | 運営の鍵・コスト                   |

Managed AI を導入しても、他の経路を置き換えない。回答時には使用した provider と model を
記録できるようにし、回答の根拠と運営コストを追跡可能にする。

## ドメインの正本

`Concept`、`LearningEvent`、`ConceptMastery`、習熟度の更新規則はクライアントごとに
複製しない。共有ドメインパッケージに置き、同じバージョンを使う。

特に、クライアントから `ConceptMastery` を保存要求として送ってはならない。
クライアントが送るのは観測した事実である `LearningEvent` とし、API Server がイベントを
追記したうえで習熟度を導出する。

```text
Client が観測する事実
  question_asked / hint_used / solved_independently / check_passed ...
                         │
                         ▼
               API Server が追記・検証
                         │
                         ▼
       共通のルールで ConceptMastery を導出
                         │
                         ▼
              全クライアントが同じ Profile を読む
```

この原則は、クライアントごとの表示差を防ぐだけでなく、将来の同期・分析・不正対策の
基礎にもなる。

## API の最適な境界

初期から本番を見据えた API Server を置く。ただし、データベースの CRUD をそのまま公開する
巨大なBFFや、汎用GraphQLを先行して作る必要はない。

最初から固定すべきなのは、画面ではなく学習ドメインに由来する境界である。

| 境界           | API                                                                                                                             | 責務                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Identity       | OAuth / OIDC                                                                                                                    | ログイン、トークン発行、VS Codeの端末認可                                                    |
| Sync Command   | `POST /v1/learning-events:sync`                                                                                                 | 追記型イベントをまとめて冪等に同期する                                                       |
| Learning Query | `GET /v1/learning-profile` / `GET /v1/learning-activity`                                                                        | 導出済みのLearning Mapと根拠、日次の集計を返す                                               |
| Learner Data   | `GET/PUT /v1/mastery-overrides` / `GET/PUT /v1/user-settings`                                                                   | 習熟度の手動上書きとユーザー設定（利用者自身の宣言であり行動記録ではない）                   |
| AI Gateway     | `POST /v1/ai/responses` / `GET /v1/ai/usage`                                                                                    | Managed AI の実行・利用制限・課金と、残量の提示を扱う                                        |
| Check Content  | `POST /v1/checks:generate`                                                                                                      | 確認問題（2問1組）を Concept の定義から生成する                                              |
| Conversations  | `PUT /v1/conversations/:id` / `GET /v1/conversations(/:id)` / `DELETE /v1/conversations(/:id)` / `GET /v1/conversations:export` | 質問履歴の本文。オプトイン時のみ保存（[`conversation-history.md`](conversation-history.md)） |
| Data Rights    | `GET /v1/learning-events:export` / `DELETE /v1/learning-events` / `DELETE /v1/me`                                               | 自分の学習データを取り出す／消す／退会（[`data-privacy.md`](data-privacy.md)）               |

端末をユーザーへ結びつける処理は Identity の責務であり、独立した `/devices` という
学習ドメインAPIにしない。VS Code は OAuth Device Authorization Flow など、
ブラウザを前提にしない端末認可フローを使う。

`learning-events:sync` は「イベントを一件作る」CRUD APIではなく、オフラインキューを
同期するためのプロトコルである。リクエストにはクライアント側で生成した event ID、
client ID、発生時刻、origin を含める。API Server は event ID を一意に扱い、通信の
リトライで同じイベントが二重記録されないようにする。応答ではイベントごとの受理・重複・
拒否を返す。

`learning-profile` はイベントの生ログではなく、画面表示に必要な導出済みの読み取りモデルを
返す。クライアントはイベント送信後に楽観的に表示してよいが、同期完了後はサーバーが導出した
Profile を正本として取り込む。

BFF は禁止しない。Webのダッシュボードなど、特定の画面が安定し、複数のドメインデータを
一括取得する明確な要求が生まれた時点で、`GET /v1/dashboard` のような薄い読み取りAPIを
追加する。GraphQLも、複数の成熟したクライアントが柔軟な関連データ取得を必要とする段階で
評価する。いずれも、上記のドメイン境界を置き換えるものではない。

## オフラインと競合

VS Code の質問体験をネットワーク必須にしない。

1. クライアントはイベントをローカルに永続キューイングする
2. 接続可能時に API へ送信する
3. API は event ID により冪等に受け付ける
4. 同期後の Profile はサーバーの導出結果を正本として受け取る

イベントは原則追記のみであるため、一般的な「同じレコードを両端で編集する」競合より
扱いやすい。時刻の順序が入れ替わる可能性はあるため、習熟度のルールはイベント到着順ではなく、
発生時刻と安定したタイブレーク規則を前提に設計する。

なお、この節が描く「ローカルの永続キューから接続可能時に送信する」実装は
**まだ存在しない**。現行の送信挙動と再送の方針は
[`docs/api-ops.md`](api-ops.md)を参照。

## リポジトリ構成

複数のデプロイ可能なアプリケーションと共有契約を前提に、初期構築からモノレポにする。

```text
apps/
  vscode-extension/     # VS Code固有のUI・コンテキスト収集・ローカルキュー
  desktop/              # OS常駐で選択テキストを質問するElectronアプリ
  api/                  # 認証、同期、Managed AI、課金の境界
  web/                  # Learning Map と設定。必要になった時点で追加
packages/
  domain/               # Concept、Event、Mastery、更新・検証ロジック
docs/
```

`packages/domain` には VS Code、HTTP、データベース、特定AI SDKを import しない。
APIの外部契約は `apps/api` に置き、複数クライアントで実際に重複が生じた時点で初めて
専用パッケージへ抽出する。`packages/domain` を先に抜き出すことで、API・Web・Extension の
実装を別々に進めても Learning Event と習熟度の意味が崩れにくい。

モノレポはデプロイのためだけに導入するものではない。共有ドメインと共有契約を一つの変更として
レビュー・テストできることが主な価値である。

## 段階的な移行

### Phase 0: プラットフォームの土台

- 現在の Extension を `apps/vscode-extension` へ移す
- イベント検証と習熟度導出を `packages/domain` へ抽出し、テストする
- `apps/api` に認証、Database、イベント同期、Profile取得を実装・デプロイする
- Extension にローカルキューとバックグラウンド同期を実装する

この時点で Database を Learning Map の正本にする。`globalState` はオフラインキャッシュとして
保持する。移動だけのPRと意味の変更を混ぜず、既存のビルド・テストが維持される状態で移す。

### Phase 1: 最初の学習ループを完成させる

- `question_asked`、`hint_used`、`solved_independently` などを正確に記録する
- 同期済みProfileを VS Code で表示する
- Web にログインと読み取り専用の Learning Map を置く
- 失敗を理由別にユーザーへ表示し、詳細をログへ残す

AIをAPI経由にしないことで、同期基盤の障害が質問体験を止めないようにする。

### Phase 2: Managed AI と Pro

- 運営提供AIの provider を API Server に追加する
- 認証済みユーザーの利用量、レート制限、課金状態を検証する
- 過去のイベントを要約して、個別化した回答を返す

長期履歴をAIへそのまま渡さない。現在の質問に関係するConceptと、再発状況などの
最小限の `ProfileSummary` を作る方針を維持する。

## 本番化前に明確化する事項

- 認証方式と、VS Code の端末ログインフロー
- ~~Free / Pro の機能境界と、Managed AI の利用上限~~ → [`docs/ai-limits.md`](ai-limits.md) で決定済み（上限の実装も #89 で完了）
- ~~保存期間、データ削除、エクスポート、退会後の扱い~~ → [`docs/data-privacy.md`](data-privacy.md)「保存期間と削除」で決定済み
  （API は #79、クライアント側のコピーの削除は #124、Web の操作画面は #173 で実装）
- ~~コード・質問本文を送信／保存する際の同意UI~~ → [`docs/data-privacy.md`](data-privacy.md)「同意を取るまで送らない」で決定済み。
  VS Code は #119、Desktop / Web は #174 で実装
- ~~APIの監視、監査ログ、レート制限、障害時の再送方針~~ → [`docs/api-ops.md`](api-ops.md) で決定済み
  （監査ログの記録は #122 で実装。レート制限の上限値と検証は #88 / #89 が持つ）
- Marketplace 公開の条件: 生成 AI と対話していることの明示と、フィードバック手段
  （GitHub Copilot Extension Developer Policy の要求。詳細は [`docs/lm-api.md`](lm-api.md)）
- 他拡張・VS Code 本体が登録した BYOK モデルを `selectChatModels()` から選べるかの実機確認
  （選べない場合、既定 provider の第3候補が機能せず #55 の BYOK provider 実装が必要になる）

## 現実装への示唆

現行の `AIProvider` と `AIRequest` / `AIResponse` の分離は、この構成の出発点として
維持する。VS Code の型を共有ドメインへ持ち込まない原則も変えない。

`VSCodeLMProvider.ask()` は `selectChatModels()` を含む失敗を `AIResponse` として返す。
呼び出し側は `AIErrorReason` でユーザー通知を分岐し、詳細はログへ残す。これにより
`AIProvider.ask()` の契約と、プロジェクトの「エラーを握りつぶさない」方針を両立する。

### 既定 provider（調査/03 #121）

`vscode.lm` の利用規約と、Copilot 未契約ユーザーに対する既定 provider は確定した
（確認日・一次情報 URL・却下した案は [`docs/lm-api.md`](lm-api.md)）。

`selectChatModels()` を vendor で絞らず、次の優先順位で 1 つ選ぶ。

1. Copilot の `gpt-4o-mini`
2. Copilot のその他のモデル
3. Copilot 以外の vendor のモデル（利用者が VS Code へ登録した BYOK・ローカルモデル）

Copilot を最優先にするのは、運営が AI 利用料を負担しない構成の要だから。
3 があることで、**Copilot 未契約でも BYOK が登録されていれば拡張が使える。**

### 拡張自身が持つ BYOK 経路（AI/04 #55）

上の既定 provider とは別に、拡張が `vscode.lm` を通さず AI 提供元を直接呼ぶ
`BYOKProvider` を `apps/vscode-extension/src/ai/byok.ts` に持つ。
対象は Anthropic Messages API と OpenAI Chat Completions API（互換エンドポイントを含む）。

利用者は `gakushuSochi.ai.provider` で `vscode-lm` / `byok` を切り替える。
API キーは `Gakushu Sochi: BYOK の API キーを設定する` コマンドから SecretStorage へ
保存し、設定ファイルにも運営側サーバーにも載せない。送信先を左右する設定
（`ai.provider`、`byok.vendor`、`byok.model`、`byok.baseUrl`）はすべて
`scope: "machine"` で、ワークスペースからは上書きできない（RULE-006）。

`vscode.lm` 経路で 1 件もモデルが無いときは `model-unavailable` を返し、`detail` に
Copilot へのサインインと BYOK 登録の手順を載せる。失敗は失敗のまま返しつつ、
利用者を行き止まりに置かない。
選択方針の実装は `apps/vscode-extension/src/ai/model-selection.ts`。

## 関連文書

- 長期プロダクト構想: [`docs/idea.md`](idea.md)
- Concept・学習イベント・習熟度の契約: [`docs/concepts.md`](concepts.md)
- 保存期間・削除・送信範囲・同意: [`docs/data-privacy.md`](data-privacy.md)
- API の監視・監査ログ・再送方針: [`docs/api-ops.md`](api-ops.md)
- Free / Pro の境界と Managed AI の利用上限: [`docs/ai-limits.md`](ai-limits.md)
