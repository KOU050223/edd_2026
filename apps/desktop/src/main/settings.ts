/**
 * Managed AI の1回あたりの出力上限（tokens）。
 *
 * サーバー側の政策値と揃える（docs/architecture.md「Free / Pro の境界と
 * Managed AI の利用上限」/ apps/api/src/contract/ai-usage.ts）。ここを緩めると、
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

/**
 * 人格設定（persona）の最大長。
 *
 * サーバー側のスキーマと揃える（`apps/api/src/routes/ai.ts` の `PERSONA_MAX_LENGTH`）。
 * ここを緩めると、保存できるのに送信すると必ず 400 で弾かれる設定を
 * 利用者に作らせることになる。**サーバー側を直すときは、この値も一緒に動かす。**
 */
export const PERSONA_MAX_LENGTH = 500;

export interface DesktopSettings {
  apiBaseUrl: string;
  shortcut: string;
  model: string;
  temperature: number;
  maxTokens: number;
  restoreClipboard: boolean;
  launchAtLogin: boolean;
  /** 応答の人物像・口調（自由記述）。空文字は未設定。 */
  persona: string;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  apiBaseUrl: "http://localhost:8787",
  shortcut: "CommandOrControl+Shift+K",
  model: "gemini-3.6-flash",
  temperature: 0.3,
  maxTokens: 1024,
  restoreClipboard: true,
  launchAtLogin: false,
  persona: "",
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

  // 出力上限: 上限を 16,384 から 2,048 へ絞った（docs/architecture.md）。
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

  if (!isSettings(migrated)) return { ...DEFAULT_SETTINGS };
  return migrated;
}

/** Managed AI が受け付けるモデルか。 */
export function isManagedAiModel(value: string): boolean {
  return (MANAGED_AI_MODELS as readonly string[]).includes(value);
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
    isManagedAiModel(settings.model) &&
    typeof settings.temperature === "number" &&
    settings.temperature >= 0 &&
    settings.temperature <= 2 &&
    typeof settings.maxTokens === "number" &&
    Number.isInteger(settings.maxTokens) &&
    settings.maxTokens > 0 &&
    settings.maxTokens <= MANAGED_AI_MAX_OUTPUT_TOKENS &&
    typeof settings.restoreClipboard === "boolean" &&
    typeof settings.launchAtLogin === "boolean" &&
    typeof settings.persona === "string" &&
    settings.persona.length <= PERSONA_MAX_LENGTH
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
