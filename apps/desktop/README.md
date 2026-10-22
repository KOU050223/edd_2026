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

## 構成

Vite + React + TypeScript で、プロセスごとに 4 つのディレクトリに分かれています。

- `src/main`：メインプロセス（トレイ、グローバルショートカット、IPC、API 通信）
- `src/preload`：`window.api` を公開する preload（sandbox 内、CJS）
- `src/shared`：3 環境で共有する型と IPC 契約。Electron / Node / DOM の API は参照しない
- `src/renderer`：React の UI。配布版では独自スキーム `app://renderer/` から配信し、CSP で `connect-src 'none'` に固定（外部通信は main だけが担う）

IPC を足すときは `src/shared/ipc.ts` の契約 → `src/main/ipc/schemas.ts` のスキーマ → `src/main/ipc/<機能>.ts` の `handle` → `src/preload/index.ts` の公開、の順に揃えます。詳細は `AGENTS.md` を参照してください。

## 使い方

初期ショートカットは `CommandOrControl+Shift+K` です。任意のアプリで文字列を選択して押すと、小型ウィンドウが開きます。`Cmd/Ctrl+Enter` で送信、`Esc` で閉じます。

macOS はアクセシビリティ設定で Gakushu Sochi に「コンピュータの制御」を許可してください。Windows は PowerShell の SendKeys を使います。ショートカットが他アプリと競合した場合は、起動時または設定保存時に画面へエラーを表示します。

## パッケージング

```bash
npm run package --workspace=@gakushu-sochi/desktop
```

macOS は DMG、Windows は NSIS インストーラーを生成します。Linux は現在サポート対象外です。選択テキストは 20,000 文字で切り詰めます。

Electron Fuses（`package.json` の `build.electronFuses`）で RunAsNode などを無効化し、asar 完全性検証を有効にしています。パッケージの中身・Fuses・署名は次で検査できます（release CI でも実行）。

```bash
node scripts/check-package.mjs   # apps/desktop/dist を検査
```
