import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { resolveRendererAsset, serveRendererAsset } from "./renderer-scheme.js";

const root = mkdtempSync(path.join(tmpdir(), "renderer-scheme-"));
const outside = mkdtempSync(path.join(tmpdir(), "renderer-scheme-outside-"));

mkdirSync(path.join(root, "assets"), { recursive: true });
writeFileSync(path.join(root, "index.html"), "<html></html>");
writeFileSync(path.join(root, "assets", "index.js"), "console.log(1)");
writeFileSync(path.join(outside, "secret.js"), "secret");
symlinkSync(path.join(outside, "secret.js"), path.join(root, "escape.js"));
// 自分自身を指すシンボリックリンク。realpathSync が ENOENT ではなく
// ELOOP で失敗する（「存在しない」以外のエラーが投げ直されることの検証用）。
symlinkSync("loop.js", path.join(root, "loop.js"));
// statSync は通るが readFile が EACCES で失敗する（読み込み失敗 → 500 の検証用）。
writeFileSync(path.join(root, "unreadable.js"), "x");
chmodSync(path.join(root, "unreadable.js"), 0o000);

afterAll(() => {
  chmodSync(path.join(root, "unreadable.js"), 0o644);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveRendererAsset", () => {
  it("resolves a normal asset to a real file path with a MIME type", () => {
    const asset = resolveRendererAsset("app://renderer/index.html", root);
    expect(asset).not.toBeNull();
    // filePath は realpath 済み（macOS の /var → /private/var の違いを吸収するため）。
    expect(asset?.filePath).toBe(realpathSync(path.join(root, "index.html")));
    expect(asset?.contentType).toBe("text/html; charset=utf-8");

    const js = resolveRendererAsset("app://renderer/assets/index.js", root);
    expect(js?.contentType).toBe("text/javascript; charset=utf-8");
  });

  it("rejects hosts other than renderer and schemes other than app", () => {
    expect(resolveRendererAsset("app://evil/index.html", root)).toBeNull();
    expect(resolveRendererAsset("app://renderer.attacker/index.html", root)).toBeNull();
    expect(resolveRendererAsset("https://renderer/index.html", root)).toBeNull();
    expect(resolveRendererAsset("file:///index.html", root)).toBeNull();
  });

  it("rejects traversal outside the renderer root", () => {
    expect(resolveRendererAsset(`app://renderer/../outside/secret.js`, root)).toBeNull();
    expect(resolveRendererAsset("app://renderer/%2e%2e/outside/secret.js", root)).toBeNull();
    expect(resolveRendererAsset("app://renderer/%2E%2E%2Foutside%2Fsecret.js", root)).toBeNull();
    expect(resolveRendererAsset("app://renderer/..%2foutside%2fsecret.js", root)).toBeNull();
  });

  it("rejects a symlink that escapes the renderer root", () => {
    expect(resolveRendererAsset("app://renderer/escape.js", root)).toBeNull();
  });

  it("rejects missing files, directories, and unknown extensions", () => {
    expect(resolveRendererAsset("app://renderer/missing.html", root)).toBeNull();
    expect(resolveRendererAsset("app://renderer/assets", root)).toBeNull();
    expect(resolveRendererAsset("app://renderer/", root)).toBeNull();
    expect(resolveRendererAsset("app://renderer/index.exe", root)).toBeNull();
  });

  it("rejects unparseable input", () => {
    expect(resolveRendererAsset("not a url", root)).toBeNull();
    expect(resolveRendererAsset("app://renderer/%ZZ", root)).toBeNull();
  });

  it("treats a path through a non-directory (ENOTDIR) as not found", () => {
    expect(resolveRendererAsset("app://renderer/index.html/nested.js", root)).toBeNull();
  });

  it("rethrows filesystem errors other than ENOENT/ENOTDIR", () => {
    // loop.js の realpathSync は ELOOP で失敗する。null に丸めず投げる。
    expect(() => resolveRendererAsset("app://renderer/loop.js", root)).toThrow();
  });
});

describe("serveRendererAsset", () => {
  it("serves a file asynchronously with status 200 and a MIME type", async () => {
    const response = await serveRendererAsset("app://renderer/index.html", root);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("<html></html>");
  });

  it("returns 404 for disallowed or missing assets", async () => {
    expect((await serveRendererAsset("app://renderer/missing.html", root)).status).toBe(404);
    expect((await serveRendererAsset("app://evil/index.html", root)).status).toBe(404);
  });

  it("returns 500 and logs the reason when the resolved file cannot be read", async () => {
    // root で動く環境では EACCES を再現できないのでスキップする。
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await serveRendererAsset("app://renderer/unreadable.js", root);
      expect(response.status).toBe(500);
      expect(consoleError).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("returns 500 and logs the reason when resolution throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await serveRendererAsset("app://renderer/loop.js", root);
      expect(response.status).toBe(500);
      expect(consoleError).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });
});
