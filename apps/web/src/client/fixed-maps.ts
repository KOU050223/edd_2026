/**
 * 言語別マップの「理解すること」（Issue #245）。
 *
 * 項目は API の表にあり、`GET /v1/fixed-maps` でまとめて読む。その言語のマップの作成者だけが、
 * AI で作り直した案（`POST /v1/fixed-maps/:language/objectives:generate`）を確かめて手で直し、
 * Concept ごとに確定する（`PUT /v1/fixed-maps/:language/concepts/:conceptId/objectives`）。
 *
 * 契約は apps/api/src/contract/fixed-maps.ts。Web は API のパッケージを import しないので、
 * 使う形だけをここに写す。描画から切り離してあるのは、jsdom が無くても検証できるようにするため
 * （apps/web/AGENTS.md）。
 */

import type { LearningObjective } from "@gakushu-sochi/domain";
import { ApiError, requestJson, writeErrorOf } from "./api.js";

export const FIXED_MAPS_PATH = "/api/v1/fixed-maps";

/** API と同じ上限。入力欄の `maxLength` と保存前の確認に使う。 */
export const FIXED_OBJECTIVE_LIMITS = { label: 80, objectives: 8 } as const;

/**
 * 作り直しの締め切り（RULE-001）。API は Concept を数個ずつ並列に頼み、それぞれ上流を最大 150 秒待つ
 * （送り直しを含む）。そこへ中継の分を足す。
 */
export const FIXED_OBJECTIVES_GENERATE_TIMEOUT_MS = 180_000;

export type ObjectiveSource = "manual" | "ai";

/** 固定の Concept の「理解すること」の1項目。 */
export interface FixedObjectiveView {
  id: string;
  conceptId: string;
  label: string;
  source: ObjectiveSource;
}

export interface FixedMaps {
  objectives: FixedObjectiveView[];
  /** 自分が作成者になっている言語。編集の導線はこの言語にだけ出す。 */
  editableLanguages: string[];
}

/** 作り直しの案の1項目。 */
export type FixedObjectiveDraft =
  | { kind: "kept"; id: string; label: string; previousLabel: string }
  | { kind: "new"; label: string };

/** 1つの Concept の作り直しの案。 */
export interface FixedConceptDraft {
  conceptId: string;
  objectives: FixedObjectiveDraft[];
  removed: { id: string; label: string }[];
}

function isFixedObjective(value: unknown): value is FixedObjectiveView {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.conceptId === "string" &&
    typeof item.label === "string" &&
    (item.source === "manual" || item.source === "ai")
  );
}

/** 固定の項目の全件と、自分が編集できる言語を読む。形が契約と違えば失敗にする（RULE-004）。 */
export async function fetchFixedMaps(
  fetcher: typeof fetch = fetch,
  retry: boolean | number = false,
): Promise<FixedMaps> {
  const body = await requestJson<unknown>(FIXED_MAPS_PATH, fetcher, retry);
  const { objectives, editableLanguages } = (body ?? {}) as Record<string, unknown>;
  if (
    !Array.isArray(objectives) ||
    !objectives.every(isFixedObjective) ||
    !Array.isArray(editableLanguages) ||
    !editableLanguages.every((language) => typeof language === "string")
  ) {
    throw new ApiError("unavailable");
  }
  return { objectives, editableLanguages };
}

/** Concept ID → 項目（保存した順）。画面の詳細と確認問題の対象に使う。 */
export function objectivesByConcept(
  objectives: readonly FixedObjectiveView[],
): ReadonlyMap<string, LearningObjective[]> {
  const grouped = new Map<string, LearningObjective[]>();
  for (const { id, conceptId, label } of objectives) {
    grouped.set(conceptId, [...(grouped.get(conceptId) ?? []), { id, conceptId, label }]);
  }
  return grouped;
}

// --- 編集 ---------------------------------------------------------------------

/**
 * 編集中の1項目。
 *
 * `id` はどの今の項目を引き継ぐか（無ければ新しい項目）。作り直しの案の対応が違えば、作成者が
 * 手で付け替える（決定 N6）。`fromAi` は AI の案をそのまま使っているか。表示名を書き換えたら外す。
 */
export interface FixedObjectiveItem {
  id?: string;
  label: string;
  fromAi: boolean;
  /** AI が引き継いだ今の項目の表示名。書き換わったことを画面に示す。 */
  previousLabel?: string;
}

export function itemsFromSaved(saved: readonly FixedObjectiveView[]): FixedObjectiveItem[] {
  return saved.map(({ id, label }) => ({ id, label, fromAi: false }));
}

/** 作り直しの案を、編集中の項目にする。 */
export function itemsFromDraft(draft: FixedConceptDraft): FixedObjectiveItem[] {
  return draft.objectives.map((objective) =>
    objective.kind === "kept"
      ? {
          id: objective.id,
          label: objective.label,
          fromAi: true,
          ...(objective.label === objective.previousLabel
            ? {}
            : { previousLabel: objective.previousLabel }),
        }
      : { label: objective.label, fromAi: true },
  );
}

/** 表示名を書き換える。AI の案から離れるので、出どころは手書きになる。 */
export function relabel(item: FixedObjectiveItem, label: string): FixedObjectiveItem {
  return { ...item, label, fromAi: false };
}

/**
 * どの今の項目を引き継ぐかを付け替える（`undefined` なら新しい項目）。AI が示した前の表示名は、
 * 対応が変わると当てはまらないので外す。表示名と出どころはそのまま。
 */
export function reassign(item: FixedObjectiveItem, id: string | undefined): FixedObjectiveItem {
  return {
    label: item.label,
    fromAi: item.fromAi,
    ...(id === undefined ? {} : { id }),
  };
}

/** 確定すると消える今の項目。その項目を狙った確認問題も、全利用者の分が消える。 */
export function removedOnSave<T extends { id: string }>(
  saved: readonly T[],
  items: readonly FixedObjectiveItem[],
): T[] {
  return saved.filter((objective) => !items.some((item) => item.id === objective.id));
}

/** 確定と保存済みが違うか（前後の空白は数えない）。 */
export function itemsChanged(
  saved: readonly FixedObjectiveView[],
  items: readonly FixedObjectiveItem[],
): boolean {
  return (
    JSON.stringify(items.map((item) => [item.id ?? null, item.label.trim()])) !==
    JSON.stringify(saved.map((item) => [item.id, item.label]))
  );
}

/** 確定できない理由。空なら確定できる。 */
export function itemProblems(items: readonly FixedObjectiveItem[]): string[] {
  const problems: string[] = [];
  if (items.length === 0) {
    problems.push("言語別マップの Concept には、項目が1つ以上要ります。");
  }
  if (items.some((item) => item.label.trim() === "")) {
    problems.push("空の項目があります。入力するか外してください。");
  }
  if (items.some((item) => item.label.trim().length > FIXED_OBJECTIVE_LIMITS.label)) {
    problems.push(`項目は ${String(FIXED_OBJECTIVE_LIMITS.label)} 文字までです。`);
  }
  if (items.length > FIXED_OBJECTIVE_LIMITS.objectives) {
    problems.push(`項目は ${String(FIXED_OBJECTIVE_LIMITS.objectives)} 個までです。`);
  }
  const ids = items.flatMap((item) => (item.id === undefined ? [] : [item.id]));
  if (new Set(ids).size !== ids.length) {
    problems.push("同じ今の項目を、2つの項目に引き継がせています。");
  }
  return problems;
}

/** `PUT .../objectives` の本文。新しい項目は `id` を省き、AI の案のままなら出どころを `ai` にする。 */
export function toSaveRequest(items: readonly FixedObjectiveItem[]): {
  objectives: { id?: string; label: string; source?: ObjectiveSource }[];
} {
  return {
    objectives: items.map((item) => ({
      ...(item.id === undefined ? {} : { id: item.id }),
      label: item.label.trim(),
      ...(item.fromAi ? { source: "ai" as const } : {}),
    })),
  };
}

// --- 送信 ---------------------------------------------------------------------

/** 作り直し・確定に失敗した理由を、API が利用者向けの文で返したもの。文面をそのまま出す。 */
export class FixedObjectivesError extends ApiError {
  constructor(readonly detail: string) {
    super("unavailable");
  }
}

async function send(
  method: "POST" | "PUT",
  path: string,
  payload: unknown,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError("unavailable");
  }
  if (!response.ok) {
    // 読めない本文は空として扱い、状態コードで分ける。
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const common = writeErrorOf(response.status, body);
    // 送信の同意（Worker）やログインの失敗は、共通の種別へ分ける。
    if (common.kind !== "unavailable" && common.kind !== "rate_limited") throw common;
    if (response.status === 403) {
      throw new FixedObjectivesError("この言語のマップの作成者だけが編集できます。");
    }
    // 生成の失敗・回数の上限は `message`、入力の誤り（400）は `error` に文がある。
    const detail = typeof body.message === "string" ? body.message : body.error;
    if (typeof detail === "string" && detail.length > 0) throw new FixedObjectivesError(detail);
    throw common;
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    // 2xx でも本文が読めなければ失敗として扱う（RULE-004）。
    throw new ApiError("unavailable");
  }
}

function isDraft(value: unknown): value is FixedConceptDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.conceptId === "string" &&
    Array.isArray(draft.objectives) &&
    draft.objectives.every((objective: unknown) => {
      const item = objective as Record<string, unknown> | null;
      if (item === null || typeof item !== "object" || typeof item.label !== "string") {
        return false;
      }
      return item.kind === "new"
        ? true
        : item.kind === "kept" &&
            typeof item.id === "string" &&
            typeof item.previousLabel === "string";
    }) &&
    Array.isArray(draft.removed) &&
    draft.removed.every(
      (removed: unknown) =>
        typeof (removed as { id?: unknown } | null)?.id === "string" &&
        typeof (removed as { label?: unknown }).label === "string",
    )
  );
}

/** AI で作り直した案を受け取る。**保存しない。** `conceptIds` を省くと言語の全 Concept。 */
export async function generateFixedObjectives(
  language: string,
  conceptIds: readonly string[] | undefined,
  fetcher: typeof fetch = fetch,
): Promise<FixedConceptDraft[]> {
  const body = await send(
    "POST",
    `${FIXED_MAPS_PATH}/${encodeURIComponent(language)}/objectives:generate`,
    conceptIds === undefined ? {} : { conceptIds },
    fetcher,
    FIXED_OBJECTIVES_GENERATE_TIMEOUT_MS,
  );
  const concepts = (body as { concepts?: unknown } | null)?.concepts;
  if (!Array.isArray(concepts) || !concepts.every(isDraft)) throw new ApiError("unavailable");
  return concepts;
}

/** 1つの Concept の項目を確定する。保存後の一覧を返す。 */
export async function saveFixedObjectives(
  language: string,
  conceptId: string,
  items: readonly FixedObjectiveItem[],
  fetcher: typeof fetch = fetch,
): Promise<FixedObjectiveView[]> {
  const body = await send(
    "PUT",
    `${FIXED_MAPS_PATH}/${encodeURIComponent(language)}/concepts/${encodeURIComponent(conceptId)}/objectives`,
    toSaveRequest(items),
    fetcher,
    10_000,
  );
  const objectives = (body as { objectives?: unknown } | null)?.objectives;
  if (
    !Array.isArray(objectives) ||
    !objectives.every((objective: unknown) =>
      isFixedObjective({ ...(objective as object), conceptId }),
    )
  ) {
    throw new ApiError("unavailable");
  }
  return (objectives as Omit<FixedObjectiveView, "conceptId">[]).map((objective) => ({
    ...objective,
    conceptId,
  }));
}
