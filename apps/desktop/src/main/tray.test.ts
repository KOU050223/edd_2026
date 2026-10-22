import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveTrayIconPath } from "./tray.js";

describe("resolveTrayIconPath", () => {
  it("points at the asset that the Vite build emits under out/main", () => {
    expect(resolveTrayIconPath("/Applications/app/Contents/Resources/app.asar")).toBe(
      path.join(
        "/Applications/app/Contents/Resources/app.asar",
        "out",
        "main",
        "assets",
        "tray-icon.png",
      ),
    );
    expect(resolveTrayIconPath("/repo/apps/desktop")).toBe(
      path.join("/repo/apps/desktop", "out", "main", "assets", "tray-icon.png"),
    );
  });
});
