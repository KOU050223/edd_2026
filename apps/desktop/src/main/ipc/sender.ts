// IPC 呼び出しの送信元検証（Issue #279 ステップ 5）。
// event.senderFrame が自分の renderer（本番は app://renderer、開発時は検証済み
// dev server の origin）で、かつ appState.popup の webContents から
// 来た呼び出しだけを通す。Electron API には触れず、引数だけで判定する。

export interface IpcSenderCheck {
  /** event.senderFrame?.url。frame が無ければ undefined。 */
  readonly frameUrl: string | undefined;
  /** event.sender（webContents）。 */
  readonly sender: unknown;
  /** appState.popup?.webContents。popup が無ければ undefined。 */
  readonly expectedSender: unknown;
  /**
   * 許可する renderer の URL。
   * 本番は app://renderer/index.html、開発時は resolveRendererDevServerUrl が
   * 検証した dev server の URL。
   */
  readonly allowedUrl: string | undefined;
}

function parseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * IPC の送信元がこのアプリの renderer 自身かを判定する。
 *
 * - sender が popup の webContents と一致しないなら不許可
 *   （別ウィンドウ・webView・外部プロセスからの呼び出しを弾く）。
 * - frame の URL が期待する renderer の URL と同じ origin であること。
 *   WHATWG の URL.origin は非特殊スキーム（app:）を null にするので、
 *   protocol + host で比較する（host はポートを含む）。
 */
export function isTrustedIpcSender(check: IpcSenderCheck): boolean {
  if (check.expectedSender === undefined || check.sender !== check.expectedSender) return false;
  const frame = parseUrl(check.frameUrl);
  const allowed = parseUrl(check.allowedUrl);
  if (!frame || !allowed) return false;
  return frame.protocol === allowed.protocol && frame.host === allowed.host;
}
