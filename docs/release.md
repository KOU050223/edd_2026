# リリース

各アプリのリリース方式と手順の正典。配線の変更はこのドキュメントと
`.github/workflows/`、`test/package-scripts.test.mjs` のメタテストを同時に直す。

## 一覧

| アプリ                  | 方式                      | トリガー                                |
| ----------------------- | ------------------------- | --------------------------------------- |
| `apps/api`              | Cloudflare Workers へ自動 | `main` への push（CI の verify 成功後） |
| `apps/web`              | Cloudflare Workers へ自動 | 同上。PR では preview Workers を発行    |
| `apps/desktop`          | GitHub Release を自動作成 | `desktop-vX.Y.Z` タグの push            |
| `apps/vscode-extension` | VSIX を手動で生成・配布   | なし（手順だけ定める）                  |

## バージョンとタグの規則

- バージョンはクライアントごとに各 `package.json` が持つ。API / Web は継続デプロイで
  バージョンを持たない。
- リリース用タグはアプリ名を冠する `desktop-vX.Y.Z` 形式。クライアントが増えても
  系統が衝突しないようにする。
- タグのバージョンは `apps/desktop/package.json` の `version` と一致させる。
  ワークフローが不一致を検出して失敗する（名と中身が食い違うリリースを出さないため）。

## Desktop（GitHub Release）

1. `apps/desktop/package.json` の `version` を上げて `main` へマージする。

   ```bash
   npm version patch --workspace=@gakushu-sochi/desktop --no-git-tag-version
   ```

2. `main` の先頭でタグを打って push する。

   ```bash
   tag="desktop-v$(node -p "require('./apps/desktop/package.json').version")"
   git tag "$tag"
   git push origin "$tag"
   ```

3. `release-desktop.yml` が検証 → mac（dmg、x64/arm64）と win（nsis）のビルド →
   GitHub Release `desktop-vX.Y.Z` への添付まで自動で行う。
   electron-builder には publish させず、`gh release create` が 2 ジョブの成果物を
   1 つのリリースへ集約する（matrix 各ジョブが個別にリリースを作ると競合する）。

- Actions タブから `Release Desktop` を手動実行すると、リリースを作らずに
  ビルドだけ試せる（成果物は workflow artifacts に残る）。
- インストーラは**未署名**。macOS は右クリック → 開く、または
  `xattr -dr com.apple.quarantine` が必要。Windows は SmartScreen の警告が出る。
  署名・公証・自動更新（electron-updater）は未整備。

## VS Code Extension（手動）

Marketplace 公開に必要な Azure DevOps の PAT 管理が重いため、自動化しない。
VSIX の生成と配布は手動のままにする。

```bash
# version を上げて main へマージしたあと
npm version patch --workspace=gakushu-sochi --no-git-tag-version
npm run package --workspace=gakushu-sochi   # apps/vscode-extension/ に *.vsix ができる
code --install-extension apps/vscode-extension/gakushu-sochi-*.vsix
```

Marketplace へ出す場合だけ `npx @vscode/vsce publish` を手動で叩く。

## 今後の課題

- Desktop のコード署名（Apple Developer ID と公証、Windows の証明書）
- electron-updater による自動更新
- VS Code Extension の Marketplace 公開が常態化したら `vsce publish` の自動化を再検討
