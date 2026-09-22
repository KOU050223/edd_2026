import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  MANAGED_AI_MAX_OUTPUT_TOKENS,
  normalizeSettings,
  type DesktopSettings,
} from "./settings.js";

/** 既存インストールに残っている、方針を厳しくする前の設定。 */
const LEGACY_SETTINGS = {
  apiBaseUrl: "https://api.example.com",
  shortcut: "CommandOrControl+Shift+J",
  model: "gemini-3.6-flash",
  temperature: 0.7,
  maxTokens: 4096,
  restoreClipboard: false,
  launchAtLogin: true,
};

describe("normalizeSettings", () => {
  it("uses safe defaults for an absent settings file", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid user settings", () => {
    const settings: DesktopSettings = {
      apiBaseUrl: "https://api.example.com",
      shortcut: "CommandOrControl+Shift+K",
      model: "gemini-3.8-flash",
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

  it("clamps a legacy oversized maxTokens without discarding other settings", () => {
    // 方針を厳しくしたせいで無効になった値は、その項目だけを直す。
    // ファイル全体を既定へ戻すと、API URL やショートカットといった
    // 無関係の設定まで黙って消える（利用者には「設定が飛んだ」と見える）。
    const migrated = normalizeSettings(LEGACY_SETTINGS);

    expect(migrated.maxTokens).toBe(MANAGED_AI_MAX_OUTPUT_TOKENS);
    expect(migrated.apiBaseUrl).toBe("https://api.example.com");
    expect(migrated.shortcut).toBe("CommandOrControl+Shift+J");
    expect(migrated.temperature).toBe(0.7);
    expect(migrated.restoreClipboard).toBe(false);
    expect(migrated.launchAtLogin).toBe(true);
  });

  it("falls back to the default model when a legacy model is no longer allowed", () => {
    // allowlist を入れたので、以前保存できた高単価モデルは通らない。
    // ここで直さないと、送信のたびに 400 になる設定が残り続ける。
    const migrated = normalizeSettings({ ...LEGACY_SETTINGS, model: "gemini-3.5-flash" });

    expect(migrated.model).toBe(DEFAULT_SETTINGS.model);
    // 移行するのは model だけ。他は保持する。
    expect(migrated.apiBaseUrl).toBe("https://api.example.com");
    expect(migrated.launchAtLogin).toBe(true);
  });

  it("still rejects a structurally broken settings file", () => {
    // 方針の変更ではなく壊れたファイルは、移行の対象にしない。
    expect(normalizeSettings({ ...LEGACY_SETTINGS, maxTokens: "4096" })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ ...LEGACY_SETTINGS, temperature: 99 })).toEqual(DEFAULT_SETTINGS);
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
