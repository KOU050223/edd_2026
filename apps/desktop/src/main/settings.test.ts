import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  MANAGED_AI_MAX_OUTPUT_TOKENS,
  normalizeSettings,
  type DesktopSettings,
} from "./settings.js";

describe("normalizeSettings", () => {
  it("uses safe defaults for an absent settings file", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid user settings", () => {
    const settings: DesktopSettings = {
      apiBaseUrl: "https://api.example.com",
      shortcut: "CommandOrControl+Shift+K",
      model: "gpt-4.1-mini",
      temperature: 0.2,
      maxTokens: 1024,
      restoreClipboard: false,
      launchAtLogin: true,
    };

    expect(normalizeSettings(settings)).toEqual(settings);
  });

  it("rejects malformed or unsafe persisted values", () => {
    expect(
      normalizeSettings({
        apiBaseUrl: "",
        shortcut: "",
        model: "",
        temperature: 10,
        maxTokens: 0,
        restoreClipboard: "yes",
        launchAtLogin: false,
      }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects maxTokens above the Managed AI policy limit", () => {
    // サーバーが政策値（docs/architecture.md）で弾く値を保存させない。
    // 保存だけ通ると、送信して初めて 400 になる設定を利用者に作らせる。
    expect(
      normalizeSettings({
        ...DEFAULT_SETTINGS,
        maxTokens: MANAGED_AI_MAX_OUTPUT_TOKENS + 1,
      }),
    ).toEqual(DEFAULT_SETTINGS);
    expect(
      normalizeSettings({ ...DEFAULT_SETTINGS, maxTokens: MANAGED_AI_MAX_OUTPUT_TOKENS }).maxTokens,
    ).toBe(MANAGED_AI_MAX_OUTPUT_TOKENS);
  });

  it("allows local HTTP and remote HTTPS API URLs", () => {
    expect(
      normalizeSettings({
        ...DEFAULT_SETTINGS,
        apiBaseUrl: "http://localhost:8787",
      }).apiBaseUrl,
    ).toBe("http://localhost:8787");
    expect(
      normalizeSettings({
        ...DEFAULT_SETTINGS,
        apiBaseUrl: "https://api.example.com",
      }).apiBaseUrl,
    ).toBe("https://api.example.com");
  });

  it("rejects remote HTTP and malformed API URLs", () => {
    expect(
      normalizeSettings({ ...DEFAULT_SETTINGS, apiBaseUrl: "http://api.example.com" }),
    ).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, apiBaseUrl: "not a URL" })).toEqual(
      DEFAULT_SETTINGS,
    );
  });
});
