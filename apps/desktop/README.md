# Gakushu Sochi Desktop

macOS のメニューバー、Windows のタスクトレイに常駐し、任意のアプリで選択したテキストを質問する Electron アプリです。

## 起動

リポジトリルートで依存関係をインストールした後、次を実行します。

```bash
npm run dev --workspace=@gakushu-sochi/desktop
```

`dev` は renderer を Vite dev server（HMR）から読み、main・preload は変更のたびに
再ビルドして Electron を再起動します。ビルド済みの `out/` からそのまま起動する
（配布物と同じ経路の）確認には `npm run start` を使います。

初回起動後、「設定」から API URL（ローカル開発は `http://localhost:8787`）、API トークン、モデル、ショートカットを設定してください。API トークンは macOS Keychain / Windows Credential Manager に保存し、本文・質問は永続化しません。AI のプロバイダキー（Gemini）は API Server 側だけに置きます。

## 使い方

初期ショートカットは `CommandOrControl+Shift+K` です。任意のアプリで文字列を選択して押すと、小型ウィンドウが開きます。`Cmd/Ctrl+Enter` で送信、`Esc` で閉じます。

macOS はアクセシビリティ設定で Gakushu Sochi に「コンピュータの制御」を許可してください。Windows は PowerShell の SendKeys を使います。ショートカットが他アプリと競合した場合は、起動時または設定保存時に画面へエラーを表示します。

## パッケージング

```bash
npm run package --workspace=@gakushu-sochi/desktop
```

macOS は DMG、Windows は NSIS インストーラーを生成します。Linux は現在サポート対象外です。選択テキストは 20,000 文字で切り詰めます。
