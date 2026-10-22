import { describe, expect, it } from "vitest";

import { isTrustedIpcSender } from "./sender.js";

const popupWebContents = { id: "popup-webcontents" };
const otherWebContents = { id: "other-webcontents" };

const APP_INDEX_URL = "app://renderer/index.html";
const DEV_URL = "http://localhost:5173/";

describe("isTrustedIpcSender", () => {
  it("accepts the packaged renderer's app:// frame from the popup webContents", () => {
    expect(
      isTrustedIpcSender({
        frameUrl: "app://renderer/index.html",
        sender: popupWebContents,
        expectedSender: popupWebContents,
        allowedUrl: APP_INDEX_URL,
      }),
    ).toBe(true);
  });

  it("accepts a frame on the verified dev server origin", () => {
    for (const frameUrl of ["http://localhost:5173/", "http://localhost:5173/index.html"]) {
      expect(
        isTrustedIpcSender({
          frameUrl,
          sender: popupWebContents,
          expectedSender: popupWebContents,
          allowedUrl: DEV_URL,
        }),
      ).toBe(true);
    }
  });

  it("rejects a different host or scheme", () => {
    for (const frameUrl of [
      "app://evil/index.html",
      "app://renderer.attacker.example/index.html",
      "https://renderer/index.html",
      "file:///Applications/Gakushu%20Sochi.app/Contents/Resources/app.asar/out/renderer/index.html",
      "http://localhost:9999/",
      "https://localhost:5173/",
      "http://evil.example/",
    ]) {
      expect(
        isTrustedIpcSender({
          frameUrl,
          sender: popupWebContents,
          expectedSender: popupWebContents,
          allowedUrl: frameUrl.startsWith("http") ? DEV_URL : APP_INDEX_URL,
        }),
        frameUrl,
      ).toBe(false);
    }
  });

  it("rejects a sender that is not the popup webContents", () => {
    expect(
      isTrustedIpcSender({
        frameUrl: "app://renderer/index.html",
        sender: otherWebContents,
        expectedSender: popupWebContents,
        allowedUrl: APP_INDEX_URL,
      }),
    ).toBe(false);
  });

  it("rejects when there is no popup webContents", () => {
    expect(
      isTrustedIpcSender({
        frameUrl: "app://renderer/index.html",
        sender: popupWebContents,
        expectedSender: undefined,
        allowedUrl: APP_INDEX_URL,
      }),
    ).toBe(false);
  });

  it("rejects a missing or unparsable senderFrame URL", () => {
    for (const frameUrl of [undefined, "not a url", "about:blank"]) {
      expect(
        isTrustedIpcSender({
          frameUrl,
          sender: popupWebContents,
          expectedSender: popupWebContents,
          allowedUrl: APP_INDEX_URL,
        }),
        frameUrl,
      ).toBe(false);
    }
  });
});
