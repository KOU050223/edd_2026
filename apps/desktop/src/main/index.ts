import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { createCredentialStore } from "./credentials.js";
import { performLogout } from "./logout.js";
import {
  BOOKMARK_TYPE,
  captureSelection,
  isBookmark,
  toClipboardEntries,
  type ClipboardBookmarkLike,
  type ClipboardSnapshot,
} from "./selection.js";
import { DEFAULT_SETTINGS, normalizeSettings, type DesktopSettings } from "./settings.js";
import { parseOpenAIStream } from "./stream.js";
import { normalizeQuestion } from "./question.js";
import { shouldShowStartupWindow } from "./startup.js";
import { activatePopup } from "./activation.js";
import { isSafeExternalUrl } from "./external-link.js";
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  parseCallbackUrl,
  refreshAccessToken,
  OAuthTokenError,
  revokeRefreshToken,
  type OAuthConfig,
} from "./oauth.js";
import { describeApiFailure } from "./api-error.js";
import { AuthOperationState } from "./auth-operation.js";
import { CONCEPTS } from "@gakushu-sochi/domain";

const execFileAsync = promisify(execFile);
const SERVICE_NAME = "Gakushu Sochi";
const MAX_SELECTION_LENGTH = 20_000;
const OAUTH_CONFIG: OAuthConfig = {
  issuer: "https://gakushu-sochi.jp.auth0.com",
  clientId: "r9zPMIsOS9qezfcLkDQq6HC423e0ui0x",
  audience: "https://api.gakushu-sochi.dev",
};
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;
// Auth0 の Allowed Callback URLs はポートにワイルドカードを使えない。ポート 0（OS 任せ）
// にすると起動ごとに redirect_uri が変わり、毎回 "Callback URL mismatch" で弾かれる。
// そのため固定する。この値を変えるときは Auth0 側の登録も同時に変えること。
const OAUTH_CALLBACK_PORT = 53682;
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/callback`;
const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
let popup: BrowserWindow | undefined;
let tray: Tray | undefined;
let settings = { ...DEFAULT_SETTINGS };
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const authOperation = new AuthOperationState();

if (!hasSingleInstanceLock) {
  app.quit();
}

function updateLoginItem(): void {
  // 開発中は electron バイナリ自身をログイン項目へ登録できないため、
  // パッケージ済みアプリでのみ OS の自動起動設定を変更する。
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  }
}

async function guideAccessibilityPermission(): Promise<void> {
  if (process.platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(true)) return;
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "アクセシビリティ許可が必要です",
    message: "選択テキストを取得するには、Gakushu Sochi にコンピュータの制御を許可してください。",
    detail:
      "システム設定の「プライバシーとセキュリティ > アクセシビリティ」で、開発中は Electron を追加して有効にしてください。許可後にアプリを再起動するとショートカットが使えます。",
    buttons: ["アクセシビリティ設定を開く", "後で設定する"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) {
    await openAccessibilitySettings();
  }
}

async function openAccessibilitySettings(): Promise<void> {
  if (process.platform !== "darwin") return;
  // URL スキームだけでは無視される macOS 環境があるため、アプリを明示する。
  await execFileAsync("/usr/bin/open", ["-a", "System Settings", ACCESSIBILITY_SETTINGS_URL]);
}

function credentialStore(fileName: string) {
  const filePath = path.join(app.getPath("userData"), fileName);
  return createCredentialStore(
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    },
    {
      read: () => (existsSync(filePath) ? readFileSync(filePath, "utf8") : ""),
      write: (value) => writeFileSync(filePath, value, { encoding: "utf8", mode: 0o600 }),
    },
  );
}

function refreshTokenStore() {
  return credentialStore("refresh-token.enc");
}

async function loginWithBrowser(): Promise<void> {
  const generation = authOperation.beginLogin();
  try {
    const pkce = createPkcePair();
    const state = randomState();
    const callback = await waitForOAuthCallback(state);
    try {
      const redirectUri = callback.redirectUri;
      const authorizationUrl = buildAuthorizationUrl(
        OAUTH_CONFIG,
        redirectUri,
        state,
        pkce.challenge,
      );

      await shell.openExternal(authorizationUrl);
      const code = await callback.code;
      const tokens = await exchangeAuthorizationCode(
        OAUTH_CONFIG,
        code,
        redirectUri,
        pkce.verifier,
      );
      if (!authOperation.isCurrent(generation)) {
        throw new Error("認証状態が変更されたため、ログイン結果を破棄しました。");
      }
      refreshTokenStore().set(tokens.refreshToken);
    } finally {
      callback.close();
    }
  } finally {
    authOperation.finishLogin();
  }
}

/** ログアウトの順序は `logout.ts` が固定する（docs/auth.md §8）。ここは配線だけ。 */
async function logout(): Promise<void> {
  authOperation.begin();
  const store = refreshTokenStore();
  await performLogout({
    readRefreshToken: () => store.get(),
    clearRefreshToken: () => store.clear(),
    revoke: (refreshToken) => revokeRefreshToken(OAUTH_CONFIG, refreshToken),
    notify: (state) => popup?.webContents.send("auth:state", state),
    logError: (message, detail) => console.error(message, detail),
  });
}

function randomState(): string {
  return randomBytes(32).toString("base64url");
}

async function waitForOAuthCallback(
  expectedState: string,
): Promise<{ redirectUri: string; code: Promise<string>; close: () => void }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      // 握りつぶして別ポートへ逃げない。逃げた先は Auth0 に登録されておらず、
      // どのみち "Callback URL mismatch" になる（.agents/rules/rules.md RULE-004）。
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `OAuth のコールバック待受ポート ${OAUTH_CALLBACK_PORT} が使用中です。` +
                "このポートを使っているアプリを終了してから、もう一度ログインしてください。",
              { cause: error },
            )
          : error,
      );
    });
    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => resolve());
  });
  const redirectUri = OAUTH_REDIRECT_URI;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (timer) clearTimeout(timer);
    server.close();
  };
  const code = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      close();
      reject(new Error("OAuth ログインがタイムアウトしました。"));
    }, OAUTH_CALLBACK_TIMEOUT_MS);
    server.on("request", (request, response) => {
      if (request.url?.split("?", 1)[0] !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const callbackUrl = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${request.url}`;
      try {
        const authorizationCode = parseCallbackUrl(callbackUrl, expectedState);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<h1>ログインが完了しました</h1><p>この画面を閉じてください。</p>");
        close();
        resolve(authorizationCode);
      } catch (error) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : "OAuth コールバックが不正です。");
        close();
        reject(error);
      }
    });
  });
  return { redirectUri, code, close };
}

async function readClipboardSnapshot(): Promise<ClipboardSnapshot> {
  const items = await clipboard.read();
  const fingerprints: string[] = [];
  for (const item of items) {
    const values: string[] = [];
    for (const type of [...item.types].sort()) {
      const value = await item.getType(type);
      // 復元側（toClipboardEntries）と同じ 3 分岐にする。ここで形式を取り違えると
      // 指紋が衝突し、捕捉中に変わったクリップボードを上書きしかねない。
      if (value instanceof Blob) {
        const bytes = Buffer.from(await value.arrayBuffer()).toString("base64");
        values.push(`${type}:blob:${value.type}:${bytes}`);
      } else if (type === BOOKMARK_TYPE && isBookmark(value)) {
        values.push(`${type}:bookmark:${JSON.stringify([value.title, value.url])}`);
      } else {
        // 復元できない形式。JSON 化できない値では undefined が返り、
        // 別内容どうしが同じ指紋になってしまうため String() で必ず文字列にする。
        values.push(`${type}:unreconstructable:${String(JSON.stringify(value))}`);
      }
    }
    fingerprints.push(values.join("\u0000"));
  }
  return { items, fingerprint: fingerprints.join("\u0001") };
}

async function loadSettings(): Promise<void> {
  const settingsPath = path.join(app.getPath("userData"), "settings.json");
  try {
    settings = normalizeSettings(JSON.parse(await readFile(settingsPath, "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("設定ファイルを読み込めませんでした", { cause: error });
  }
}

async function saveSettings(next: DesktopSettings): Promise<void> {
  const settingsPath = path.join(app.getPath("userData"), "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  settings = next;
  updateLoginItem();
}

function createPopup(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    resizable: true,
    minimizable: true,
    // タイトルバーは renderer 側で描く。macOS は信号機を OS に出させたまま
    // 位置だけ寄せ、Windows / Linux は完全にフレームレスにする。
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 22 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(app.getAppPath(), "out/main/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url).catch((error) => {
        console.error("外部リンクを開けませんでした", error);
      });
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url).catch((error) => {
        console.error("外部リンクを開けませんでした", error);
      });
    }
  });
  void window.loadFile(path.join(app.getAppPath(), "src/renderer/index.html"));
  window.on("closed", () => {
    popup = undefined;
  });
  return window;
}

function showPopup(selection: string, error?: string): void {
  popup ??= createPopup();
  activatePopup(app, popup);
  const sendSelection = () => popup?.webContents.send("selection", { selection, error });
  if (popup.webContents.isLoading()) popup.webContents.once("did-finish-load", sendSelection);
  else sendSelection();
}

async function simulateCopy(): Promise<void> {
  if (process.platform === "darwin") {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
      throw new Error(
        "選択テキストを取得するには、システム設定の「プライバシーとセキュリティ > アクセシビリティ」で Gakushu Sochi（開発中は Electron）にコンピュータの制御を許可してください。",
      );
    }
    await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to tell (first process whose frontmost is true) to key code 8 using {command down}',
    ]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')",
    ]);
    return;
  }
  throw new Error(
    "この OS の選択テキスト取得には未対応です。macOS または Windows で実行してください。",
  );
}

async function openForSelection(): Promise<void> {
  try {
    const selection = await captureSelection({
      readText: () => clipboard.readText(),
      copy: simulateCopy,
      wait: () => new Promise((resolve) => setTimeout(resolve, 250)),
      readClipboard: readClipboardSnapshot,
      // clipboard.read() が返した ClipboardItem はそのまま書き戻せない
      // （「construct a new ClipboardItem to write」で拒否される）。
      // 中身をほどき、同じクラスで新しい ClipboardItem を組み立て直す。
      // ClipboardItem はメインプロセスのグローバルには無いため、
      // 読み出したアイテム自身のコンストラクタを使う。
      writeClipboard: async (items) => {
        if (items.length === 0) {
          clipboard.writeText("");
          return;
        }
        const entries = await toClipboardEntries(items, (type, value) => {
          // 書き戻せない形式は落とすほかないが、黙って消さず理由を残す。
          console.warn(`クリップボードの ${type} は再構築できないため復元しません:`, typeof value);
        });
        // Electron の型定義では ClipboardItem の値は Blob だけだが、
        // bookmark 形式は { title, url } のまま書き戻せる（Electron 44 の仕様）。
        const ClipboardItemClass = items[0]?.constructor as
          | (new (data: Record<string, Blob | ClipboardBookmarkLike>) => Electron.ClipboardItem)
          | undefined;
        if (!ClipboardItemClass || entries.length === 0) return;
        await clipboard.write(
          entries.map(
            (entry) =>
              new ClipboardItemClass(
                Object.fromEntries(entry.map(({ type, value }) => [type, value])),
              ),
          ),
        );
      },
      restoreClipboard: settings.restoreClipboard,
    });
    showPopup(
      selection.length > MAX_SELECTION_LENGTH
        ? selection.slice(0, MAX_SELECTION_LENGTH)
        : selection,
      selection.length > MAX_SELECTION_LENGTH
        ? `長文のため先頭 ${MAX_SELECTION_LENGTH.toLocaleString()} 文字のみを使用します。`
        : undefined,
    );
  } catch (error) {
    showPopup("", error instanceof Error ? error.message : "選択テキストの取得に失敗しました。");
  }
}

function registerShortcut(shortcut: string): void {
  globalShortcut.unregisterAll();
  if (
    !globalShortcut.register(shortcut, () => {
      void openForSelection();
    })
  ) {
    throw new Error(
      `ショートカット「${shortcut}」を登録できませんでした。他のアプリとの競合または権限を確認してください。`,
    );
  }
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip(SERVICE_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "選択テキストを質問",
        click: () => {
          void openForSelection();
        },
      },
      { label: "設定", click: () => showPopup("") },
      ...(process.platform === "darwin"
        ? [
            {
              label: "アクセシビリティ設定を開く",
              click: () => {
                void openAccessibilitySettings().catch((error) =>
                  showPopup(
                    "",
                    error instanceof Error
                      ? `アクセシビリティ設定を開けませんでした: ${error.message}`
                      : "アクセシビリティ設定を開けませんでした。",
                  ),
                );
              },
            },
          ]
        : []),
      { type: "separator" },
      { label: "終了", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => {
    void openForSelection();
  });
}

/**
 * 保存済みの refresh token でアクセストークンを取り直す。
 *
 * 取り消し・期限切れの refresh token（RFC 6749 の `invalid_grant`）のときだけ
 * 保存済みトークンを消す。ネットワーク障害やその他の OAuth エラーでは残す
 * （消すと、復旧すれば使えたはずのトークンを捨てて再ログインを強いることになる）。
 */
async function refreshAccessTokenOrClearOnInvalidGrant(refreshToken: string, generation: number) {
  try {
    return await refreshAccessToken(OAUTH_CONFIG, refreshToken);
  } catch (error) {
    if (error instanceof OAuthTokenError && error.code === "invalid_grant") {
      if (!authOperation.isCurrent(generation)) {
        throw new Error("認証状態が変更されたため、古い更新結果を破棄しました。", {
          cause: error,
        });
      }
      refreshTokenStore().clear();
      // 消したことを画面へ伝える。伝えないと設定を開き直すまで「ログイン済み」のままになる。
      popup?.webContents.send("auth:state", { hasRefreshToken: false });
      throw new Error("ログインの有効期限が切れました。設定から再ログインしてください。", {
        cause: error,
      });
    }
    throw error;
  }
}

async function askManagedAI(
  selection: string,
  question: string,
  onDelta: (text: string) => void,
): Promise<void> {
  const generation = authOperation.current();
  if (authOperation.isLoginInProgress()) {
    throw new Error("ログイン中は更新できません。");
  }
  const refreshToken = refreshTokenStore().get();
  if (!refreshToken) throw new Error("ログインが必要です。設定からログインしてください。");
  const refreshed = await refreshAccessTokenOrClearOnInvalidGrant(refreshToken, generation);
  if (!authOperation.isCurrent(generation)) {
    throw new Error("認証状態が変更されたため、更新結果を破棄しました。");
  }
  if (refreshed.refreshToken) refreshTokenStore().set(refreshed.refreshToken);
  const apiToken = refreshed.accessToken;
  const response = await fetch(`${settings.apiBaseUrl.replace(/\/$/, "")}/v1/ai/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    // リダイレクトを自動追跡しない。転送先へ Authorization ヘッダごと送られると、
    // トークンが意図しない相手に渡る（.agents/rules/rules.md RULE-002）。
    redirect: "error",
    body: JSON.stringify({
      selection,
      question,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      // 空文字は送らない。サーバーは省略と空文字を同じ「未設定」に正規化するが、
      // 送る側でも未設定はキー自体を落としておく。
      ...(settings.persona.trim() ? { persona: settings.persona.trim() } : {}),
    }),
  });
  if (!response.ok || !response.body) {
    // サーバーが返した error を捨てない。捨てると鍵の未設定もネットワーク不通も
    // 同じ文面になり、URL やトークンを疑わせる誤った誘導になる（RULE-004）。
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      // 本文が JSON でないのは想定内。状態コードだけの文言へ落とす。
      body = undefined;
    }
    throw new Error(describeApiFailure(response.status, body));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    parseOpenAIStream(lines.join("\n"), onDelta);
    if (done) break;
  }
  if (pending) parseOpenAIStream(pending, onDelta);
}

app.on("second-instance", () => {
  if (popup) {
    popup.show();
    popup.focus();
  }
});

app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock) return;
    await loadSettings();
    updateLoginItem();
    await guideAccessibilityPermission();
    createTray();
    registerShortcut(settings.shortcut);
    ipcMain.handle("settings:get", async () => ({
      ...settings,
      hasRefreshToken: Boolean(refreshTokenStore().get()),
    }));
    ipcMain.handle("settings:save", async (_event, next: DesktopSettings) => {
      const candidate = next;
      const valid = normalizeSettings(candidate);
      if (
        JSON.stringify(valid) === JSON.stringify(DEFAULT_SETTINGS) &&
        JSON.stringify(candidate) !== JSON.stringify(DEFAULT_SETTINGS)
      )
        throw new Error("設定値が不正です。");
      try {
        registerShortcut(valid.shortcut);
      } catch (error) {
        registerShortcut(settings.shortcut);
        throw error;
      }
      await saveSettings(valid);
    });
    ipcMain.handle("auth:login", loginWithBrowser);
    ipcMain.handle("auth:logout", logout);
    ipcMain.handle("selection:retry", openForSelection);
    ipcMain.handle("answer:ask", async (event, selection: string, question: string) => {
      if (!selection.trim()) throw new Error("選択テキストを取得できませんでした。");
      await askManagedAI(selection, normalizeQuestion(question), (delta) =>
        event.sender.send("answer:delta", delta),
      );
    });
    // Concept 一覧は packages/domain が正典。習熟度は API 側で導出されるため、
    // ここでは一覧だけを渡し、status は未取得を表す "unobserved" を既定にする。
    ipcMain.handle("concepts:list", () =>
      CONCEPTS.map((concept) => ({
        id: concept.id,
        label: concept.label,
        language: concept.language,
      })),
    );
    ipcMain.handle("window:close", () => popup?.hide());
    ipcMain.handle("window:minimize", () => popup?.minimize());
    ipcMain.handle("external-link:open", async (_event, url: unknown) => {
      if (typeof url !== "string" || !isSafeExternalUrl(url)) {
        throw new Error("このリンクは開けません。");
      }
      await shell.openExternal(url);
    });
    ipcMain.handle("system:accessibility", async () => {
      await openAccessibilitySettings();
    });
    if (shouldShowStartupWindow(app.isPackaged)) showPopup("");
  })
  .catch((error) => {
    console.error("アプリの初期化に失敗しました", error);
    const message = error instanceof Error ? error.message : "アプリの初期化に失敗しました。";
    dialog.showErrorBox("Gakushu Sochi の起動に失敗しました", message);
    app.quit();
  });

app.on("will-quit", () => globalShortcut.unregisterAll());
