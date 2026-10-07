// renderer を配る独自スキーム app:// の登録と配信（Issue #279 ステップ 5）。
// asar 内の file:// を読むには GrantFileProtocolExtraPrivileges が要るが、
// あの Fuse は file:// ページにローカルファイル全体への fetch 権も与えてしまう。
// 代わりに out/renderer だけを返す専用スキーム app://renderer/ に切り替え、
// Fuse は無効のままにする。
import { protocol } from "electron";
import { readFileSync, realpathSync, statSync } from "node:fs";
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

/**
 * app://renderer/<path> を rendererRoot 配下の実ファイルへ解決する。
 * スキーム・ホストの不一致、ルート外への脱出（..・%2e%2e・シンボリックリンク）、
 * 存在しないパス、ファイルでないパス、知らない拡張子は null を返す
 * （呼び出し側は 404 を返す。index.html への黙ったフォールバックはしない）。
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
  } catch {
    return null;
  }
  const rel = path.relative(rootReal, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!statSync(real).isFile()) return null;
  return { filePath: real, contentType };
}

export function installRendererProtocolHandler(rendererRoot: string): void {
  protocol.handle(RENDERER_SCHEME, (request) => {
    const asset = resolveRendererAsset(request.url, rendererRoot);
    if (!asset) return new Response("not found", { status: 404 });
    return new Response(readFileSync(asset.filePath), {
      headers: { "Content-Type": asset.contentType },
    });
  });
}
