import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { resolveRendererAsset } from "./renderer-scheme.js";

const root = mkdtempSync(path.join(tmpdir(), "renderer-scheme-"));
const outside = mkdtempSync(path.join(tmpdir(), "renderer-scheme-outside-"));

mkdirSync(path.join(root, "assets"), { recursive: true });
writeFileSync(path.join(root, "index.html"), "<html></html>");
writeFileSync(path.join(root, "assets", "index.js"), "console.log(1)");
writeFileSync(path.join(outside, "secret.js"), "secret");
symlinkSync(path.join(outside, "secret.js"), path.join(root, "escape.js"));

afterAll(() => {
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
});
