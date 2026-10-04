/**
 * `GET /v1/conversations/:id/learning-events`（Web/15 #233）。
 *
 * 質問履歴の詳細画面で「この会話でどの項目がどれだけ上がったか」を見せるための読み取り。
 * 会話の本文は扱わないので、質問履歴の保存設定に関わらず返せる。会話が保存されて
 * いなくても、同じ `sessionId` のイベントがあれば返す（無ければ空）。
 *
 * 対象のユーザーは `c.get("user").userId` だけから決める（routes/conversations.ts と同じ規律）。
 */

import { Hono } from "hono";
import {
  CONCEPT_BY_ID,
  deriveObjectiveChanges,
  MOCK_LEARNING_OBJECTIVES,
} from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import {
  CONVERSATION_LEARNING_EVENTS_RESPONSE_VERSION,
  type ConversationLearningEventView,
  type ConversationLearningEventsResponse,
} from "../contract/conversation-learning-events.js";
import type { LearningEventRepository } from "../repository/types.js";

export interface ConversationLearningEventsDeps {
  events: LearningEventRepository;
}

export type ConversationLearningEventsDepsResolver = (
  env: CloudflareBindings,
) => ConversationLearningEventsDeps;

const OBJECTIVE_LABEL_BY_ID = new Map(
  MOCK_LEARNING_OBJECTIVES.map((objective) => [objective.id, objective.label]),
);

export function createConversationLearningEventsRoute(
  resolve: ConversationLearningEventsDepsResolver,
) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  app.get("/conversations/:id/learning-events", async (c) => {
    const userId = c.get("user").userId;
    const conversationId = c.req.param("id");
    const deps = resolve(c.env);

    // 加算幅は過去のイベントに依存する（頭打ち・0 で止まる）ため、この会話の分だけでなく
    // 利用者の全イベントを畳み込む。項目一覧は learning-profile と同じモック（設計/05 #224）。
    const events = await deps.events.listByUser(userId);
    const changes = deriveObjectiveChanges(events, MOCK_LEARNING_OBJECTIVES);

    const views: ConversationLearningEventView[] = events
      .filter((event) => event.sessionId === conversationId)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
      .flatMap((event) => {
        // 項目に触れていないイベントは表示しない（#233 の決定）。
        const eventChanges = changes[event.id];
        if (eventChanges === undefined) {
          return [];
        }
        return [
          {
            id: event.id,
            type: event.type,
            occurredAt: event.occurredAt,
            changes: eventChanges.map((change) => {
              const conceptLabel = CONCEPT_BY_ID.get(change.conceptId)?.label;
              return {
                ...change,
                ...(conceptLabel === undefined ? {} : { conceptLabel }),
                // deriveObjectiveChanges は一覧に載る項目しか返さないので、ラベルは必ずある。
                // 万一引けなくても ID を出して、表示から項目を消さない。
                objectiveLabel: OBJECTIVE_LABEL_BY_ID.get(change.objectiveId) ?? change.objectiveId,
              };
            }),
          },
        ];
      });

    const body: ConversationLearningEventsResponse = {
      version: CONVERSATION_LEARNING_EVENTS_RESPONSE_VERSION,
      events: views,
    };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  return app;
}
