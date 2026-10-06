/**
 * `/v1/learning-maps` の外部契約（Issue #242 / Web/18）。
 *
 * 利用者が手で作る、木の形の学習マップ。ノードは Concept で、線は「前提 → 次」を表す。
 * 保存の形は migrations/0013_learning_maps.sql。
 *
 * 契約はこのアプリに置く（apps/api/AGENTS.md）。
 */

import * as v from "valibot";
import { CONCEPT_ID_PATTERN } from "@gakushu-sochi/domain";

/** 1人が持てるマップの数。 */
export const MAX_MAPS_PER_USER = 20;
/** 1マップのノード数。 */
export const MAX_NODES_PER_MAP = 50;
/**
 * 1マップの線の数。木の形なら線はノード数より少し多い程度だが、
 * 合流（前提が複数あるノード）を許すので、ノード数の4倍を上限にする。
 */
export const MAX_EDGES_PER_MAP = MAX_NODES_PER_MAP * 4;
export const MAX_MAP_TITLE_LENGTH = 80;
export const MAX_MAP_DESCRIPTION_LENGTH = 400;
export const MAX_NODE_LABEL_LENGTH = 40;
export const MAX_NODE_SUMMARY_LENGTH = 200;
/** 1ノードの「理解すること」の項目数。 */
export const MAX_OBJECTIVES_PER_NODE = 8;
export const MAX_OBJECTIVE_LABEL_LENGTH = 80;
/**
 * VS Code へ渡すノードの合計。AI へ渡す「既知の概念一覧」に入るので、
 * プロンプトの長さを抑えるために絞る。
 */
export const MAX_CLIENT_CONCEPTS = 100;

/**
 * 新しいノードの仮の番号。`new:` で始める。
 *
 * Concept ID（`<領域>.<識別子>`）はコロンを含まないので、既存のノードの ID と衝突しない。
 * サーバーが ID を振り、応答の `assigned` で仮の番号との対応を返す。
 */
export const NEW_NODE_REF_PATTERN = /^new:[A-Za-z0-9_-]{1,32}$/;

/** 前後の空白を落としたうえで、空でなく上限以内の文字列。 */
function text(max: number) {
  return v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
}

/**
 * そのマップのノード。`ref` は既存のノードなら Concept ID、新しいノードなら仮の番号。
 * 概要は必須（確認問題の生成の入力になるため）。
 */
const ownNodeSchema = v.strictObject({
  kind: v.literal("own"),
  ref: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  label: text(MAX_NODE_LABEL_LENGTH),
  summary: text(MAX_NODE_SUMMARY_LENGTH),
});

/**
 * 既存の Concept への参照。固定の Concept か、自分の他のマップのノードを元の ID のまま置く。
 * 表示名・概要・「理解すること」は元のものを使うので、ここでは受け取らない。
 */
const referenceNodeSchema = v.strictObject({
  kind: v.literal("reference"),
  conceptId: v.pipe(v.string(), v.regex(CONCEPT_ID_PATTERN)),
});

/**
 * 線は、ノードの `ref`（参照のノードなら `conceptId`）どうしを結ぶ。
 * `from` が前提、`to` が次。
 */
const edgeSchema = v.strictObject({
  from: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  to: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});

/**
 * `POST /v1/learning-maps` と `PUT /v1/learning-maps/:id` が受け取るマップの中身。
 *
 * PUT はノードと線を**まとめて置き換える**。送らなかったノードは消える。
 * `strictObject` は知らないキーを黙って捨てないためである（contract/conversations.ts と同じ）。
 */
export const learningMapContentSchema = v.strictObject({
  title: text(MAX_MAP_TITLE_LENGTH),
  description: v.optional(
    v.pipe(v.string(), v.trim(), v.maxLength(MAX_MAP_DESCRIPTION_LENGTH)),
    "",
  ),
  nodes: v.optional(
    v.pipe(
      v.array(v.variant("kind", [ownNodeSchema, referenceNodeSchema])),
      v.maxLength(MAX_NODES_PER_MAP),
    ),
    [],
  ),
  edges: v.optional(v.pipe(v.array(edgeSchema), v.maxLength(MAX_EDGES_PER_MAP)), []),
});

export type LearningMapContentInput = v.InferOutput<typeof learningMapContentSchema>;

/**
 * `PUT /v1/learning-maps/:id/nodes/:conceptId/objectives` が受け取る「理解すること」。
 *
 * 一覧をまとめて置き換える。既存の項目は `id` を付けて送り、新しい項目は `id` を省く
 * （サーバーが `<Concept ID>:<識別子>` を振る）。送らなかった項目は消える。
 * 並びは送った順になる。
 */
export const learningObjectivesInputSchema = v.strictObject({
  objectives: v.pipe(
    v.array(
      v.strictObject({
        id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
        label: text(MAX_OBJECTIVE_LABEL_LENGTH),
      }),
    ),
    v.maxLength(MAX_OBJECTIVES_PER_NODE),
  ),
});

export type LearningObjectivesInput = v.InferOutput<typeof learningObjectivesInputSchema>;

export type LearningMapVisibility = "private" | "shared";
export type LearningObjectiveSource = "manual" | "ai";

/** 「理解すること」の1項目。 */
export interface LearningObjectiveView {
  id: string;
  label: string;
  source: LearningObjectiveSource;
}

/** 参照のノードが指している元の Concept。 */
export interface ReferencedConcept {
  label: string;
  /** 固定の Concept は概要を持たないことがある（`Concept.summary` が任意）。 */
  summary?: string;
  /** 元が自分の他のマップのノードならそのマップの ID。固定の Concept なら `null`。 */
  mapId: string | null;
  objectives: LearningObjectiveView[];
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
      /**
       * 元の Concept。元のマップやノードが消えていて引けなければ `null`。
       * 参照のノードはそのまま残し、表示側で「元が見つからない」と出す。
       */
      origin: ReferencedConcept | null;
    };

export interface LearningMapEdge {
  from: string;
  to: string;
}

/** 一覧の1件。ノードと線は含めない。 */
export interface LearningMapSummary {
  id: string;
  title: string;
  description: string;
  visibility: LearningMapVisibility;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

/** `GET /v1/learning-maps/:id` の応答。ノードは保存した順（学習の順）に並ぶ。 */
export interface LearningMapView extends Omit<LearningMapSummary, "nodeCount"> {
  nodes: LearningMapNodeView[];
  edges: LearningMapEdge[];
}

/** `GET /v1/learning-maps` の応答。更新の新しい順。 */
export interface ListLearningMapsResponse {
  maps: LearningMapSummary[];
}

/**
 * `POST` と `PUT` の応答。`assigned` は新しいノードの仮の番号と、振った Concept ID の対応。
 */
export interface SaveLearningMapResponse {
  map: LearningMapView;
  assigned: Record<string, string>;
}

/** `PUT .../objectives` の応答。保存後の一覧。 */
export interface PutLearningObjectivesResponse {
  objectives: LearningObjectiveView[];
}

/** `GET /v1/learning-maps:concepts` の1件。VS Code が「既知の概念一覧」に加える。 */
export interface ClientMapConcept {
  id: string;
  label: string;
  summary: string;
  mapId: string;
  mapTitle: string;
  /** 前提のノードの Concept ID。参照のノード（固定の Concept など）も含む。 */
  prerequisites: string[];
  objectives: { id: string; label: string }[];
}

export interface ListClientMapConceptsResponse {
  concepts: ClientMapConcept[];
}
