/**
 * AI の回答へ載せる「利用者の学習の現在地」の組み立て（Issue #216）。
 *
 * docs/architecture.md の方針は「長期履歴を AI へそのまま渡さない。現在の質問に
 * 関係する Concept と、再発状況などの最小限の ProfileSummary を作る」。
 * このモジュールは {@link ProfileSummary} をプロンプト向けの行へ変換する。
 *
 * VS Code 拡張（`apps/vscode-extension/src/ai/prompt`）と Managed AI
 * （`apps/api/src/routes/ai.ts`）の両方が使うため、文面はここを正本とする。
 */

import type { ProfileSummary } from "./ai.js";
import { CONCEPTS } from "./concepts.generated.js";
import {
  RECURRENCE_WINDOW_MS,
  type Concept,
  type ConceptId,
  type ConceptMastery,
  type LearningEvent,
} from "./profile.js";

/**
 * 1つのグループへ載せる Concept の既定の上限。超えた分は「ほか N 件」で
 * 丸める。呼び出し側は入力枠が残り少ないときに `groupLimit` を小さくして
 * さらに絞れる。
 */
export const LEARNER_POSITION_GROUP_LIMIT = 15;

/**
 * 時間窓の内に `error_recurred` が観測された Concept を、重複なく昇順で返す。
 *
 * 再発の検知そのものではなく、記録済みの再発イベントからの読み出し。
 * `ProfileSummary.recurringConceptIds` を埋めるために使う。
 */
export function recentlyRecurredConceptIds(
  events: readonly LearningEvent[],
  nowMs: number,
): ConceptId[] {
  const ids = new Set<ConceptId>();
  for (const event of events) {
    if (event.type !== "error_recurred") {
      continue;
    }
    const at = Date.parse(event.occurredAt);
    // 壊れた時刻は再発の有無を誤る。握りつぶさず例外にする（RULE-004）。
    if (Number.isNaN(at)) {
      throw new RangeError(`occurredAt を時刻として解釈できません: ${event.occurredAt}`);
    }
    const elapsed = nowMs - at;
    if (elapsed >= 0 && elapsed <= RECURRENCE_WINDOW_MS) {
      for (const conceptId of event.conceptIds) {
        ids.add(conceptId);
      }
    }
  }
  return [...ids].sort();
}

function byScoreDesc(a: ConceptMastery, b: ConceptMastery): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  return a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0;
}

/**
 * プロンプトへ差し込む「利用者の学習の現在地」セクションの行を返す。
 * 載せるものが1つも無いときは空配列（セクション自体を出さない）。
 *
 * `unobserved` の Concept はどの行にも載らない。「習熟度が低い」ではなく
 * 「判断材料がない」であり、AI へ伝えると勝手に初級者扱いされるため、
 * 末尾の一文で「載っていない = 未観測」として扱わせる。ただし件数の上限で
 * 観測済みの Concept を省いたときは、その旨も併記する（断定できないため）。
 */
export function buildLearnerPositionLines(
  position: ProfileSummary,
  concepts: readonly Concept[] = CONCEPTS,
  groupLimit = LEARNER_POSITION_GROUP_LIMIT,
): string[] {
  const labelById = new Map(concepts.map((concept) => [concept.id, concept.label]));
  const labelOf = (conceptId: ConceptId): string => labelById.get(conceptId) ?? conceptId;

  // 上限を超えて省いた Concept があるか。フッタの文面を分けるために追う。
  let truncated = false;
  const joinLabels = (labels: readonly string[]): string => {
    const shown = labels.slice(0, groupLimit);
    const rest = labels.length - shown.length;
    if (rest > 0) truncated = true;
    return rest > 0 ? `${shown.join(" / ")}、他 ${String(rest)} 件` : shown.join(" / ");
  };

  const confirmed: string[] = [];
  const learning: string[] = [];
  for (const mastery of [...(position.masteries ?? [])].sort(byScoreDesc)) {
    const entry = `${labelOf(mastery.conceptId)}（${String(Math.round(mastery.score * 100))}%）`;
    if (mastery.status === "confirmed") {
      confirmed.push(entry);
    } else if (mastery.status === "learning") {
      learning.push(entry);
    }
  }

  const recurring = [...new Set(position.recurringConceptIds ?? [])].sort().map(labelOf);

  const familiar = [...(position.familiarity ?? [])]
    .sort((a, b) => {
      if (a.observationCount !== b.observationCount) {
        return b.observationCount - a.observationCount;
      }
      return a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0;
    })
    .map((item) => labelOf(item.conceptId));

  if (
    confirmed.length === 0 &&
    learning.length === 0 &&
    recurring.length === 0 &&
    familiar.length === 0
  ) {
    return [];
  }

  const lines = [
    "--- 利用者の学習の現在地 ---",
    "次はこの利用者の学習マップの要約です。説明の深さと、前提とする知識をこれに合わせてください。",
    "この値を利用者へ引用したり、点数として見せたりしないでください。",
  ];
  if (confirmed.length > 0) {
    lines.push(`確認済み（説明を省略してよい前提知識）: ${joinLabels(confirmed)}`);
  }
  if (learning.length > 0) {
    lines.push(`学習中（基礎を確かめながら説明する範囲）: ${joinLabels(learning)}`);
  }
  if (recurring.length > 0) {
    lines.push(`繰り返しつまずいている（最近同じエラーが再発した）: ${joinLabels(recurring)}`);
  }
  if (familiar.length > 0) {
    lines.push(
      `過去に他の手段で触れた形跡がある（学習の記録では確認していない）: ${joinLabels(familiar)}`,
    );
  }
  // 丸めで省いた Concept は観測済みかもしれない。「挙がっていない = 未観測」と
  // 断定できるのは、どのグループも丸めていないときだけ。
  lines.push(
    truncated
      ? "ここに挙がっていない概念は、未観測か要約の上限で省略されています。知っている前提で説明を省略せず、確認しながら説明してください。"
      : "ここに挙がっていない概念は「未観測」です。知っている前提で説明を省略せず、確認しながら説明してください。",
  );
  return lines;
}
