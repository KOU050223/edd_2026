// renderer → main の invoke 引数を実行時検証するスキーマ（Issue #279 ステップ 5）。
// handle（ipc/helpers.ts）がここのスキーマを必須で受け取り、ハンドラへ渡す前に
// 未検証の引数を検査する。INVOKE_SCHEMAS は InvokeChannel の mapped type で
// 出力型を契約の args に結びつけているため、チャネルの書き忘れ・スキーマと
// 契約の型ずれはどちらもコンパイルエラーになる。
import * as v from "valibot";

import {
  PERSONA_MAX_LENGTH,
  type AnalysisMode,
  type HistoryProviderId,
} from "@gakushu-sochi/domain";

import {
  isManagedAiModel,
  isSafeApiBaseUrl,
  isValidMaxTokens,
  isValidPersona,
  isValidShortcut,
  isValidTemperature,
  MANAGED_AI_MAX_OUTPUT_TOKENS,
} from "../settings.js";
import type { InvokeChannel, InvokeContract } from "../../shared/ipc.js";

/**
 * domain の HistoryProviderId に対応する一覧。allowlist の正本。
 * satisfies で余分な値を、`MissingProvider` のチェックで足りない値を、
 * どちらもコンパイルエラーで検出する。
 */
export const HISTORY_PROVIDER_IDS = [
  "codex",
  "chatgpt",
  "claude-code",
  "claude",
  "copilot",
  "cursor",
  "gemini",
  "vscode",
] as const satisfies readonly HistoryProviderId[];

type MissingProvider = Exclude<HistoryProviderId, (typeof HISTORY_PROVIDER_IDS)[number]>;
const allProvidersCovered: MissingProvider extends never ? true : never = true;
void allProvidersCovered;

/** domain の AnalysisMode に対応する一覧。 */
export const ANALYSIS_MODES = [
  "auto",
  "user-ai",
  "managed",
] as const satisfies readonly AnalysisMode[];

type MissingMode = Exclude<AnalysisMode, (typeof ANALYSIS_MODES)[number]>;
const allModesCovered: MissingMode extends never ? true : never = true;
void allModesCovered;

const providerId = v.picklist(HISTORY_PROVIDER_IDS);
const analysisMode = v.picklist(ANALYSIS_MODES);
const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * `settings:save` の厳密なスキーマ。
 *
 * settings.json の読み込み（normalizeSettings）は古いファイルの互換補完のため
 * 寛容に直すが、保存は renderer からの入力をそのまま信用できないため、
 * 型違い・範囲外・余分なキーはすべて「どの項目が不正か」を含むエラーで弾く
 * （RULE-004: 不正な項目を黙って既定値に直さない）。
 * 各項目の制約は main/settings.ts の述語を正本にして、読み込み側とずれないようにする。
 */
export const desktopSettingsSchema = v.strictObject({
  apiBaseUrl: v.pipe(
    v.string("apiBaseUrl は文字列にしてください"),
    v.check(
      isSafeApiBaseUrl,
      "apiBaseUrl は https:// か、localhost・127.0.0.1・[::1] の http:// にしてください",
    ),
  ),
  shortcut: v.pipe(v.string("shortcut は文字列にしてください"), v.check(isValidShortcut)),
  model: v.pipe(
    v.string("model は文字列にしてください"),
    v.check(isManagedAiModel, "model は Managed AI が受け付けるモデルから選んでください"),
  ),
  temperature: v.pipe(
    v.number("temperature は数値にしてください"),
    v.check(isValidTemperature, "temperature は 0 から 2 の間にしてください"),
  ),
  maxTokens: v.pipe(
    v.number("maxTokens は数値にしてください"),
    v.check(
      isValidMaxTokens,
      `maxTokens は 1 から ${MANAGED_AI_MAX_OUTPUT_TOKENS} の整数にしてください`,
    ),
  ),
  restoreClipboard: v.boolean("restoreClipboard は真偽値にしてください"),
  launchAtLogin: v.boolean("launchAtLogin は真偽値にしてください"),
  persona: v.pipe(
    v.string("persona は文字列にしてください"),
    v.check(isValidPersona, `persona は ${PERSONA_MAX_LENGTH} 文字以内にしてください`),
  ),
  saveConversationHistory: v.boolean("saveConversationHistory は真偽値にしてください"),
});

const historyAnalyzeRequestSchema = v.strictObject({
  providers: v.optional(v.array(providerId)),
  filePath: v.optional(v.string()),
  fileProvider: v.optional(providerId),
  mode: v.optional(analysisMode),
  sinceMs: v.optional(v.number()),
});

const historyApplyRequestSchema = v.strictObject({
  excludeConceptIds: v.optional(v.array(v.string())),
});

export const INVOKE_SCHEMAS: {
  [C in InvokeChannel]: v.GenericSchema<unknown, InvokeContract[C]["args"]>;
} = {
  "settings:get": v.strictTuple([]),
  "settings:save": v.strictTuple([desktopSettingsSchema]),
  "auth:login": v.strictTuple([]),
  "auth:logout": v.strictTuple([]),
  "selection:retry": v.strictTuple([]),
  "answer:ask": v.strictTuple([v.string(), v.string()]),
  "conversation-history:get": v.strictTuple([]),
  "conversation-history:set": v.strictTuple([v.boolean()]),
  "consent:status": v.strictTuple([]),
  "consent:review": v.strictTuple([]),
  "conversations:list": v.strictTuple([v.optional(v.string())]),
  "conversations:get": v.strictTuple([nonEmptyString]),
  "conversations:delete": v.strictTuple([nonEmptyString]),
  "history:detect": v.strictTuple([]),
  "history:pick-file": v.strictTuple([]),
  "history:analyze": v.strictTuple([historyAnalyzeRequestSchema]),
  "history:build-prompt": v.strictTuple([]),
  "history:paste-analysis": v.strictTuple([v.string()]),
  "history:apply": v.strictTuple([v.optional(historyApplyRequestSchema)]),
  "history:list": v.strictTuple([]),
  "history:undo": v.strictTuple([nonEmptyString]),
  "history:delete-provider": v.strictTuple([providerId]),
  "window:close": v.strictTuple([]),
  "window:minimize": v.strictTuple([]),
  "external-link:open": v.strictTuple([v.string()]),
  "system:accessibility": v.strictTuple([]),
};
