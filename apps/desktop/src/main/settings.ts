import { PERSONA_MAX_LENGTH } from "@gakushu-sochi/domain";

import type { DesktopSettings } from "../shared/types.js";

// DTO の正本は src/shared/types.ts（IPC の契約側）。ここからも使えるように再 export する。
export type { DesktopSettings } from "../shared/types.js";

/**
 * Managed AI の1回あたりの出力上限（tokens）。
 *
 * サーバー側の政策値と揃える（docs/ai-limits.md /
 * apps/api/src/contract/ai-usage.ts）。ここを緩めると、
 * 保存できるのに送信すると必ず 400 で弾かれる設定を利用者に作らせることになる。
 * **サーバー側を直すときは、この値も一緒に動かす。**
 */
export const MANAGED_AI_MAX_OUTPUT_TOKENS = 2_048;

/**
 * Managed AI が受け付けるモデル。
 *
 * サーバーの allowlist と揃える（`apps/api/src/contract/ai-usage.ts` の
 * `ALLOWED_MODELS`）。ここに無い値を保存できると、送信して初めて 400 になる
 * 設定を利用者に作らせることになる。**サーバー側を直すときは、この値も一緒に動かす。**
 */
export const MANAGED_AI_MODELS = ["gemini-3.6-flash", "gemini-3.8-flash"] as const;

export const DEFAULT_SETTINGS: DesktopSettings = {
  apiBaseUrl: "http://localhost:8787",
  shortcut: "CommandOrControl+Shift+K",
  model: "gemini-3.6-flash",
  temperature: 0.3,
  maxTokens: 1024,
  restoreClipboard: true,
  launchAtLogin: false,
  persona: "",
  saveConversationHistory: false,
};

/**
 * 保存済みの設定を、現在の方針に合う形へ直す。
 *
 * **方針を厳しくしたせいで無効になった値は、その項目だけを直す。**
 * `isSettings` は全項目を一度に見るため、`maxTokens` が1つ範囲外になっただけで
 * ファイル全体が「壊れている」と判定され、API URL・ショートカット・
 * ログイン時起動といった**無関係の設定まで既定値へ戻ってしまう**。
 * 利用者から見れば、更新したら設定が消えたのと区別がつかない。
 *
 * ここで直すのは、**かつて有効で、今の方針で範囲外になった**ものに限る。
 * 型そのものが違う値（文字列の `maxTokens` など）は移行の対象にしない。
 * それは方針の変更ではなく壊れたファイルであり、`isSettings` に任せる。
 */
function migrateTightenedPolicies(value: Record<string, unknown>): Record<string, unknown> {
  const migrated = { ...value };

  // 出力上限: 上限を 16,384 から 2,048 へ絞った（docs/ai-limits.md）。
  // 大きすぎる値は既定へ戻さず、現在の上限へ丸める。利用者が「大きめ」を
  // 選んでいた意図は、上限いっぱいという形で残るほうが近い。
  if (
    typeof migrated.maxTokens === "number" &&
    Number.isInteger(migrated.maxTokens) &&
    migrated.maxTokens > MANAGED_AI_MAX_OUTPUT_TOKENS
  ) {
    migrated.maxTokens = MANAGED_AI_MAX_OUTPUT_TOKENS;
  }

  // モデル: allowlist を入れた。許可外の値は既定モデルへ戻す。
  // こちらは丸められないので、既定へ倒すしかない。
  if (typeof migrated.model === "string" && !isManagedAiModel(migrated.model)) {
    migrated.model = DEFAULT_SETTINGS.model;
  }

  return migrated;
}

export function normalizeSettings(value: unknown): DesktopSettings {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_SETTINGS };
  const migrated = migrateTightenedPolicies(value as Record<string, unknown>);

  // persona は後から足した項目。isSettings は全項目を一度に見るため、
  // ここで欠損を既定値で補わないと、新項目を持たない古い settings.json が
  // 丸ごと既定値へ戻ってしまう（API URL やショートカットまで消える）。
  // 型違い・上限超過も同じ理由で、この項目だけを直す。
  if (typeof migrated.persona !== "string" || migrated.persona.length > PERSONA_MAX_LENGTH) {
    migrated.persona = DEFAULT_SETTINGS.persona;
  }

  // saveConversationHistory も後から足した項目。欠損・型違いは安全側の
  // false へ倒す（サーバー側でもオプトインを強制するので、ここが true に
  // 化けても本文は増えない）。
  if (typeof migrated.saveConversationHistory !== "boolean") {
    migrated.saveConversationHistory = DEFAULT_SETTINGS.saveConversationHistory;
  }

  if (!isSettings(migrated)) return { ...DEFAULT_SETTINGS };
  return migrated;
}

/** Managed AI が受け付けるモデルか。 */
export function isManagedAiModel(value: string): boolean {
  return (MANAGED_AI_MODELS as readonly string[]).includes(value);
}

/**
 * 各項目の制約をまとめた述語群。
 *
 * `isSettings`（古い settings.json の読み込み用の寛容な検査）と
 * `settings:save` のスキーマ（src/main/ipc/schemas.ts）の両方がここを正本にして、
 * モデルの一覧・persona の上限・URL の扱い・数値の範囲が 2 か所でずれないようにする。
 */
export function isSafeApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isValidShortcut(value: string): boolean {
  return value.length > 0;
}

export function isValidTemperature(value: number): boolean {
  return value >= 0 && value <= 2;
}

export function isValidMaxTokens(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MANAGED_AI_MAX_OUTPUT_TOKENS;
}

export function isValidPersona(value: string): boolean {
  return value.length <= PERSONA_MAX_LENGTH;
}

function isSettings(value: unknown): value is DesktopSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Record<string, unknown>;
  return (
    typeof settings.apiBaseUrl === "string" &&
    isSafeApiBaseUrl(settings.apiBaseUrl) &&
    typeof settings.shortcut === "string" &&
    isValidShortcut(settings.shortcut) &&
    typeof settings.model === "string" &&
    isManagedAiModel(settings.model) &&
    typeof settings.temperature === "number" &&
    isValidTemperature(settings.temperature) &&
    typeof settings.maxTokens === "number" &&
    isValidMaxTokens(settings.maxTokens) &&
    typeof settings.restoreClipboard === "boolean" &&
    typeof settings.launchAtLogin === "boolean" &&
    typeof settings.persona === "string" &&
    isValidPersona(settings.persona) &&
    typeof settings.saveConversationHistory === "boolean"
  );
}
