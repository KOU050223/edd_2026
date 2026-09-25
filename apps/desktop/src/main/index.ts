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
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
import { createConsentStore } from "./consent.js";
import { createAutoAdapters, createExportFileAdapter, type ScanFs } from "./history/sources.js";
import { createLocalRuleProvider } from "./history/local-rules.js";
import {
  CLI_SPECS,
  buildAnalysisPrompt,
  createCliAnalysisProvider,
  createManagedAnalysisProvider,
  createSpawnRunner,
  parseAnalysisOutput,
} from "./history/providers.js";
import { mergePastedAnalysis, runImportPipeline, type ImportPreview } from "./history/pipeline.js";
import {
  createImportSession,
  deleteEvidenceByProvider,
  listImportSessions,
  undoImportSession,
  type HistoryApiDeps,
} from "./history/api.js";
import {
  CONCEPTS,
  CONSENT_NOTICE_DETAIL,
  CONSENT_NOTICE_TITLE,
  type AnalysisMode,
  type EvidenceImportedBy,
  type HistoryProviderId,
  type RawConversation,
} from "@gakushu-sochi/domain";

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

/**
 * 同意の記録は `userData` 直下の専用ファイルへ置く。settings.json に混ぜると
 * `settings:save` の経路から同意を偽装できてしまう（RULE-006 / consent.ts）。
 */
function consentStore() {
  const filePath = path.join(app.getPath("userData"), "consent.json");
  return createConsentStore({
    read: () => (existsSync(filePath) ? readFileSync(filePath, "utf8") : ""),
    write: (value) => writeFileSync(filePath, value, { encoding: "utf8", mode: 0o600 }),
  });
}

/**
 * 同意済みであることを確かめる。未同意なら文面を提示して同意を求める。
 *
 * @returns 送信してよいか。false のとき、呼び出し側は送信せずに戻ること。
 *          記録の保存に失敗した場合は例外を投げ、送信を中止させる。
 */
async function ensureConsent(): Promise<boolean> {
  if (consentStore().has()) return true;

  const options = {
    type: "warning" as const,
    title: CONSENT_NOTICE_TITLE,
    message: CONSENT_NOTICE_TITLE,
    detail: CONSENT_NOTICE_DETAIL,
    buttons: ["同意して続ける", "同意しない"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result = popup
    ? await dialog.showMessageBox(popup, options)
    : await dialog.showMessageBox(options);
  if (result.response !== 0) return false;

  // 記録できないまま送ると、同意の証跡が無いまま送信を続けることになる。
  // 失敗は呼び出し側へ投げて、今回は送らない（RULE-004）。
  consentStore().grant(new Date().toISOString());
  return true;
}

/**
 * 同意の状態と文面を利用者が読み返せるようにする。同意済みなら取り消せる。
 *
 * すでに送ったデータの削除はここでは行わない。止まるのは「これから送るもの」
 * だけであることを利用者へ明示する。
 */
async function reviewConsent(): Promise<void> {
  if (!consentStore().has()) {
    await ensureConsent();
    return;
  }

  const options = {
    type: "info" as const,
    title: CONSENT_NOTICE_TITLE,
    message: CONSENT_NOTICE_TITLE,
    detail: `${CONSENT_NOTICE_DETAIL}\n\n現在、送信に同意しています。`,
    buttons: ["同意を取り消す", "閉じる"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const result = popup
    ? await dialog.showMessageBox(popup, options)
    : await dialog.showMessageBox(options);
  if (result.response !== 0) return;

  try {
    consentStore().revoke();
  } catch (error) {
    // 取り消せていないのに「取り消しました」と伝えると、送信が続いていることに
    // 利用者が気付けない。黙って飲み込まず、失敗として伝える（RULE-004）。
    console.error("同意の取り消しに失敗しました", error);
    dialog.showErrorBox(
      "同意を取り消せませんでした",
      "送信は停止していません。もう一度お試しください。",
    );
    return;
  }
  await dialog.showMessageBox({
    type: "info",
    message: "送信の同意を取り消しました。",
    detail: "以降の送信は行いません。すでに送信済みのデータの削除は含みません。",
    buttons: ["閉じる"],
    noLink: true,
  });
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
      {
        label: "送信内容の同意",
        click: () => {
          // showPopup("") は表示中の選択テキストを消してしまうため、
          // ウィンドウを出すだけにして文面はダイアログで見せる。
          popup ??= createPopup();
          activatePopup(app, popup);
          void reviewConsent();
        },
      },
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

/**
 * 保存済みの refresh token からアクセストークンを取る。
 * askManagedAI と同じ更新経路を使い、履歴インポート系 API 呼び出しに供する。
 */
async function getAccessToken(): Promise<string> {
  const generation = authOperation.current();
  if (authOperation.isLoginInProgress()) {
    throw new Error("ログイン中は履歴インポートを実行できません。");
  }
  const refreshToken = refreshTokenStore().get();
  if (!refreshToken) throw new Error("ログインが必要です。設定からログインしてください。");
  const refreshed = await refreshAccessTokenOrClearOnInvalidGrant(refreshToken, generation);
  if (!authOperation.isCurrent(generation)) {
    throw new Error("認証状態が変更されたため、処理を中止しました。");
  }
  if (refreshed.refreshToken) refreshTokenStore().set(refreshed.refreshToken);
  return refreshed.accessToken;
}

// ---------------------------------------------------------------------------
// 履歴インポート（Issue #157）
// ---------------------------------------------------------------------------

/** fs.promises を Adapter の ScanFs 面へ合わせる。 */
const historyFs: ScanFs = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  readFile: (file) => readFile(file, "utf8"),
  stat: (file) => stat(file),
};

/** Managed AI へ回す分析の1回のインポートあたりの予算。 */
const IMPORT_BUDGET = { managedAiMaxCalls: 10 };

interface HistoryAnalyzeRequest {
  providers?: HistoryProviderId[];
  filePath?: string;
  fileProvider?: HistoryProviderId;
  mode?: AnalysisMode;
  sinceMs?: number;
}

/**
 * 分析済みだが未適用の Import。renderer には本文を渡さないため、
 * prompt-copy fallback と apply の素材を main 側だけに保持する。
 * `analyze` ごとに上書きし、古い結果が後から適用されないようにする。
 */
interface PendingImport {
  preview: ImportPreview;
  pending: Map<HistoryProviderId, RawConversation[]>;
}
let pendingImport: PendingImport | undefined;

function historyApiDeps(): HistoryApiDeps {
  return {
    baseUrl: `${settings.apiBaseUrl.replace(/\/$/, "")}/v1`,
    getAccessToken,
    fetch,
  };
}

/** renderer へ返すプレビュー。evidence（概念IDのみ）と pending（本文）は落とす。 */
function previewForRenderer(preview: ImportPreview) {
  const { evidence, ...rest } = preview;
  return { ...rest, evidenceCount: evidence.length };
}

function buildAnalysisEntries() {
  const runner = createSpawnRunner();
  return [
    ...CLI_SPECS.map((spec) => ({
      provider: createCliAnalysisProvider(spec, runner),
      managed: false,
    })),
    {
      provider: createManagedAnalysisProvider({
        baseUrl: historyApiDeps().baseUrl,
        getAccessToken,
        fetch,
      }),
      managed: true,
    },
  ];
}

async function detectHistorySources() {
  const sources = [];
  for (const adapter of createAutoAdapters(historyFs)) {
    sources.push({ provider: adapter.provider, ...(await adapter.detect()) });
  }
  const analyzers = [];
  for (const entry of buildAnalysisEntries()) {
    analyzers.push({ id: entry.provider.id, available: await entry.provider.isAvailable() });
  }
  return { sources, analyzers };
}

async function analyzeHistory(
  request: HistoryAnalyzeRequest,
  onProgress: (progress: unknown) => void,
) {
  // 履歴本文が AI（CLI / Managed）へ出る経路なので、同意の記録があるときだけ走らせる。
  if (!(await ensureConsent())) {
    throw new Error("送信の同意が得られなかったため、インポートを中止しました。");
  }
  const adapters = createAutoAdapters(historyFs).filter((adapter) =>
    (request.providers ?? []).includes(adapter.provider),
  );
  if (request.filePath !== undefined && request.fileProvider !== undefined) {
    adapters.push(
      createExportFileAdapter(request.fileProvider, { fs: historyFs, filePath: request.filePath }),
    );
  }
  if (adapters.length === 0) {
    throw new Error("取り込む履歴ソースが選ばれていません。");
  }
  const mode: AnalysisMode = request.mode ?? "auto";
  const importedBy: EvidenceImportedBy = request.filePath === undefined ? "desktop" : "file";
  const run = await runImportPipeline({
    adapters,
    localProvider: createLocalRuleProvider(CONCEPTS),
    aiProviders: buildAnalysisEntries(),
    mode,
    budget: IMPORT_BUDGET,
    concepts: CONCEPTS,
    importedBy,
    sessionId: randomBytes(16).toString("base64url"),
    ...(request.sinceMs === undefined ? {} : { sinceMs: request.sinceMs }),
    onProgress,
  });
  pendingImport = { preview: run.preview, pending: run.pending };
  return {
    ...previewForRenderer(run.preview),
    pendingCount: [...run.pending.values()].reduce((sum, list) => sum + list.length, 0),
    canCopyPrompt: [...run.pending.values()].some((list) => list.length > 0),
  };
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
      // #174: 同意の記録があるときだけ送る。選択テキストと質問文が
      // Managed AI 経由で端末の外へ出る唯一の経路なので、ここで止める。
      if (!(await ensureConsent())) {
        throw new Error("送信の同意が得られなかったため、送信を中止しました。");
      }
      await askManagedAI(selection, normalizeQuestion(question), (delta) =>
        event.sender.send("answer:delta", delta),
      );
    });
    ipcMain.handle("consent:status", () => {
      const store = consentStore();
      return { granted: store.has(), grantedAt: store.grantedAt() };
    });
    ipcMain.handle("consent:review", async () => {
      await reviewConsent();
      const store = consentStore();
      return { granted: store.has(), grantedAt: store.grantedAt() };
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
    ipcMain.handle("history:detect", detectHistorySources);
    ipcMain.handle("history:pick-file", async () => {
      const options = {
        filters: [{ name: "AI エクスポート (JSON)", extensions: ["json"] }],
        properties: ["openFile" as const],
      };
      const result = popup
        ? await dialog.showOpenDialog(popup, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    ipcMain.handle("history:analyze", async (event, request: HistoryAnalyzeRequest) =>
      analyzeHistory(request, (progress) => {
        event.sender.send("history:progress", progress);
      }),
    );
    ipcMain.handle("history:build-prompt", () => {
      if (pendingImport === undefined) {
        throw new Error("先に履歴の分析を実行してください。");
      }
      // API の1回あたりの会話数上限と揃える（apps/api MAX_CONVERSATIONS_PER_ANALYSIS）。
      const conversations = [...pendingImport.pending.values()].flat().slice(0, 50);
      if (conversations.length === 0) {
        throw new Error("分析待ちの会話がありません。");
      }
      return buildAnalysisPrompt({
        conversations,
        knownConceptIds: CONCEPTS.map((concept) => concept.id),
      });
    });
    ipcMain.handle("history:paste-analysis", (_event, text: unknown) => {
      if (pendingImport === undefined) {
        throw new Error("先に履歴の分析を実行してください。");
      }
      if (typeof text !== "string") throw new Error("分析結果のテキストを貼ってください。");
      const merged = mergePastedAnalysis({
        preview: pendingImport.preview,
        pending: pendingImport.pending,
        result: parseAnalysisOutput(text),
        concepts: CONCEPTS,
      });
      pendingImport = { preview: merged.preview, pending: merged.remaining };
      return {
        ...previewForRenderer(merged.preview),
        pendingCount: [...merged.remaining.values()].reduce((sum, list) => sum + list.length, 0),
        canCopyPrompt: [...merged.remaining.values()].some((list) => list.length > 0),
      };
    });
    ipcMain.handle(
      "history:apply",
      async (_event, payload: { excludeConceptIds?: unknown } | undefined) => {
        if (pendingImport === undefined) {
          throw new Error("適用できる分析結果がありません。先に履歴の分析を実行してください。");
        }
        const excluded = new Set(
          Array.isArray(payload?.excludeConceptIds)
            ? payload.excludeConceptIds.filter((id): id is string => typeof id === "string")
            : [],
        );
        // プレビューで利用者が外した Concept を Evidence から除く。
        const evidence = pendingImport.preview.evidence
          .map((item) => ({
            ...item,
            conceptIds: item.conceptIds.filter((id) => !excluded.has(id)),
          }))
          .filter((item) => item.conceptIds.length > 0);
        // API の1回あたりの Evidence 上限（apps/api MAX_EVIDENCE_PER_IMPORT）。
        // 超えたまま送ると 400 で握りつぶされるため、理由が分かる形で止める。
        const MAX_EVIDENCE_PER_IMPORT = 5_000;
        if (evidence.length > MAX_EVIDENCE_PER_IMPORT) {
          throw new Error(
            `取り込む観測が ${MAX_EVIDENCE_PER_IMPORT.toLocaleString()} 件の上限を超えています（${evidence.length.toLocaleString()} 件）。対象のソースを減らすか、Concept を外してから適用してください。`,
          );
        }
        const result = await createImportSession(historyApiDeps(), {
          id: pendingImport.preview.sessionId,
          importedBy: pendingImport.preview.importedBy,
          providers: pendingImport.preview.providers,
          conversationCount: pendingImport.preview.conversationCount,
          ignoredCount: pendingImport.preview.ignoredCount,
          // サーバー側の上限（apps/api MAX_UNMAPPED_CANDIDATES=200）と揃える。
          unmappedCandidates: pendingImport.preview.unmapped.slice(0, 200),
          evidence,
        });
        // 適用後に残しておくと、同じ preview の二重適用や stale な
        // prompt への貼り戻しが起きる。適用したら破棄する。
        pendingImport = undefined;
        return result;
      },
    );
    ipcMain.handle("history:list", () => listImportSessions(historyApiDeps()));
    ipcMain.handle("history:undo", (_event, id: unknown) => {
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("取り消す Import の ID が指定されていません。");
      }
      return undoImportSession(historyApiDeps(), id);
    });
    const HISTORY_PROVIDERS: readonly string[] = [
      "codex",
      "chatgpt",
      "claude-code",
      "claude",
      "copilot",
      "cursor",
      "gemini",
      "vscode",
    ];
    ipcMain.handle("history:delete-provider", (_event, provider: unknown) => {
      if (typeof provider !== "string" || !HISTORY_PROVIDERS.includes(provider)) {
        throw new Error("削除する履歴ソースが不正です。");
      }
      return deleteEvidenceByProvider(historyApiDeps(), provider as HistoryProviderId);
    });
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
