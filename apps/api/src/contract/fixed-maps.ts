/**
 * `/v1/fixed-maps` の外部契約（Issue #245）。
 *
 * 固定の言語別マップ（`packages/domain/concepts.md`）の「理解すること」を、その言語のマップの
 * 作成者（migrations/0018_fixed_map_creators.sql）が AI で作り直し、手で直して確定する。
 * 作成者以外は 403。
 *
 * 1. `POST /v1/fixed-maps/:language/objectives:generate` で作り直しの案を受け取る。**保存しない。**
 *    今ある項目（ID と表示名）を AI に渡し、同じ内容の項目には同じ ID を返させる（決定 M5）。
 * 2. 作成者が差分を確かめ、どの古い項目に当たるかを手で直す。
 * 3. `PUT /v1/fixed-maps/:language/concepts/:conceptId/objectives` で Concept ごとに確定する（決定 M6）。
 *
 * 契約はこのアプリに置く（apps/api/AGENTS.md）。
 */

import * as v from "valibot";
import { CONCEPT_ID_PATTERN } from "@gakushu-sochi/domain";
import {
  MAX_OBJECTIVE_LABEL_LENGTH,
  MAX_OBJECTIVES_PER_NODE,
  type LearningObjectiveSource,
  type LearningObjectiveView,
} from "./learning-maps.js";

/**
 * 1回の生成で頼める Concept の数。いちばん多い言語（20）より余裕を持たせた入力の大きさの上限。
 * 実際に受け付けるのは、その言語の Concept だけ。
 */
export const MAX_FIXED_GENERATION_CONCEPTS = 50;

/**
 * `POST /v1/fixed-maps/:language/objectives:generate` が受け取るもの。
 * `conceptIds` を省くと、その言語のすべての Concept を作り直す。
 */
export const generateFixedObjectivesSchema = v.strictObject({
  conceptIds: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.regex(CONCEPT_ID_PATTERN))),
      v.minLength(1),
      v.maxLength(MAX_FIXED_GENERATION_CONCEPTS),
    ),
  ),
});

export type GenerateFixedObjectivesInput = v.InferOutput<typeof generateFixedObjectivesSchema>;

/** 作り直しの案の1項目。 */
export type FixedObjectiveDraft =
  /** 今ある項目を引き継ぐ。表示名が変わっても ID は同じ（`previousLabel` が今の表示名）。 */
  | { kind: "kept"; id: string; label: string; previousLabel: string }
  /** 新しく作る項目。確定するときに ID を振る。 */
  | { kind: "new"; label: string };

/** 1つの Concept の作り直しの案。 */
export interface FixedConceptObjectivesDraft {
  conceptId: string;
  /** AI が返した並び。 */
  objectives: FixedObjectiveDraft[];
  /** どの案にも引き継がれず、確定すると消える項目。 */
  removed: { id: string; label: string }[];
}

export interface GenerateFixedObjectivesResponse {
  /** 頼んだ Concept の並び（学ぶ順）。 */
  concepts: FixedConceptObjectivesDraft[];
}

/**
 * `PUT /v1/fixed-maps/:language/concepts/:conceptId/objectives` が受け取るもの。
 *
 * マップのノードの口（`learningObjectivesInputSchema`）と同じく一覧をまとめて置き換える。
 * 既存の項目は `id` を付けて送り（表示名を変えても ID は同じ）、新しい項目は `id` を省く。
 * 送らなかった項目は消える。並びは送った順になる。
 *
 * `source` は出どころ。AI の案をそのまま確定するときは `ai` を送る。省くと、新しい項目と
 * 表示名を書き換えた項目は `manual`、表示名が同じ項目は今の出どころのままになる。
 */
export const putFixedObjectivesSchema = v.strictObject({
  objectives: v.pipe(
    v.array(
      v.strictObject({
        id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
        label: v.pipe(
          v.string(),
          v.trim(),
          v.minLength(1),
          v.maxLength(MAX_OBJECTIVE_LABEL_LENGTH),
        ),
        source: v.optional(v.picklist(["manual", "ai"] satisfies LearningObjectiveSource[])),
      }),
    ),
    // 固定の Concept は項目を持つ前提で使われる（理解度・確認問題）。全部消して、
    // 全利用者の理解度を回数の判定へ戻してしまうことを防ぐ。
    v.minLength(1),
    v.maxLength(MAX_OBJECTIVES_PER_NODE),
  ),
});

export type PutFixedObjectivesInput = v.InferOutput<typeof putFixedObjectivesSchema>;

export interface PutFixedObjectivesResponse {
  objectives: LearningObjectiveView[];
}
