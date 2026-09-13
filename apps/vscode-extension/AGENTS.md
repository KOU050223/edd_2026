# VS Code Extension

このアプリは VS Code 固有の入力・表示・`vscode.lm` 連携を担当する。

- `vscode` API はこのディレクトリの中だけで使う。`packages/domain` へ持ち込まない。
- コード文脈の収集、ローカルのオフラインキュー、ユーザーへのエラー表示はここで担う。
- 学習イベントと習熟度の正本は将来の API Server にある。クライアントから習熟度を確定・保存しない。
- 拡張のビルド・テストはリポジトリルートで `npm test` を実行する。F5 はリポジトリルートを開いて起動する。

## テスト

書き方・実行方法は [`docs/testing-guide.md`](../../docs/testing-guide.md) を参照する。

- **テストは `src/test/` にまとめる**（このワークスペースだけ併置していない）。
- VS Code 本体は起動しない。`vscode` を import する経路は `vi.mock("vscode", ...)` で
  差し替える。モックが変数を参照するなら `vi.hoisted` で作る。
- `vscode` に触れないロジックは `src/ai/` や `src/learning/` 側へ寄せ、モック無しで検証する。
