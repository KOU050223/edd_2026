# Desktop App

このアプリは常駐トレイ、グローバルショートカット、他アプリからの選択テキスト取得を担当する。

- OS 依存の処理（アクセシビリティ、SendKeys、Keychain / Credential Manager）はここだけで扱う。
- API トークンは OS の資格情報ストアに預ける。本文・質問・AI回答をこの端末へ永続化しない。
  サーバーへの履歴保存は「質問履歴の保存」オプトイン時のみ行う
  （`src/main/conversations-api.ts`、正本は `docs/conversation-history.md`）。
- AI プロバイダのキーを持たない。生成は API Server 経由で行う。
- `packages/domain` は利用してよいが、Electron の型を持ち込んではならない。
  domain は CJS パッケージで、Vite が `dist/` を main のバンドルへ取り込む
  （`devDependencies` に置き、配布物の node_modules には含めない）。

## ビルド・起動

Vite で `src/main`・`src/preload`・`src/renderer` の 3 つを `out/{main,preload,renderer}` へ出す。
設定は `vite.{main,preload,renderer}.config.ts`（Electron Forge の Vite テンプレートと同じ分け方）。

- `npm run build`：3 つのビルドを順に実行。preload は sandbox で動くため CJS 1 ファイル
  （`out/preload/index.cjs`）で出る。
- `npm run dev`：renderer は Vite dev server（HMR）、main・preload は watch ビルドで
  Electron を再起動する（`scripts/dev.mjs`）。dev server の URL は
  `ELECTRON_RENDERER_URL` で main へ渡し、loopback の http 以外は起動を失敗させる。
- `npm run start` / `npm run package`：build してから起動 / electron-builder。
- `npm run compile`：`tsc --noEmit` の型検査だけ。出力は Vite が作る。

## 構成

- `src/main`：メインプロセス。トレイ、グローバルショートカット、IPC、API 通信、OS 連携。
- `src/preload`：`contextBridge` で `window.api`（`DesktopApi` 型）だけを renderer へ公開する。
- `src/shared`：main・preload・renderer の 3 環境で評価される共有部。
  型と IPC 契約だけを置き、Electron・Node・DOM の API を参照してはいけない。
- `src/renderer`：React の UI。main とは `window.api` 経由でしか話せない。

## IPC を足す手順

1. `src/shared/ipc.ts` にチャネル名と `InvokeContract` / `SendContract` の型を足す
2. `src/main/ipc/schemas.ts` に引数の valibot スキーマを足す（契約の args 型に結びついている）
3. `src/main/ipc/<機能>.ts` に `handle` でハンドラを足す
4. `src/preload/index.ts` の `window.api` に公開する

チャネル名を各所に文字列で散らさない。契約を変えたらスキーマ側が型エラーで追いつく。

## セキュリティ

- renderer は独自スキーム `app://renderer/` で `out/renderer` から配る
  （`src/main/renderer-scheme.ts`）。dev では loopback の Vite dev server のみ許す。
- CSP は `src/renderer/index.html` の meta で固定する（`connect-src 'none'`、
  外部への接続は main 側の fetch だけが担う）。
- Electron Fuses は `package.json` の `build.electronFuses` で焼き込む
  （RunAsNode・NodeOptions・CLI inspect・file:// 特権を無効化、asar 完全性を有効化）。
  配布物に実際に効いているかは `scripts/check-package.mjs` が asar・Fuses・署名を検査する
  （release ワークフローから実行）。

## テスト

書き方・実行方法は [`docs/testing-guide.md`](../../docs/testing-guide.md) を参照する。

- テストは対象と同じディレクトリに `*.test.ts` で置く。拾う範囲は `vitest.config.ts`。
- **このワークスペースだけ `describe` / `it` と英語名で書かれている。** 既存に合わせる。
  揃えるためだけに他を書き換えない。
- Electron の実ウィンドウは起動しない。`stream.ts` や `markdown.js` のように、
  検証したいロジックを `app` / `BrowserWindow` から切り離してから書く。
- `test:watch` は未定義。監視したいときはこのディレクトリで `npx vitest` を叩く。
