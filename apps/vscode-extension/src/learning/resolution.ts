import {
  LEARNING_OBJECTIVE_ID_PATTERN,
  MAX_OBJECTIVE_IDS_PER_EVENT,
  type AIAnswer,
  type ConceptId,
  type ConversationTurn,
} from "@gakushu-sochi/domain";

/**
 * AIの解消判定を、自力解決イベントとして記録してよいか判断する。
 *
 * 初回応答には解消の根拠となる対話がない。モデルが出力形式に従わず
 * `resolved` を返しても、履歴がなければ習熟度へ反映しない。
 */
export function shouldRecordSolvedIndependently(
  history: readonly ConversationTurn[],
  answer: Pick<AIAnswer, "resolution" | "conceptIds">,
): boolean {
  return history.length > 0 && answer.resolution === "resolved" && answer.conceptIds.length > 0;
}

/**
 * Chat の応答（`ChatResult.metadata`）に残す、その回答が触れた「理解すること」。
 *
 * `resolution` は「直前までの説明で扱っていた疑問が解消したか」の判定なので、自力解決で
 * 上げるべき項目は今回の回答ではなく**前の回答**が触れた項目である（#223 / PR #232 のレビュー）。
 * 前の回答の項目を次のターンで読めるよう、応答の metadata に載せておく。
 */
export interface AnswerMetadata {
  objectiveIds: string[];
}

/**
 * 会話履歴のうち最後の応答の metadata から、その回答が触れた項目 ID を読む。
 *
 * 履歴は VS Code が保存したものなので形を検査する。読めなければ空配列にし、
 * 自力解決は項目を動かさずに記録する（項目を誤って上げる側には倒さない）。
 * `vscode.ChatResponseTurn` かどうかは `result` の有無で見る（このファイルを vscode に依存させない）。
 */
export function previousAnswerObjectiveIds(history: readonly unknown[]): string[] {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (typeof turn !== "object" || turn === null || !("result" in turn)) {
      continue;
    }
    const metadata = (turn as { result?: { metadata?: unknown } }).result?.metadata;
    const objectiveIds = (metadata as Partial<AnswerMetadata> | undefined)?.objectiveIds;
    if (!Array.isArray(objectiveIds)) {
      return [];
    }
    return [
      ...new Set(
        objectiveIds.filter(
          (id): id is string => typeof id === "string" && LEARNING_OBJECTIVE_ID_PATTERN.test(id),
        ),
      ),
    ].slice(0, MAX_OBJECTIVE_IDS_PER_EVENT);
  }
  return [];
}

/**
 * 自力解決イベントの対象。項目は前の回答が触れたもの、Concept は今回の回答の Concept に
 * その項目の Concept を足したもの（`conceptIds` に無い Concept の項目は導出で無視されるため）。
 */
export function solvedIndependentlyTarget(
  answerConceptIds: readonly ConceptId[],
  previousObjectiveIds: readonly string[],
): { conceptIds: ConceptId[]; objectiveIds: string[] } {
  const conceptIds = [...answerConceptIds];
  for (const id of previousObjectiveIds) {
    const conceptId = id.slice(0, id.indexOf(":"));
    if (!conceptIds.includes(conceptId)) {
      conceptIds.push(conceptId);
    }
  }
  return { conceptIds, objectiveIds: [...previousObjectiveIds] };
}
