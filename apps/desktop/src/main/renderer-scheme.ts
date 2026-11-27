// renderer を配る独自スキーム app:// の登録と配信（Issue #279 ステップ 5）。
// asar 内の file:// を読むには GrantFileProtocolExtraPrivileges が要るが、
// あの Fuse は file:// ページにローカルファイル全体への fetch 権も与えてしまう。
// 代わりに out/renderer だけを返す専用スキーム app://renderer/ に切り替え、
// Fuse は無効のままにする。
import { protocol } from "electron";
import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const RENDERER_SCHEME = "app";
export const RENDERER_HOST = "renderer";
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`;
export const RENDERER_INDEX_URL = `${RENDERER_ORIGIN}/index.html`;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// app.whenReady より前に呼ぶこと。特権は最小限: secure で https と同格の
// 安全なコンテキストを得るだけで、fetch API・CORS・CSP 回避は付けない。
export function registerRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: { standard: true, secure: true },
    },
  ]);
}

/** 「ファイルが存在しない」ことを示す errno。それ以外は見通しの悪い null にせず投げ直す。 */
function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/**
 * app://renderer/<path> を rendererRoot 配下の実ファイルへ解決する。
 * スキーム・ホストの不一致、ルート外への脱出（..・%2e%2e・シンボリックリンク）、
 * 存在しないパス、ファイルでないパス、知らない拡張子は null を返す
 * （呼び出し側は 404 を返す。index.html への黙ったフォールバックはしない）。
 * ファイルシステムの「存在しない」以外のエラー（権限・I/O など）は区別が付くよう
 * 呼び出し側へ投げ直す（RULE-004）。
 */
export function resolveRendererAsset(
  requestUrl: string,
  rendererRoot: string,
): { filePath: string; contentType: string } | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.host !== RENDERER_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const root = path.resolve(rendererRoot);
  const resolved = path.resolve(root, `.${path.sep}${pathname}`);
  const contentType = MIME_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) return null;
  // realpath でシンボリックリンク経由のルート外脱出も外す。
  let rootReal: string;
  let real: string;
  try {
    rootReal = realpathSync(root);
    real = realpathSync(resolved);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  const rel = path.relative(rootReal, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    if (!statSync(real).isFile()) return null;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  return { filePath: real, contentType };
}

/**
 * app:// リクエストを捌いて Response を返す本体。protocol.handle から委譲される。
 * 見つからない・許可しない要求は 404、解決・読み込みの失敗は 404 と区別して
 * 500 を返し、理由をログに残す（RULE-004: 失敗を握りつぶさない）。
 */
export async function serveRendererAsset(
  requestUrl: string,
  rendererRoot: string,
): Promise<Response> {
  try {
    const asset = resolveRendererAsset(requestUrl, rendererRoot);
    if (!asset) return new Response("not found", { status: 404 });
    const body = await readFile(asset.filePath);
    return new Response(new Uint8Array(body), {
      headers: { "Content-Type": asset.contentType },
    });
  } catch (error) {
    console.error(`app:// の配信に失敗しました: ${requestUrl}`, error);
    return new Response("internal error", { status: 500 });
  }
}

export function installRendererProtocolHandler(rendererRoot: string): void {
  protocol.handle(RENDERER_SCHEME, (request) => serveRendererAsset(request.url, rendererRoot));
}
