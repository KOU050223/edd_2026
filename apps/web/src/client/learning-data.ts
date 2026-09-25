/**
 * 学習データのエクスポートと削除（Issue #173）。
 *
 * Web は学習データのコピーを持たない（docs/data-privacy.md「クライアント側に残る
 * コピー」）ため、ここでの操作はサーバー呼び出しに閉じる。取得した
 * `LearnerProfile` はダウンロードへ流すだけで、localStorage などへ残さない。
 *
 * 描画から切り離してあるのは、jsdom が無くても検証できるようにするため
 * （apps/web/AGENTS.md）。
 */

import type { LearnerProfile } from "@gakushu-sochi/domain";
import { ApiError, deleteJson, requestJson } from "./api.js";

export const LEARNING_DATA_EXPORT_PATH = "/api/v1/learning-events:export";
export const LEARNING_DATA_DELETE_PATH = "/api/v1/learning-events";

/**
 * 応答が `LearnerProfile` の形かを確かめる。2xx でも中身が違えば失敗として扱う
 * （RULE-004）。エクスポートは利用者が手元へ保管するものなので、version は
 * 現在値に縛らず数値であることだけを見る。サーバー側で版が上がっても、
 * 新しい形式のまま受け取れる方が利用者のデータを失わない。
 */
export function isLearnerProfileShape(value: unknown): value is LearnerProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Partial<LearnerProfile>;
  return (
    typeof profile.version === "number" &&
    Array.isArray(profile.events) &&
    typeof profile.mastery === "object" &&
    profile.mastery !== null
  );
}

/**
 * 学習データを `LearnerProfile` の形で取得する。
 *
 * 2xx でも中身が契約どおりでなければ失敗として扱う（RULE-004）。
 */
export async function fetchLearningDataExport(
  fetcher: typeof fetch,
  sessionRetries: number,
): Promise<LearnerProfile> {
  const profile = await requestJson<unknown>(LEARNING_DATA_EXPORT_PATH, fetcher, sessionRetries);
  if (!isLearnerProfileShape(profile)) throw new ApiError("unavailable");
  return profile;
}

/**
 * `DELETE /v1/learning-events` の応答
 * （apps/api/src/routes/learning-data.ts の `DeleteLearningEventsResponse` と対応）。
 */
export interface DeleteLearningDataResult {
  /** 消したイベントの件数。既に空なら 0。 */
  deletedCount: number;
  /** `learning_history_resets` へ記録された削除時刻（epoch ミリ秒）。 */
  resetAtMs: number;
}

function toDeleteResult(value: unknown): DeleteLearningDataResult | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Partial<DeleteLearningDataResult>;
  if (typeof body.deletedCount !== "number" || typeof body.resetAtMs !== "number") return null;
  return { deletedCount: body.deletedCount, resetAtMs: body.resetAtMs };
}

/**
 * サーバー側の学習イベントを全件削除する。
 *
 * 2xx でも応答の形が契約と違えば失敗として扱う（RULE-004）。削除は冪等なので、
 * 失敗と返った場合は利用者がもう一度実行してよい。
 */
export async function deleteLearningData(fetcher: typeof fetch): Promise<DeleteLearningDataResult> {
  const body = await deleteJson<unknown>(LEARNING_DATA_DELETE_PATH, fetcher);
  const result = toDeleteResult(body);
  if (!result) throw new ApiError("unavailable");
  return result;
}

/**
 * ダウンロード用のファイル名。日付は UTC で切る。
 *
 * 同日に2回取ってもブラウザが連番を付けるため、日付までで十分である。
 */
export function exportFileName(now: Date): string {
  return `gakushu-sochi-learning-data-${now.toISOString().slice(0, 10)}.json`;
}
