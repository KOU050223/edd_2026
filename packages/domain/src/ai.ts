import type { CodeContext } from "./context.js";
import type { ConceptId, ConceptMastery } from "./profile.js";

/** AI の応答モード。 */
export type AskMode = "hint" | "explain";

/**
 * 人格設定（persona）の最大長。
 *
 * 応答の口調・人物像を利用者が自由記述で指定する設定の上限。
 * API のリクエストスキーマ（apps/api/src/routes/ai.ts）、desktop の設定
 * （apps/desktop/src/main/settings.ts）、VSCode 拡張の `gakushuSochi.ai.persona` が
 * 同じ値を使う。上限を置くのは、1回あたりの入力上限を persona が食い潰さないため。
 */
export const PERSONA_MAX_LENGTH = 500;

/** 回答の調整に必要な学習者プロファイルの要約。 */
export interface ProfileSummary {
  masteries: ConceptMastery[];
  recurringConceptIds?: ConceptId[];
}

/** VS Code に依存しない会話の1ターン。 */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

/** AI への1回のリクエスト。 */
export interface AIRequest {
  mode: AskMode;
  context: CodeContext;
  question?: string;
  diagnostics?: string[];
  profile?: ProfileSummary;
  history?: ConversationTurn[];
  /**
   * 利用者が選んだ応答の人物像・口調（自由記述）。未設定はキー自体を省略する。
   * 「何に答えるか」ではなく「どう答えるか」の口調にだけ効かせる。
   */
  persona?: string;
}

/** AI リクエストが失敗した理由。 */
export type AIErrorReason =
  | "model-unavailable"
  | "consent-denied"
  | "rate-limited"
  | "context-too-long"
  | "cancelled"
  | "unknown";

export interface AIError {
  reason: AIErrorReason;
  detail?: string;
}

/** AI が生成した回答。 */
export interface AIAnswer {
  text: string;
  conceptIds: ConceptId[];
  mode: AskMode;
  model?: string;
  resolution?: "resolved" | "unclear";
}

/** AI 呼び出しの結果。失敗は例外ではなく値として表す。 */
export type AIResponse = { ok: true; answer: AIAnswer } | { ok: false; error: AIError };
