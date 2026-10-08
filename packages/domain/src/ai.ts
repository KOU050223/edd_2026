import type { CodeContext } from "./context.js";
import type { ConceptFamiliarity } from "./history-import.js";
import type { LearningObjective } from "./learning-objective.js";
import type { Concept, ConceptId, ConceptMastery } from "./profile.js";

/**
 * 人格設定（persona）の最大長。
 *
 * 応答の口調・人物像を利用者が自由記述で指定する設定の上限。
 * API のリクエストスキーマ（apps/api/src/routes/ai.ts）、desktop の設定
 * （apps/desktop/src/main/settings.ts）、VSCode 拡張の `gakushuSochi.ai.persona` が
 * 同じ値を使う。上限を置くのは、1回あたりの入力上限を persona が食い潰さないため。
 */
export const PERSONA_MAX_LENGTH = 500;

/**
 * 回答の調整に必要な学習者プロファイルの要約（Issue #216）。
 *
 * 長期履歴そのものではなく、現在の質問に関係する Concept と再発状況などの
 * 最小限の要約を渡す方針（docs/architecture.md「Phase 2」）。
 * `learner-position.ts` の `buildLearnerPositionLines` がプロンプト向けの
 * 行へ変換する。
 */
export interface ProfileSummary {
  /** 観測のある Concept の習熟度。`unobserved` は「判断材料がない」なので載せない。 */
  masteries: ConceptMastery[];
  /** 直近で同じエラーが再発した Concept。`recentlyRecurredConceptIds` で導出する。 */
  recurringConceptIds?: ConceptId[];
  /**
   * 外部履歴由来の「触れた形跡」（Issue #157）。
   * Evidence はサーバーだけが持つため、クライアント側の要約では省略する。
   */
  familiarity?: ConceptFamiliarity[];
}

/**
 * 利用者ごとに API から読む Concept と「理解すること」（Issue #242、#245）。
 *
 * `concepts` は利用者が手で作った学習マップのノード。固定の一覧（`CONCEPTS`）に足して
 * 「既知の概念一覧」に載せ、質問で手作りのノードにも理解度を積めるようにする。
 * ノードの `language` はマップの ID で、言語では絞らない。
 *
 * `objectives` は固定の Concept の項目（API の表にある。#245）と、手作りのノードの項目。
 */
export interface UserConcepts {
  concepts: readonly Concept[];
  objectives: readonly LearningObjective[];
}

/** VS Code に依存しない会話の1ターン。 */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

/** AI への1回のリクエスト。 */
export interface AIRequest {
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
  /** 利用者が手で作った学習マップのノード（#242）。取得できていなければキー自体を省略する。 */
  userConcepts?: UserConcepts;
}

/** AI リクエストが失敗した理由。 */
export type AIErrorReason =
  | "model-unavailable"
  | "consent-denied"
  | "auth-failed"
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
  /**
   * 回答が触れた「理解すること」（`LearningObjective`）の ID（設計/04 #223）。
   * 項目を判定しない経路（判定に未対応の Provider など）ではキー自体を省略する。
   */
  objectiveIds?: string[];
  model?: string;
  resolution?: "resolved" | "unclear";
}

/** AI 呼び出しの結果。失敗は例外ではなく値として表す。 */
export type AIResponse = { ok: true; answer: AIAnswer } | { ok: false; error: AIError };
