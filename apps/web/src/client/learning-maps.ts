/**
 * 利用者が手で作る学習マップ（Issue #242）の読み書きと、描画用の変換。
 *
 * 契約は apps/api/src/contract/learning-maps.ts。Web は API のパッケージを import しないので、
 * 使う形だけをここに写す（profile.ts と同じ）。描画に依存しないので単体テストできる。
 */

import type { Concept as DomainConcept, LearningObjective } from "@gakushu-sochi/domain";
import { ApiError, deleteJson, requestJson, writeErrorOf } from "./api.js";

export const LEARNING_MAPS_PATH = "/api/v1/learning-maps";

/** API と同じ上限。入力欄の `maxLength` に使う。 */
export const MAP_LIMITS = {
  maps: 20,
  title: 80,
  description: 400,
} as const;

export type LearningMapVisibility = "private" | "shared";

export interface LearningObjectiveView {
  id: string;
  label: string;
  source: "manual" | "ai";
}

export type LearningMapNodeView =
  | {
      kind: "own";
      conceptId: string;
      label: string;
      summary: string;
      objectives: LearningObjectiveView[];
    }
  | {
      kind: "reference";
      conceptId: string;
      /** 元の Concept。元のマップやノードが消えていれば `null`。 */
      origin: {
        label: string;
        summary?: string;
        mapId: string | null;
        objectives: LearningObjectiveView[];
      } | null;
    };

export interface LearningMapSummary {
  id: string;
  title: string;
  description: string;
  visibility: LearningMapVisibility;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LearningMapView extends Omit<LearningMapSummary, "nodeCount"> {
  nodes: LearningMapNodeView[];
  edges: { from: string; to: string }[];
}

/**
 * 手で作ったノードの Concept ID の形。`<マップの ID>.<識別子>`（例: `m7k2x9qa4.n3p8d2kw`）。
 * マップの ID は `m` + 英小文字と数字 8 文字、識別子も 8 文字（API が採番する）。
 */
const MAP_NODE_ID_PATTERN = /^(m[a-z0-9]{8})\.[a-z0-9]{8}$/;

/** 手で作ったノードなら、属するマップの ID。固定の Concept なら `undefined`。 */
export function mapIdOfConcept(conceptId: string): string | undefined {
  return MAP_NODE_ID_PATTERN.exec(conceptId)?.[1];
}

/**
 * 今ある自分のマップに載っている、手で作ったノードか。
 *
 * API の `learning-profile` は、今あるノードにだけ表示名を付けて返す（固定の一覧と利用者の
 * マップを合わせた一覧から引く。apps/api/src/maps/catalog.ts）。マップやノードを消した後の
 * 学習記録は表示名なしで残るので、それを「載っていない」と見分けられる。
 */
export function isOnExistingMap(concept: { conceptId: string; label?: string }): boolean {
  return mapIdOfConcept(concept.conceptId) !== undefined && concept.label !== undefined;
}

/** マップの ID の形。`m` + 英小文字と数字 8 文字。 */
export function isMapId(value: string): boolean {
  return /^m[a-z0-9]{8}$/.test(value);
}

/** 元が見つからない参照のノードの表示名。 */
export const MISSING_ORIGIN_LABEL = "（元の Concept が見つかりません）";

/** 描画に使う、マップ1件ぶんの定義。 */
export interface MapDefinitions {
  /** 木の組み立て（`layoutTrees`・`linkConcepts`）に渡す。`language` はすべてマップの ID。 */
  concepts: DomainConcept[];
  objectives: LearningObjective[];
  /** 参照のノードの Concept ID。詳細で「参照」と添える。 */
  referenceIds: ReadonlySet<string>;
}

/**
 * マップを、既存の地図の部品（`SkillTree`・`ConceptDetail`）が使う定義の形へ変える。
 *
 * 参照のノードも同じ木に置くので、`language` は元の Concept の領域ではなくこのマップの ID にする。
 * 前提は線から引く（線の両端は同じマップのノード）。
 */
export function mapDefinitions(map: LearningMapView): MapDefinitions {
  const prerequisites = new Map<string, string[]>();
  for (const edge of map.edges) {
    prerequisites.set(edge.to, [...(prerequisites.get(edge.to) ?? []), edge.from]);
  }
  const concepts: DomainConcept[] = [];
  const objectives: LearningObjective[] = [];
  const referenceIds = new Set<string>();
  for (const node of map.nodes) {
    const shown =
      node.kind === "own"
        ? node
        : {
            label: node.origin?.label ?? MISSING_ORIGIN_LABEL,
            summary: node.origin?.summary,
            objectives: node.origin?.objectives ?? [],
          };
    if (node.kind === "reference") referenceIds.add(node.conceptId);
    concepts.push({
      id: node.conceptId,
      label: shown.label,
      language: map.id,
      ...(shown.summary === undefined ? {} : { summary: shown.summary }),
      prerequisites: prerequisites.get(node.conceptId) ?? [],
      source: { kind: "manual" },
    });
    objectives.push(
      ...shown.objectives.map((objective) => ({
        id: objective.id,
        conceptId: node.conceptId,
        label: objective.label,
      })),
    );
  }
  return { concepts, objectives, referenceIds };
}

export function fetchLearningMaps(
  fetcher: typeof fetch = fetch,
  retry: boolean | number = false,
): Promise<{ maps: LearningMapSummary[] }> {
  return requestJson(LEARNING_MAPS_PATH, fetcher, retry);
}

export function fetchLearningMap(
  mapId: string,
  fetcher: typeof fetch = fetch,
  retry: boolean | number = false,
): Promise<LearningMapView> {
  return requestJson(`${LEARNING_MAPS_PATH}/${encodeURIComponent(mapId)}`, fetcher, retry);
}

/** マップの数が上限に達していて作れなかった。 */
export class MapLimitError extends Error {
  constructor() {
    super("learning_map_limit_reached");
  }
}

/** 入力が API の検証で拒まれた。`message` は API の定型文（入力値を含まない）。 */
export class MapInputError extends Error {}

/**
 * マップの書き込み。失敗の本文を読み、上限（409）と入力の誤り（400）を汎用の失敗と分ける。
 * 汎用の失敗（「取得に失敗」）では、利用者が何を直せばよいか分からないため。
 * それ以外は既存の書き込みと同じ規則（`writeErrorOf`）で分ける。
 */
async function sendMapRequest<T>(
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
    if (response.status === 409 && body.error === "learning_map_limit_reached") {
      throw new MapLimitError();
    }
    if (response.status === 400 && typeof body.error === "string") {
      throw new MapInputError(body.error);
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

/** 題名と説明だけでマップを作る。ノードは編集画面で足す。 */
export function createLearningMap(
  input: { title: string; description: string },
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ map: LearningMapView }> {
  return sendMapRequest("POST", LEARNING_MAPS_PATH, input, fetcher, timeoutMs);
}

/**
 * マップの題名・説明・ノード・線をまとめて置き換える。送らなかったノードは消える。
 * 応答の `assigned` は新しいノードの仮の番号と、振った Concept ID の対応。
 */
export function saveLearningMap(
  mapId: string,
  content: unknown,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ map: LearningMapView; assigned: Record<string, string> }> {
  return sendMapRequest(
    "PUT",
    `${LEARNING_MAPS_PATH}/${encodeURIComponent(mapId)}`,
    content,
    fetcher,
    timeoutMs,
  );
}

/**
 * 1ノードの「理解すること」をまとめて置き換える。既存の項目は `id` を付けて送り、
 * 新しい項目は省く（API が振る）。送らなかった項目と、その項目を狙った確認問題は消える。
 */
export function saveObjectives(
  mapId: string,
  conceptId: string,
  objectives: readonly { id?: string; label: string }[],
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ objectives: LearningObjectiveView[] }> {
  return sendMapRequest(
    "PUT",
    `${LEARNING_MAPS_PATH}/${encodeURIComponent(mapId)}/nodes/${encodeURIComponent(conceptId)}/objectives`,
    { objectives },
    fetcher,
    timeoutMs,
  );
}

/** 自分のマップのノード（参照ではないもの）。参照で足す候補に使う。 */
export interface OwnMapConcept {
  id: string;
  label: string;
  summary: string;
  mapId: string;
  mapTitle: string;
}

/**
 * 自分のマップのノードを、更新の新しいマップから最大 100 件。
 * VS Code 向けの一覧（`GET /v1/learning-maps:concepts`）を、参照の候補にも使う。
 */
export function fetchOwnMapConcepts(
  fetcher: typeof fetch = fetch,
  retry: boolean | number = false,
): Promise<{ concepts: OwnMapConcept[] }> {
  return requestJson(`${LEARNING_MAPS_PATH}:concepts`, fetcher, retry);
}

/** マップを消す。ノード・線・項目と、そのノードの確認問題も消える（#242）。 */
export function deleteLearningMap(mapId: string, fetcher: typeof fetch = fetch): Promise<void> {
  return deleteJson(`${LEARNING_MAPS_PATH}/${encodeURIComponent(mapId)}`, fetcher);
}
