/**
 * 確認問題の正誤を学習イベントとして API へ記録する（Issue #77）。
 *
 * 習熟度の正本は API Server が学習イベントから導出する（docs/architecture.md）。
 * Web は正誤を確定・保存せず、既存の `POST /v1/learning-events:sync` へ
 * `check_passed` / `check_failed` を1件送るだけにする。**KV は使わない。**
 *
 * 送るのは Concept と正誤だけで、利用者の回答内容（選んだ選択肢）は送らない（#43）。
 * 契約側も `strictObject` で未知のキーを拒否する（apps/api/src/contract/learning-event.ts）。
 *
 * 描画から切り離してあるのは、jsdom が無くても検証できるようにするため
 * （apps/web/AGENTS.md）。
 */

import {
  CHECK_QUESTION_KINDS,
  type CheckQuestionKind,
  type ConceptId,
  type LearningEvent,
} from "@gakushu-sochi/domain";
import { ApiError, postJsonBody } from "./api.js";

export const LEARNING_EVENTS_SYNC_PATH = "/api/v1/learning-events:sync";

/**
 * 同期エンベロープの `clientId`。
 *
 * `clientId` は端末の自己申告で、認証済みの利用者とは別物である
 * （migrations/0001_initial.sql の `devices`）。Web はブラウザに学習データも
 * 識別子も残さない（docs/data-privacy.md「クライアント側に残るコピー」）ため、
 * ブラウザごとに採番せず固定値にする。同じ利用者の Web からの記録は1端末にまとまる。
 */
export const WEB_CLIENT_ID = "web";

/** 各問の正誤。キーを種別で固定し、1問だけの採点結果を型で作れないようにする。 */
export type CheckCorrectness = Readonly<Record<CheckQuestionKind, boolean>>;

/**
 * 2問の正誤から記録するイベントを組み立てる。
 *
 * **2問とも正解のときだけ** `check_passed`、どちらか不正解なら `check_failed`（#43）。
 * 再送しても二重に数えられないよう、呼び出し側は同じイベント（同じ `id`）を持ち回して
 * 送り直す。`id` を引数で受けるのはそのためである。
 */
export function checkResultEvent(input: {
  conceptId: ConceptId;
  correct: CheckCorrectness;
  id: string;
  now: Date;
}): LearningEvent {
  const passed = CHECK_QUESTION_KINDS.every((kind) => input.correct[kind]);
  return {
    id: input.id,
    // `toISOString` は常に `Z` 付きで、契約の `isIsoDateTime`（オフセット必須）を満たす。
    occurredAt: input.now.toISOString(),
    type: passed ? "check_passed" : "check_failed",
    origin: "web",
    conceptIds: [input.conceptId],
  };
}

/** 記録できた結果。`duplicate` は同じイベントを送り直した場合で、記録済みとして扱ってよい。 */
export type CheckResultRecordStatus = "accepted" | "duplicate";

/**
 * 同期応答のうち、1件だけ送ったときの結果を取り出す。
 * 形が契約と違えば `null`（RULE-004: 2xx でも中身が違えば失敗）。
 */
function singleResult(body: unknown, eventId: string): { status: string; reason?: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length !== 1) return null;
  const result = results[0] as {
    index?: unknown;
    id?: unknown;
    status?: unknown;
    reason?: unknown;
  };
  if (typeof result !== "object" || result === null) return null;
  if (result.index !== 0 || result.id !== eventId || typeof result.status !== "string") {
    return null;
  }
  return {
    status: result.status,
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
  };
}

/**
 * 確認問題の正誤を1件送る。
 *
 * 失敗は `ApiError` で投げる。**回答操作（解説の表示や次の Concept への移動）は
 * この結果を待って止めてはならない**（#77）。呼び出し側は失敗を利用者へ伝え、
 * 同じイベントのまま再送できるようにする。再送は `duplicate` として受理される。
 *
 * サーバーが `rejected` を返したのは送信側の不具合なので、再送しても直らない。
 * 理由をログへ残したうえで失敗として扱う。
 */
export async function recordCheckResult(
  event: LearningEvent,
  fetcher: typeof fetch = fetch,
): Promise<CheckResultRecordStatus> {
  const body = await postJsonBody<unknown>(
    LEARNING_EVENTS_SYNC_PATH,
    { clientId: WEB_CLIENT_ID, events: [event] },
    fetcher,
  );
  const result = singleResult(body, event.id);
  if (result === null) throw new ApiError("unavailable");
  if (result.status === "accepted" || result.status === "duplicate") return result.status;
  console.error("check result was rejected by the API", {
    eventId: event.id,
    status: result.status,
    reason: result.reason,
  });
  throw new ApiError("unavailable");
}
