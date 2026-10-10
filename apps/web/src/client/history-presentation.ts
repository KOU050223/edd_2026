import type { HistoryQuestion } from "./local-history.js";
import {
  historyAnalysisBody,
  type HistoryProgress,
  type HistoryTarget,
} from "./history-analysis.js";

export function questionText(question: HistoryQuestion): string {
  return historyAnalysisBody(question).replace(/^ユーザーの質問(?: \(\d+\/\d+\))?: ?/, "");
}

export function isLearnerQuestion(text: string): boolean {
  const body = text
    .replace(/^ユーザーの質問(?: \(\d+\/\d+\))?:\s*/, "")
    .split("\n周辺回答:")[0]!
    .trim();
  return (
    !!body &&
    !/^\[Request interrupted by user(?: for tool use)?\]$/i.test(body) &&
    !/^["'“”\s]*(?:\/[a-z]:|[a-z]:)?<path>["'“”\s]*$/i.test(body)
  );
}

/** One card per actual utterance; analysis chunks are an internal detail. */
export function questionCards(questions: readonly HistoryQuestion[]) {
  const cards = new Map<
    string,
    { key: string; project: string; observedAt: string; text: string }
  >();
  const ordered = [...questions].sort((a, b) => {
    const left = a.observationKey ?? a.key;
    const right = b.observationKey ?? b.key;
    return (
      left.localeCompare(right) ||
      Number(a.body.match(/^ユーザーの質問 \((\d+)\//)?.[1] ?? 1) -
        Number(b.body.match(/^ユーザーの質問 \((\d+)\//)?.[1] ?? 1)
    );
  });
  for (const question of ordered) {
    if (!isLearnerQuestion(question.body)) continue;
    const key = question.observationKey ?? question.key;
    const previous = cards.get(key);
    const text = questionText(question);
    cards.set(
      key,
      previous
        ? { ...previous, text: previous.text + text }
        : {
            key,
            project: question.project,
            observedAt: question.observedAt,
            text,
          },
    );
  }
  return [...cards.values()]
    .map((card) => ({ ...card, text: card.text.trim() }))
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}

export function historyProgressSummary(
  questions: readonly HistoryQuestion[],
  target: HistoryTarget,
  progress?: HistoryProgress,
) {
  const done = new Set(progress?.classifications.map((item) => `${item.question}:${item.concept}`));
  const related = new Set(
    progress?.classifications
      .filter((item) => item.confidence !== null)
      .map((item) => item.question),
  );
  const states = new Map<string, { complete: boolean; related: boolean }>();
  for (const question of questions) {
    const key = question.observationKey ?? question.key;
    const previous = states.get(key);
    states.set(key, {
      complete:
        (previous?.complete ?? true) &&
        target.concepts.length > 0 &&
        target.concepts.every((concept) => done.has(`${question.key}:${concept.id}`)),
      related: (previous?.related ?? false) || related.has(question.key),
    });
  }
  return {
    total: states.size,
    related: [...states.values()].filter((state) => state.related).length,
    unrelated: [...states.values()].filter((state) => state.complete && !state.related).length,
    pending: [...states.values()].filter((state) => !state.complete && !state.related).length,
  };
}
