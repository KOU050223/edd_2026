import { expect, test } from "vitest";
import {
  historyProgressSummary,
  isLearnerQuestion,
  questionCards,
} from "./history-presentation.js";
import {
  localHistoryNameMatch,
  HISTORY_ANALYSIS_VERSION,
  type HistoryProgress,
  type HistoryTarget,
} from "./history-analysis.js";
import { historyQuestions, parseClaudeHistory, type HistoryQuestion } from "./local-history.js";

const question: HistoryQuestion = {
  key: "q",
  observationKey: "original",
  project: "project",
  observedAt: "2026-10-01T00:00:00Z",
  body: "ユーザーの質問 (1/1): Go の defer は？",
  fingerprint: "input",
};
const concept = {
  id: "go.defer",
  label: "defer の実行順序",
  summary: "遅延実行",
  area: "go",
  objectives: [],
  fingerprint: "definition",
};
const target: HistoryTarget = { target: "language:go", concepts: [concept], warnings: [] };

test("概念 ID のない通常の質問でも一意の名前で候補にし、回答だけの名前は使わない", () => {
  expect(localHistoryNameMatch(question, concept, target)).toBe(true);
  expect(
    localHistoryNameMatch(
      { ...question, body: "質問: 何ですか？\n周辺回答: defer" },
      concept,
      target,
    ),
  ).toBe(false);
  expect(localHistoryNameMatch({ ...question, body: "deferred" }, concept, target)).toBe(false);
  expect(
    localHistoryNameMatch(question, concept, {
      ...target,
      concepts: [concept, { ...concept, id: "own.defer", label: "defer の補足" }],
    }),
  ).toBe(false);
});

test("日本語の名前も一意の場合だけ候補にし同名の別 ID は混ぜない", () => {
  const named = { ...concept, label: "エラー処理" };
  const input = { ...question, body: "エラー処理を説明してください" };
  expect(localHistoryNameMatch(input, named, { ...target, concepts: [named] })).toBe(true);
  expect(
    localHistoryNameMatch(input, named, {
      ...target,
      concepts: [named, { ...named, id: "other" }],
    }),
  ).toBe(false);
});

test("分割された質問を元の順序で1枚にまとめ、回答はカードに載せない", () => {
  const cards = questionCards([
    { ...question, key: "part2", body: "ユーザーの質問 (2/2): 実行順は？\n周辺回答: 応答" },
    { ...question, body: "ユーザーの質問 (1/2): defer の" },
  ]);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.text).toBe("defer の実行順は？");
});

test("質問カードは新しい質問から表示する", () => {
  expect(
    questionCards([
      question,
      { ...question, key: "new", observationKey: "new", observedAt: "2026-10-02T00:00:00Z" },
    ]).map((card) => card.key),
  ).toEqual(["new", "original"]);
});

test("分割境界の空白を保ち、英単語をつなげてしまわない", () => {
  const cards = questionCards([
    { ...question, body: "ユーザーの質問 (1/2): hello " },
    { ...question, key: "part2", body: "ユーザーの質問 (2/2): world" },
  ]);
  expect(cards[0]!.text).toBe("hello world");
});

test.each([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
  "”/c:<path>”",
])("%s は本人の質問として表示・再解析しない", (text) => {
  expect(isLearnerQuestion(text)).toBe(false);
  const file = {
    key: "file",
    project: "p",
    fingerprint: "f",
    size: 1,
    lastModified: 0,
    questions: [{ ...question, body: `ユーザーの質問 (1/1): ${text}` }],
    warnings: [],
  };
  expect(historyQuestions([file])).toEqual([]);
});

test("新規取り込みでも中断通知を除外し警告を残す", async () => {
  async function* lines() {
    yield JSON.stringify({
      type: "user",
      uuid: "u",
      timestamp: "2026-10-01T00:00:00Z",
      message: { role: "user", content: "[Request interrupted by user]" },
    });
  }
  const parsed = await parseClaudeHistory(lines(), "p", "s");
  expect(parsed.questions).toEqual([]);
  expect(parsed.warnings.some((warning) => warning.includes("除外"))).toBe(true);
});

test("未解析を関連なしと誤表示せず、分割した質問は元の質問単位で数える", () => {
  const questions = [
    question,
    { ...question, key: "part2" },
    { ...question, key: "other", observationKey: "other" },
  ];
  const progress: HistoryProgress = {
    key: "k",
    version: HISTORY_ANALYSIS_VERSION,
    applications: [],
    classifications: [
      {
        question: "q",
        inputFingerprint: "input",
        concept: concept.id,
        definitionFingerprint: "definition",
        confidence: 0.8,
      },
      {
        question: "other",
        inputFingerprint: "input",
        concept: concept.id,
        definitionFingerprint: "definition",
        confidence: null,
      },
    ],
  };
  expect(historyProgressSummary(questions, target, progress)).toEqual({
    total: 2,
    related: 1,
    pending: 0,
    unrelated: 1,
  });
  expect(historyProgressSummary(questions, target)).toEqual({
    total: 2,
    related: 0,
    pending: 2,
    unrelated: 0,
  });
});
