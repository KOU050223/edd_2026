# リリース

各アプリのリリース方式と手順の正典。配線の変更はこのドキュメントと
`.github/workflows/`、`test/package-scripts.test.mjs` のメタテストを同時に直す。

## 一覧

| アプリ                  | 方式                      | トリガー                                |
| ----------------------- | ------------------------- | --------------------------------------- |
| `apps/api`              | Cloudflare Workers へ自動 | `main` への push（CI の verify 成功後） |
| `apps/web`              | Cloudflare Workers へ自動 | 同上。PR では preview Workers を発行    |
| `apps/desktop`          | GitHub Release を自動作成 | `desktop-vX.Y.Z` タグの push            |
| `apps/vscode-extension` | Marketplace へ手動公開    | なし（`vsce publish` を手動実行）       |

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
   GitHub Release `desktop-vX.Y.Z` への添付 → `KOU050223/homebrew-tap` の
   `Casks/gakushu-sochi.rb` 更新まで自動で行う。
   electron-builder には publish させず、`gh release create` が 2 ジョブの成果物を
   1 つのリリースへ集約する（matrix 各ジョブが個別にリリースを作ると競合する）。

### Homebrew

```bash
brew tap KOU050223/tap
brew install --cask gakushu-sochi
```

Cask の正本は `KOU050223/homebrew-tap` 側に置く。`brew tap` が `homebrew-<名>` を
暗に引く規約のため、`edd_2026` 内に Cask を置くとインストール手順が長くなる。
生成は `scripts/gen-cask.mjs` が担い、リリースごとに version と sha256 を書き換えて
homebrew-tap へ push する（`GITHUB_TOKEN` は他リポジトリを push できないので
`HOMEBREW_TAP_TOKEN` という secrets に tap 用の PAT を登録しておく）。

dmg のファイル名は `apps/desktop/package.json` の `artifactName` が決める。
Cask の URL はこれを参照するため、両方を同時に変えないとダウンロードが壊れる。

- Actions タブから `Release Desktop` を手動実行すると、リリースを作らずに
  ビルドだけ試せる（成果物は workflow artifacts に残る）。
- インストーラは**未署名**（adhoc のみ）。Homebrew 経由なら Cask の postflight が
  quarantine を外すのでそのまま開ける。dmg から手動で入れた場合は quarantine が
  残り「壊れている」と出るため、`xattr -dr com.apple.quarantine "/Applications/Gakushu Sochi.app"`
  またはシステム設定 → プライバシーとセキュリティから「このまま開く」が必要。
  Windows は SmartScreen の警告が出る。正式署名・公証・自動更新（electron-updater）は未整備。

## VS Code Extension（手動）

[Marketplace](https://marketplace.visualstudio.com/items?itemName=gakushu-sochi.gakushu-sochi)
に公開済み。公開に必要な Azure DevOps の PAT 管理が重いため、更新の公開も自動化しない。
version を上げてから手動で `vsce publish` を叩く。

```bash
# version を上げて main へマージしたあと
npm version patch --workspace=gakushu-sochi --no-git-tag-version
cd apps/vscode-extension
npm run package          # gakushu-sochi-X.Y.Z.vsix ができる
npx @vscode/vsce publish # PAT でログイン済みならそのまま公開される
```

## 今後の課題

- Desktop のコード署名（Apple Developer ID と公証、Windows の証明書）
- electron-updater による自動更新
- VS Code Extension の Marketplace 公開が常態化したら `vsce publish` の自動化を再検討
