/**
 * 学習マップの共有と版（Issue #244 / Web/20）の読み書きと、表示用の文面。
 *
 * 持ち主の手元のマップと共有の版を分ける（決定 T1-a）。持ち主は確認画面（S1-a）で
 * 出ていく中身を見てから「共有へ上げる」と新しい版になり、持ち主以外はいちばん新しい版を読む。
 *
 * 契約は apps/api/src/contract/learning-maps.ts。Web は API のパッケージを import しないので、
 * 使う形だけをここに写す（learning-maps.ts と同じ）。
 */

import type { PersonalConceptCheck } from "@gakushu-sochi/domain";
import { ApiError, requestJson, writeErrorOf } from "./api.js";
import {
  LEARNING_MAPS_PATH,
  type LearningMapView,
  type MapSourceView,
  type LearningMapNodeView,
  type LearningMapVisibility,
  type ShareScope,
} from "./learning-maps.js";

export const SHARED_MAPS_PATH = "/api/v1/shared-maps";

export const VISIBILITY_LABELS: Readonly<Record<LearningMapVisibility, string>> = {
  private: "非公開（自分だけ）",
  link: "リンクを知っている人だけ",
  public: "全員（共有マップの一覧に出す）",
};

/** 一覧などに添える短い表示。非公開は何も出さない。 */
export const VISIBILITY_BADGES: Readonly<Record<ShareScope, string>> = {
  link: "リンクで共有中",
  public: "全員に共有中",
};

/** 版の中身を表示する形。ノードは手元のマップと同じ形。 */
export interface SharedMapContentView {
  title: string;
  description: string;
  nodes: LearningMapNodeView[];
  edges: { from: string; to: string }[];
  checks: PersonalConceptCheck[];
}

export type MapNodeChangeField = "kind" | "label" | "summary" | "prerequisite" | "objectives";

export interface MapNodeChange {
  conceptId: string;
  fields: MapNodeChangeField[];
  before: LearningMapNodeView;
  after: LearningMapNodeView;
  prerequisiteBefore: string | null;
  prerequisiteAfter: string | null;
}

export interface LearningMapDiff {
  title: { before: string; after: string } | null;
  description: { before: string; after: string } | null;
  added: LearningMapNodeView[];
  removed: LearningMapNodeView[];
  changed: MapNodeChange[];
  /** 両方にあるノードの並び（学習の順）が変わったか。 */
  reordered: boolean;
  checks: { added: PersonalConceptCheck[]; removed: PersonalConceptCheck[] };
}

export interface MapVersionSummary {
  added: number;
  removed: number;
  changed: number;
  titleChanged: boolean;
  reordered: boolean;
  checksAdded: number;
  checksRemoved: number;
}

export interface MapVersionMeta {
  version: number;
  createdAt: string;
  authorUserId: string;
  restoredFrom: number | null;
  checksIncluded: boolean;
  summary: MapVersionSummary;
}

/** 確認画面（`GET .../versions:preview`）。 */
export interface MapPublishPreview {
  visibility: LearningMapVisibility;
  latest: MapVersionMeta | null;
  includeChecks: boolean;
  availableChecks: number;
  content: SharedMapContentView;
  diff: LearningMapDiff;
  hasChanges: boolean;
  contentHash: string;
}

export interface SharedMapSummary {
  id: string;
  title: string;
  description: string;
  nodeCount: number;
  version: number;
  publishedAt: string;
}

/**
 * 自分が共有しているマップの1件（`GET /v1/learning-maps:shared`、#302）。
 * 題名・説明・ノード数は共有の版のもの（手元で直してまだ上げていない題名ではない）。
 */
export interface OwnSharedMapSummary extends SharedMapSummary {
  visibility: ShareScope;
}

/** 共有の側のいちばん新しい版（`GET /v1/shared-maps/:id`）。 */
export interface SharedMapView {
  id: string;
  visibility: ShareScope;
  version: number;
  publishedAt: string;
  isOwner: boolean;
  title: string;
  description: string;
  nodes: LearningMapNodeView[];
  edges: { from: string; to: string }[];
  checkCount: number;
  /** フォークなら、もとにしたマップ（#246 の V3-a）。`mapId` は元が全員に共有されているときだけ。 */
  forkedFrom?: { title: string; mapId: string | null };
}

/**
 * 共有の操作の衝突（409）。`code` は API の定型文。
 *
 * - `content_changed`: 確認画面を開いたあとに手元のマップが変わった
 * - `version_conflict`: 確認画面（履歴）を開いたあとに、別の画面で版が増えた
 * - `no_changes`: 前の版と中身が同じ
 * - `not_published`: まだ一度も共有へ上げていない
 * - `already_latest`: いちばん新しい版は復元できない
 */
export class ShareConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** 衝突の理由を、利用者が次にすることが分かる文にする。 */
export function shareConflictText(error: ShareConflictError): string {
  switch (error.code) {
    case "content_changed":
      return "確認のあとにマップが変わりました。変わった中身を表示し直したので、もう一度確かめてください。";
    case "version_conflict":
      return "別の画面で版が増えたか、手元のマップが直されました。表示し直したので、もう一度確かめてください。";
    case "no_changes":
      return "前の版から中身が変わっていないので、新しい版は作りません。";
    case "not_published":
      return "まだ共有へ上げていません。先に中身を確かめて共有してください。";
    case "already_latest":
      return "いちばん新しい版は復元できません。";
    case "own_map":
      return "自分のマップは取り込めません。";
    case "already_imported":
    case "already_imported_or_limit":
      return "このマップはもう取り込んでいます（または自分のマップが上限に達しています）。自分のマップの一覧から開いてください。";
    case "learning_map_limit_reached":
      return "自分のマップが上限に達しています。使っていないマップを消してから取り込んでください。";
    case "concept_conflict":
      return "同じノードを持つマップをすでに取り込んでいるので、取り込めません。";
    case "source_unavailable":
      return "取り込み元のマップが読めなくなりました（削除・共有の停止・リンクの変更）。今の個人マップはそのまま使えます。";
    case "too_many_nodes":
      return "残すノードが多すぎて、マップのノード数の上限を超えます。残すノードを減らしてください。";
    default:
      return `共有の操作を受け付けられませんでした（${error.code}）。`;
  }
}

function mapPath(mapId: string): string {
  return `${LEARNING_MAPS_PATH}/${encodeURIComponent(mapId)}`;
}

/**
 * 共有の書き込み。409 の本文を読んで {@link ShareConflictError} に分ける。
 * それ以外は既存の書き込みと同じ規則（`writeErrorOf`）で分ける。
 */
async function sendShareRequest<T>(
  method: "POST" | "PUT",
  path: string,
  payload: unknown,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<T> {
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
    // API の 4xx は Worker の onError で `{ error }` の JSON になる。読めなければ空として扱う。
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (response.status === 409 && typeof body.error === "string") {
      throw new ShareConflictError(body.error);
    }
    throw writeErrorOf(response.status, body);
  }
  try {
    return (await response.json()) as T;
  } catch {
    // 2xx でも本文が読めなければ失敗として扱う（RULE-004）。
    throw new ApiError("unavailable");
  }
}

/** 確認画面の中身。`includeChecks` を省くと、前の版で選んだもの（初めてなら含める）。 */
export function fetchPublishPreview(
  mapId: string,
  includeChecks?: boolean,
  fetcher: typeof fetch = fetch,
  retry: boolean | number = false,
): Promise<MapPublishPreview> {
  const query = includeChecks === undefined ? "" : `?includeChecks=${String(includeChecks)}`;
  return requestJson(`${mapPath(mapId)}/versions:preview${query}`, fetcher, retry);
}

/** 確認画面で見た中身（`contentHash`）を共有へ上げ、新しい版にする。 */
export function publishLearningMap(
  mapId: string,
  input: {
    visibility: ShareScope;
    includeChecks: boolean;
    baseVersion: number | null;
    contentHash: string;
  },
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ version: MapVersionMeta; visibility: LearningMapVisibility }> {
  return sendShareRequest("POST", `${mapPath(mapId)}/versions`, input, fetcher, timeoutMs);
}

/** 共有の範囲だけを変える（版は作らない）。`private` で共有をやめる。 */
export function setMapVisibility(
  mapId: string,
  visibility: LearningMapVisibility,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ visibility: LearningMapVisibility }> {
  return sendShareRequest(
    "PUT",
    `${mapPath(mapId)}/visibility`,
    { visibility },
    fetcher,
    timeoutMs,
  );
}

export function fetchMapVersions(
  mapId: string,
  fetcher: typeof fetch = fetch,
  retry: boolean | number = false,
): Promise<{ versions: MapVersionMeta[] }> {
  return requestJson(`${mapPath(mapId)}/versions`, fetcher, retry);
}

export function fetchMapVersion(
  mapId: string,
  version: number,
  fetcher: typeof fetch = fetch,
): Promise<{ version: MapVersionMeta; content: SharedMapContentView }> {
  return requestJson(`${mapPath(mapId)}/versions/${String(version)}`, fetcher);
}

/** 過去の版の中身で新しい版を作り、手元のマップもその中身に戻す。 */
export function restoreMapVersion(
  mapId: string,
  version: number,
  baseVersion: number,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ version: MapVersionMeta; visibility: LearningMapVisibility }> {
  return sendShareRequest(
    "POST",
    `${mapPath(mapId)}/versions/${String(version)}/restore`,
    { baseVersion },
    fetcher,
    timeoutMs,
  );
}

/** 自分が共有しているマップ。新しく上げた順（#302）。 */
export function fetchOwnSharedMaps(
  fetcher: typeof fetch = fetch,
  retry: boolean | number = false,
): Promise<{ maps: OwnSharedMapSummary[] }> {
  return requestJson(`${LEARNING_MAPS_PATH}:shared`, fetcher, retry);
}

export function fetchSharedMaps(
  fetcher: typeof fetch = fetch,
  retry: boolean | number = false,
): Promise<{ maps: SharedMapSummary[] }> {
  return requestJson(SHARED_MAPS_PATH, fetcher, retry);
}

/** 共有の側の版。「リンクだけ」のマップは鍵が要る（決定 U1）。 */
export function fetchSharedMap(
  mapId: string,
  key?: string,
  fetcher: typeof fetch = fetch,
  retry: boolean | number = false,
): Promise<SharedMapView> {
  const query = key === undefined ? "" : `?key=${encodeURIComponent(key)}`;
  return requestJson(`${SHARED_MAPS_PATH}/${encodeURIComponent(mapId)}${query}`, fetcher, retry);
}

/** 「リンクだけ」の共有のリンク。`origin` は画面の origin（`window.location.origin`）。 */
export function shareLinkOf(origin: string, mapId: string, shareKey: string): string {
  return `${origin}/maps/${encodeURIComponent(mapId)}?key=${encodeURIComponent(shareKey)}`;
}

/** 履歴の1行に添える要約。何も変わっていなければ「変更なし」。 */
export function describeSummary(summary: MapVersionSummary): string {
  const parts = [
    summary.titleChanged ? "題名・説明" : undefined,
    summary.added > 0 ? `${String(summary.added)} ノードを追加` : undefined,
    summary.removed > 0 ? `${String(summary.removed)} ノードを削除` : undefined,
    summary.changed > 0 ? `${String(summary.changed)} ノードを変更` : undefined,
    summary.reordered ? "並びを変更" : undefined,
    summary.checksAdded + summary.checksRemoved > 0
      ? `確認問題 +${String(summary.checksAdded)} / −${String(summary.checksRemoved)}`
      : undefined,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? "変更なし" : parts.join("・");
}

const FIELD_LABELS: Readonly<Record<MapNodeChangeField, string>> = {
  kind: "参照かどうか",
  label: "表示名",
  summary: "概要",
  prerequisite: "前提",
  objectives: "理解すること",
};

/** 変わったところの一覧（「表示名・概要」など）。 */
export function describeChangedFields(fields: readonly MapNodeChangeField[]): string {
  return fields.map((field) => FIELD_LABELS[field]).join("・");
}

/** ノードの表示名。参照なら元の表示名、元が見つからなければ `null`。 */
export function nodeLabel(node: LearningMapNodeView): string | null {
  return node.kind === "own" ? node.label : (node.origin?.label ?? null);
}

/** 差分が空か（題名・ノード・確認問題のどれも変わっていない）。 */
export function isEmptyDiff(diff: LearningMapDiff): boolean {
  return (
    diff.title === null &&
    diff.description === null &&
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    !diff.reordered &&
    diff.checks.added.length === 0 &&
    diff.checks.removed.length === 0
  );
}

/** 共有マップを取り込んで個人マップを作る（#244 の T3）。「リンクだけ」はリンクの鍵を添える。 */
export function importSharedMap(
  mapId: string,
  key: string | undefined,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ map: LearningMapView }> {
  return sendShareRequest(
    "POST",
    `${SHARED_MAPS_PATH}/${encodeURIComponent(mapId)}/import`,
    key === undefined ? {} : { key },
    fetcher,
    timeoutMs,
  );
}

/** 取り込み直す前の差分（#244 の T4）。 */
export interface ReimportPreview {
  source: MapSourceView;
  latest: { version: number; publishedAt: string };
  /** 新しい版の中身（自分で足したノードと、残すノードは含まない）。 */
  content: SharedMapContentView;
  /** `removed` は共有の側で消されたノードだけ（既定は消す）。`changed` は共有の側の中身で上書きされる。 */
  diff: LearningMapDiff;
  /** 上書きされるノードのうち、自分で直していたもの。 */
  personallyEdited: string[];
  revision: number;
}

export function fetchReimportPreview(
  mapId: string,
  fetcher: typeof fetch = fetch,
  retry: boolean | number = false,
): Promise<ReimportPreview> {
  return requestJson(`${mapPath(mapId)}/reimport:preview`, fetcher, retry);
}

/** 取り込み直す。`keep` は共有の側で消されたノードのうち残すもの。 */
export function reimportLearningMap(
  mapId: string,
  input: { version: number; revision: number; keep: string[] },
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ map: LearningMapView }> {
  return sendShareRequest("POST", `${mapPath(mapId)}/reimport`, input, fetcher, timeoutMs);
}
