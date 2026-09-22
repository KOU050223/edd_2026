/**
 * Managed AI の1回あたりの出力上限（tokens）。
 *
 * サーバー側の政策値と揃える（docs/architecture.md「Free / Pro の境界と
 * Managed AI の利用上限」/ apps/api/src/contract/ai-usage.ts）。ここを緩めると、
 * 保存できるのに送信すると必ず 400 で弾かれる設定を利用者に作らせることになる。
 * **サーバー側を直すときは、この値も一緒に動かす。**
 */
export const MANAGED_AI_MAX_OUTPUT_TOKENS = 2_048;

export interface DesktopSettings {
  apiBaseUrl: string;
  shortcut: string;
  model: string;
  temperature: number;
  maxTokens: number;
  restoreClipboard: boolean;
  launchAtLogin: boolean;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  apiBaseUrl: "http://localhost:8787",
  shortcut: "CommandOrControl+Shift+K",
  model: "gemini-3.6-flash",
  temperature: 0.3,
  maxTokens: 1024,
  restoreClipboard: true,
  launchAtLogin: false,
};

export function normalizeSettings(value: unknown): DesktopSettings {
  if (!isSettings(value)) return { ...DEFAULT_SETTINGS };
  return value;
}

function isSettings(value: unknown): value is DesktopSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Record<string, unknown>;
  return (
    typeof settings.apiBaseUrl === "string" &&
    isSafeApiBaseUrl(settings.apiBaseUrl) &&
    typeof settings.shortcut === "string" &&
    settings.shortcut.length > 0 &&
    typeof settings.model === "string" &&
    settings.model.length > 0 &&
    typeof settings.temperature === "number" &&
    settings.temperature >= 0 &&
    settings.temperature <= 2 &&
    typeof settings.maxTokens === "number" &&
    Number.isInteger(settings.maxTokens) &&
    settings.maxTokens > 0 &&
    settings.maxTokens <= MANAGED_AI_MAX_OUTPUT_TOKENS &&
    typeof settings.restoreClipboard === "boolean" &&
    typeof settings.launchAtLogin === "boolean"
  );
}

function isSafeApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
