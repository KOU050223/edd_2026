/**
 * モデルの生の応答を、表示用の本文とメタ情報へ分ける処理。
 *
 * vscode.lm 経由（vscodeLm.ts）と BYOK の HTTP 経路（byok.ts）のどちらでも
 * 同じ出力形式を使うため、ここに置く。vscode には依存しない。
 */

import { MAX_OBJECTIVE_IDS_PER_EVENT, type ConceptId } from "@gakushu-sochi/domain";
import { META_MARKER } from "./prompt";

/**
 * プロンプトに含める過去の会話ターン数の上限。
 *
 * `AIRequest.history` は会話が続く限り増え続けるため、上限を設けないと
 * 毎回のリクエストが際限なく重くなり、いずれモデルのコンテキスト長を
 * 超えてしまう。理解が解消されたかの判断には直近のやり取りで十分なため、
 * 直近 {@link MAX_HISTORY_TURNS} 件だけを残す（古いものは切り捨てる）。
 */
export const MAX_HISTORY_TURNS = 10;

/** parseAnswer() の戻り値。 */
export interface ParsedAnswer {
  /** ユーザーへ表示する本文。メタ情報は含まない。 */
  text: string;
  conceptIds: ConceptId[];
  /** 回答が触れた「理解すること」の ID。受理できるものが無ければ空配列。 */
  objectiveIds: string[];
  resolution?: "resolved" | "unclear";
}

/** メタ情報を読めなかったときの戻り値。本文だけを使う。 */
function textOnly(text: string): ParsedAnswer {
  return { text, conceptIds: [], objectiveIds: [] };
}

/**
 * モデルの応答から、表示用の本文と末尾のメタ情報(JSON)を分離する。
 *
 * モデルが指示に従わない・JSONが壊れている場合は、本文だけをそのまま使い
 * conceptIds は空配列、resolution は省略にする。出力形式は保証されないため、
 * ここでの失敗が質問フロー自体を止めてはならない。
 *
 * conceptIds は `allowedConceptIds` に含まれる ID だけを受理する。呼び出し側は
 * プロンプトへ載せた一覧（knownConceptsFor）と同じ集合を渡し、一覧に無い
 * （実在する他言語の）ID が学習イベントへ混入しないようにする。
 *
 * objectiveIds も同じく `allowedObjectives`（プロンプトへ載せた項目一覧
 * knownObjectivesFor の ID → その項目の Concept ID）に含まれるものだけを受理する。
 * 項目の理解度は conceptIds に含まれる Concept の分しか動かないため、受理した項目の
 * Concept をモデルが conceptIds に入れ忘れていたら補う。件数は API の上限
 * {@link MAX_OBJECTIVE_IDS_PER_EVENT} で切る（超えるとイベントごと拒否される）。
 */
export function parseAnswer(
  raw: string,
  allowedConceptIds: ReadonlySet<ConceptId>,
  allowedObjectives: ReadonlyMap<string, ConceptId> = new Map(),
): ParsedAnswer {
  const markerIndex = raw.indexOf(META_MARKER);

  if (markerIndex === -1) {
    return textOnly(raw.trim());
  }

  const text = raw.slice(0, markerIndex).trim();
  const jsonMatch = raw.slice(markerIndex + META_MARKER.length).match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return textOnly(text);
  }

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);

    if (typeof parsed !== "object" || parsed === null) {
      return textOnly(text);
    }

    const rawConceptIds = (parsed as { conceptIds?: unknown }).conceptIds;
    const conceptIds = Array.isArray(rawConceptIds)
      ? rawConceptIds.filter(
          (id): id is ConceptId => typeof id === "string" && allowedConceptIds.has(id),
        )
      : [];

    const rawObjectiveIds = (parsed as { objectiveIds?: unknown }).objectiveIds;
    const objectiveIds = Array.isArray(rawObjectiveIds)
      ? [
          ...new Set(
            rawObjectiveIds.filter(
              (id): id is string => typeof id === "string" && allowedObjectives.has(id),
            ),
          ),
        ].slice(0, MAX_OBJECTIVE_IDS_PER_EVENT)
      : [];
    for (const id of objectiveIds) {
      const conceptId = allowedObjectives.get(id);
      if (conceptId !== undefined && !conceptIds.includes(conceptId)) {
        conceptIds.push(conceptId);
      }
    }

    const rawResolution = (parsed as { resolution?: unknown }).resolution;
    const resolution =
      rawResolution === "resolved" || rawResolution === "unclear" ? rawResolution : undefined;

    return { text, conceptIds, objectiveIds, resolution };
  } catch {
    return textOnly(text);
  }
}
