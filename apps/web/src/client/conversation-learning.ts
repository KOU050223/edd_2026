/**
 * 質問履歴の1件で動いた「理解すること」（Web/15 #233）。
 *
 * 契約の正本は `apps/api/src/contract/conversation-learning-events.ts`。ここでは再定義せず、
 * 応答の形だけを検証する。2xx でも形が違えば失敗として扱う（RULE-004）。
 */

import type { LearningEventType } from "@gakushu-sochi/domain";
import { ApiError, requestJson } from "./api.js";
import { CONVERSATIONS_PATH } from "./conversations.js";

/** `ObjectiveChangeView` と対応。 */
export interface ObjectiveChange {
  conceptId: string;
  conceptLabel?: string;
  objectiveId: string;
  objectiveLabel: string;
  before: number;
  after: number;
}

/** `ConversationLearningEventView` と対応。 */
export interface ConversationLearningEvent {
  id: string;
  type: LearningEventType;
  occurredAt: string;
  changes: ObjectiveChange[];
}

const EVENT_TYPE_LABEL: Record<LearningEventType, string> = {
  question_asked: "質問した",
  answer_viewed: "回答を見た",
  solved_independently: "自力で解決した",
  error_recurred: "同じエラーが再発した",
  check_passed: "確認問題に全問正解した",
  check_failed: "確認問題に不正解だった",
};

function isObjectiveChange(value: unknown): value is ObjectiveChange {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Record<string, unknown>;
  return (
    typeof change.conceptId === "string" &&
    (change.conceptLabel === undefined || typeof change.conceptLabel === "string") &&
    typeof change.objectiveId === "string" &&
    typeof change.objectiveLabel === "string" &&
    typeof change.before === "number" &&
    typeof change.after === "number"
  );
}

function isConversationLearningEvent(value: unknown): value is ConversationLearningEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.type === "string" &&
    Object.hasOwn(EVENT_TYPE_LABEL, event.type) &&
    typeof event.occurredAt === "string" &&
    Array.isArray(event.changes) &&
    event.changes.every(isObjectiveChange)
  );
}

/** その会話で項目を動かした学習イベントを、発生時刻順に取る。 */
export async function fetchConversationLearningEvents(
  fetcher: typeof fetch,
  sessionRetries: number,
  conversationId: string,
): Promise<ConversationLearningEvent[]> {
  const body = await requestJson<unknown>(
    `${CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/learning-events`,
    fetcher,
    sessionRetries,
  );
  if (typeof body !== "object" || body === null) throw new ApiError("unavailable");
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events) || !events.every(isConversationLearningEvent)) {
    throw new ApiError("unavailable");
  }
  return events;
}

export function eventTypeLabel(type: LearningEventType): string {
  return EVENT_TYPE_LABEL[type];
}

/**
 * 加算幅の表示。`+0.05` / `−0.25` / `±0`。
 * 値は 0.01 単位で持つ（docs/concepts.md）ので小数2桁で出す。差は浮動小数の誤差を丸めてから見る。
 */
export function formatObjectiveDelta(change: Pick<ObjectiveChange, "before" | "after">): string {
  const hundredths = Math.round((change.after - change.before) * 100);
  if (hundredths === 0) return "±0";
  const magnitude = (Math.abs(hundredths) / 100).toFixed(2);
  return hundredths > 0 ? `+${magnitude}` : `−${magnitude}`;
}

/** 1件のイベントの変化を Concept ごとにまとめる（表示の並びは届いた順のまま）。 */
export function groupChangesByConcept(
  changes: readonly ObjectiveChange[],
): { conceptId: string; conceptLabel: string; changes: ObjectiveChange[] }[] {
  const groups = new Map<
    string,
    { conceptId: string; conceptLabel: string; changes: ObjectiveChange[] }
  >();
  for (const change of changes) {
    const group = groups.get(change.conceptId) ?? {
      conceptId: change.conceptId,
      conceptLabel: change.conceptLabel ?? change.conceptId,
      changes: [],
    };
    group.changes.push(change);
    groups.set(change.conceptId, group);
  }
  return [...groups.values()];
}
