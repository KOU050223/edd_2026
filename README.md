# Gakushu Sochi

選択したコードやDiagnosticsをもとに、VS Code内で学習向けのヒントを返す拡張機能です。Hackathonでは、AIがコードを完成させるのではなく、理解度に合わせて「次に試す一手」を返す体験を検証します。

## 識別子

| 項目              | 値                                             |
| ----------------- | ---------------------------------------------- |
| package name      | `gakushu-sochi`                                |
| Extension ID      | `<publisher>.gakushu-sochi`（publisher未決定） |
| Command ID prefix | `gakushuSochi.`                                |
| Chat Participant  | `@gakushu-sochi`                               |
| publisher         | 未決定                                         |

## Hackathon MVP

```text
コードを選択
  → Hint / Explain を選ぶ
  → 選択範囲・周辺コード・DiagnosticsをAIへ渡す
  → 次の一手とヒントを表示する
  → 学習イベントと解決結果を端末の送信キューへ記録し、APIへ同期する
```

習熟度は API Server が学習イベントから導出する正本であり、クライアントは確定・保存しない。

対象外: WebviewによるリッチUI、完全なPersonal Learning Map。

## ファイル構成

複数クライアントで同じ Personal Learning Map を扱うため、モノレポで管理する。

```text
.
├─ apps/
│  ├─ vscode-extension/         # VS Code固有のUI・コンテキスト収集・ローカルキュー
│  ├─ desktop/                  # OS常駐で選択テキストを質問するElectronアプリ
│  ├─ api/                      # 認証、同期、Managed AIを担うAPI Server
│  └─ web/                      # Learning Mapと設定のWeb App
├─ packages/
│  ├─ domain/                   # Concept、LearningEvent、Masteryの共有ドメイン
├─ docs/                        # 人間が読む正史（設計・方針）
│  ├─ idea.md                   # プロダクトの長期構想
│  ├─ concepts.md               # Concept一覧・習熟度ルール・マイグレーション方針
│  ├─ testing.md                # デモケースと手動テスト手順
│  ├─ testing-guide.md          # 自動テストの方針と書き方
│  └─ guardrails.md             # PRレビューからルールを育てる仕組みの方針
├─ .agents/                     # エージェントが毎回読むもの
│  ├─ rules/                    # プロジェクト固有ルールの正典と却下記録
│  └─ skills/                   # スキル定義（.claude/ からリンク）
├─ scripts/                     # リポジトリ横断の運用スクリプト
├─ test/                        # 構成そのものを検査するメタテスト
├─ package.json                  # npm workspacesの入口
└─ README.md
```

### 責務の境界

- `packages/domain` は他モジュールに依存しないドメイン契約と習熟度規則を置く。VS Code APIをimportしない。
- `apps/vscode-extension` はVS Code / LSPの生データを構造化し、表示と入力を担当する。
- `apps/desktop` はOS常駐（macOSのメニューバー / Windowsのタスクトレイ）から、任意のアプリで選択した
  テキストを受け取り、表示と入力を担当する。エディタに閉じない場面をカバーする。
  APIトークンはOSのキーチェーンへ預け、本文・質問は永続化しない。
- `apps/api` は学習イベントの正本、習熟度導出、認証、同期を担当する。

`AIProvider` interface は `apps/vscode-extension/src/ai/` に置く。`AIRequest` / `AIResponse` は
`packages/domain` の VS Code 非依存な契約として共有し、Managed AI は API の HTTP 境界でこれを変換する。

`AIProvider.ask` は失敗しても例外を投げず、`AIResponse` の値として理由を返す。呼び出し側が `AIErrorReason` で案内を出し分けられるようにするため。ストリーミングは `askStream` を任意メソッドとして空けてあり、実装するかどうかは 調査/01 (#4) の結果で決める。

Learner Profile / Concept / 学習イベントの型は `packages/domain/src/profile.ts` に集約する。命名規則・Concept追加手順・習熟度の更新ルール・スキーマのマイグレーション方針は `docs/concepts.md` が正典とする。

Concept一覧そのものは `packages/domain/concepts.md` を正典とし、生成物 `packages/domain/src/concepts.generated.ts` の隣に置く。表を編集したら `npm run gen:concepts` を実行する。

## 開発

### 環境を用意する

Node は `.node-version` の 24.20.0 を使う。Nix があれば devShell が同じ版を配る。

```bash
nix develop      # Node / task / lefthook が揃った shell に入る
task setup       # 依存のインストール・.dev.vars の生成・git hook の導入
task dev         # API Server / Desktop / Web App をまとめて起動する
```

`direnv allow` しておけば、ディレクトリに入るだけで `nix develop` 相当になる。

Nix を使わない場合は、Node 24.20.0 と [Task](https://taskfile.dev) を各自で入れれば
`task` 以降は同じ。Task も使わないなら、下の npm コマンドが従来どおり動く。

```bash
npm install
npm run compile
npm run check:concepts   # Concept一覧と生成物が一致しているか検査する
npm run dev              # API Server / Desktop / Web App をまとめて起動する
```

### タスク

`task --list` が一覧を出す。Taskfile は入口だけを定義し、中身は npm scripts を呼ぶ。
**ロジックを Taskfile 側へ移さないこと** — CI と lefthook は npm scripts を直接叩くので、
Taskfile にしか無い処理は CI を素通りする。

| コマンド         | 中身                                                 |
| ---------------- | ---------------------------------------------------- |
| `task setup`     | `install` → `env` → `hooks`。clone 直後の一発目      |
| `task env`       | `.dev.vars.example` から `.dev.vars` を作る          |
| `task check:env` | `.dev.vars` に雛形のままの値が残っていないか検査する |
| `task check`     | CI と同じ検査を手元で通す                            |

`task env` は**既存の `.dev.vars` を上書きしない**。手元に入れた本物の値は残る。
雛形のままの鍵（`GEMINI_API_KEY` / `AUTH_CLIENT_SECRET`）は警告として出る。
取得先は [`docs/auth.md`](docs/auth.md) と `apps/api/README.md` にある。

`npm run dev` は API Server / Desktop / Web App を並列で起動し、どれかが失敗すると残りも停止する。
VS Code Extension は、VS Codeでリポジトリルートを開いて `F5` でExtension Development Hostを起動します。
全体方針は [`docs/architecture.md`](docs/architecture.md) を参照する。

PR レビューから育てるプロジェクト固有ルールの運用は
[`docs/guardrails.md`](docs/guardrails.md) を参照する。
ルールの正典はエージェントが毎回読み込む [`.agents/rules/rules.md`](.agents/rules/rules.md) にある。
