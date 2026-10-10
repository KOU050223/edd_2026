import type { HistoryAnalysisResult, LearningEvidence } from "@gakushu-sochi/domain";
import { postJsonBody, requestJson } from "./api.js";
import type { HistoryQuestion } from "./local-history.js";

/** Assistant text is never sent to the classifier, including previously saved history. */
export function historyAnalysisBody(question: HistoryQuestion): string {
  return question.body.split("\n周辺回答:")[0]!;
}

export interface HistoryConcept {
  id: string;
  label: string;
  summary: string;
  area: string;
  objectives: string[];
  fingerprint: string;
  needsObjectives?: boolean;
}
export interface HistoryTarget {
  target: string;
  concepts: HistoryConcept[];
  warnings: string[];
  inputBytesLimit?: number;
  promptOverheadBytes?: number;
}

/** Fixed prompt overhead is provided by the API; variable sections match its prompt. */
export function historyBatchBytes(
  questions: readonly HistoryQuestion[],
  concepts: readonly HistoryConcept[],
  target: HistoryTarget,
) {
  const definitions = JSON.stringify(
    concepts.map(({ id, label, summary, area }) => ({ id, label, summary, area })),
  );
  const objectives = JSON.stringify(
    concepts
      .filter(
        (concept) =>
          concept.needsObjectives === true ||
          concepts.some((other) => other.id !== concept.id && other.label === concept.label),
      )
      .map(({ id, objectives }) => ({ id, objectives: objectives.slice(0, 3) })),
  );
  const conversations = questions
    .map(
      (question) =>
        `--- conversation ${question.key} ---\nobservedAt: ${question.observedAt}\n${historyAnalysisBody(question)}\n`,
    )
    .join("");
  return (
    (target.promptOverheadBytes ?? 3_000) +
    new TextEncoder().encode(definitions + objectives + conversations).length
  );
}

/** Candidate boundary accepts only current definitions of the selected map. */
export function selectHistoryBatch(
  pending: ReturnType<typeof pendingHistory>,
  target: HistoryTarget,
) {
  const first = pending[0];
  if (!first) return { questions: [], concepts: [] };
  const concepts: HistoryConcept[] = [];
  const ranked = [...first.concepts].sort((a, b) => {
    const text = first.question.body.toLocaleLowerCase();
    return (
      Number(text.includes(b.label.toLocaleLowerCase())) -
      Number(text.includes(a.label.toLocaleLowerCase()))
    );
  });
  for (const concept of ranked.slice(0, 20)) {
    if (
      historyBatchBytes([first.question], [...concepts, concept], target) <=
      (target.inputBytesLimit ?? 6_000)
    )
      concepts.push(concept);
  }
  if (!concepts.length)
    throw new Error(
      "この質問と候補定義が AI の入力上限を超えています。解析済み分は適用できます。マップの説明を短くして再開してください",
    );
  const ids = concepts.map((concept) => concept.id);
  const questions = [first.question];
  for (const item of pending.slice(1)) {
    if (questions.length >= 5) break;
    if (
      ids.every((id) => item.concepts.some((concept) => concept.id === id)) &&
      historyBatchBytes([...questions, item.question], concepts, target) <=
        (target.inputBytesLimit ?? 6_000)
    )
      questions.push(item.question);
  }
  return { questions, concepts };
}
export interface CachedClassification {
  question: string;
  inputFingerprint: string;
  concept: string;
  definitionFingerprint: string;
  confidence: number | null;
}
export interface HistoryProgress {
  key: string;
  version: number;
  classifications: CachedClassification[];
  applications: { id: string; concepts: string[] }[];
  excludedConceptIds?: string[];
  pendingApplication?: {
    id: string;
    evidence: LearningEvidence[];
    fingerprints: Record<string, string>;
  };
}
export const HISTORY_ANALYSIS_VERSION = 4;
export const HISTORY_CALL_LIMIT = 5;
export const fetchHistoryTarget = (target: string) =>
  requestJson<HistoryTarget>(`/api/v1/history-targets/${encodeURIComponent(target)}`);

export function reconcileHistoryProgress(
  progress: HistoryProgress,
  questions: readonly HistoryQuestion[],
  target: HistoryTarget,
): HistoryProgress {
  const inputs = new Map(questions.map((question) => [question.key, question.fingerprint]));
  const definitions = new Map(target.concepts.map((concept) => [concept.id, concept.fingerprint]));
  return {
    ...progress,
    version: HISTORY_ANALYSIS_VERSION,
    classifications:
      progress.version !== HISTORY_ANALYSIS_VERSION
        ? []
        : progress.classifications.filter(
            (item) =>
              inputs.get(item.question) === item.inputFingerprint &&
              definitions.get(item.concept) === item.definitionFingerprint,
          ),
  };
}

export function pendingHistory(
  questions: readonly HistoryQuestion[],
  target: HistoryTarget,
  progress: HistoryProgress,
) {
  const done = new Set(progress.classifications.map((item) => `${item.question}:${item.concept}`));
  return questions.flatMap((question) => {
    const concepts = target.concepts.filter(
      (concept) => !done.has(`${question.key}:${concept.id}`),
    );
    return concepts.length ? [{ question, concepts }] : [];
  });
}

/** Only explicit IDs are certain locally; name similarity never shares observations. */
export function localHistoryMatch(question: HistoryQuestion, concept: HistoryConcept): boolean {
  const questionText = historyAnalysisBody(question);
  return questionText.split(/[^\p{L}\p{N}_.]+/u).includes(concept.id);
}

/** Exact, unambiguous names are a preview suggestion, never a mastery assessment. */
export function localHistoryNameMatch(
  question: HistoryQuestion,
  concept: HistoryConcept,
  target: HistoryTarget,
): boolean {
  const label = concept.label.trim().toLocaleLowerCase();
  if (
    label.length < 3 ||
    concept.needsObjectives ||
    target.concepts.some(
      (other) => other.id !== concept.id && other.label.trim().toLocaleLowerCase() === label,
    )
  )
    return false;
  const text = historyAnalysisBody(question).toLocaleLowerCase();
  // Slash-separated English labels can contain ordinary words such as "for".
  // Only abbreviate Japanese descriptions; require the whole label otherwise.
  const tokens = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(label)
    ? (label.match(/[a-z][a-z0-9_+.-]{2,}/g) ?? []).filter(
        (name) => !/^(?:for|and|the|with|from|into|not|get|add|set|use)$/i.test(name),
      )
    : [];
  const names = [label, ...tokens];
  return names.some((name) => {
    if (
      target.concepts.some(
        (other) =>
          other.id !== concept.id &&
          (other.label.trim().toLocaleLowerCase() === name ||
            other.label
              .toLocaleLowerCase()
              .match(/[a-z][a-z0-9_+.-]{2,}/g)
              ?.some((word) => word === name) === true),
      )
    )
      return false;
    if (!/^[a-z0-9_.+ -]+$/.test(name)) return text.includes(name);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`).test(text);
  });
}

export async function analyzeHistoryBatch(
  questions: readonly HistoryQuestion[],
  concepts: readonly HistoryConcept[],
  target: string,
): Promise<CachedClassification[]> {
  const response = await postJsonBody<HistoryAnalysisResult>(
    "/api/v1/ai/history-analysis",
    {
      mapTarget: {
        target,
        fingerprints: Object.fromEntries(
          concepts.map((concept) => [concept.id, concept.fingerprint]),
        ),
      },
      knownConceptIds: concepts.map((concept) => concept.id),
      conversations: questions.map((question) => ({
        sourceId: question.key,
        body: historyAnalysisBody(question),
        observedAt: question.observedAt,
      })),
    },
    fetch,
    135_000,
  );
  if (!Array.isArray(response.observations) || (response.droppedObservations ?? 0) !== 0)
    throw new Error("解析応答に不正な観測がありました。進捗を確定せず再試行できます");
  const allowedSources = new Set(questions.map((question) => question.key));
  const confidence = new Map<string, number>();
  for (const observation of response.observations) {
    if (
      !observation ||
      !allowedSources.has(observation.sourceId) ||
      !Array.isArray(observation.conceptCandidates) ||
      !Number.isFinite(observation.confidence) ||
      observation.confidence < 0 ||
      observation.confidence > 1
    )
      throw new Error("解析応答の形式が不正です");
    for (const id of observation.conceptCandidates) {
      if (!concepts.some((concept) => concept.id === id)) continue;
      const key = `${observation.sourceId}:${id}`;
      confidence.set(key, Math.max(confidence.get(key) ?? 0, observation.confidence));
    }
  }
  return questions.flatMap((question) =>
    concepts.map((concept) => ({
      question: question.key,
      inputFingerprint: question.fingerprint,
      concept: concept.id,
      definitionFingerprint: concept.fingerprint,
      confidence: confidence.get(`${question.key}:${concept.id}`) ?? null,
    })),
  );
}

export function previewHistory(
  questions: readonly HistoryQuestion[],
  target: HistoryTarget,
  progress: HistoryProgress,
) {
  const byQuestion = new Map(questions.map((question) => [question.key, question]));
  return target.concepts.flatMap((concept) => {
    const matches = progress.classifications.filter(
      (item) =>
        item.concept === concept.id && item.confidence !== null && byQuestion.has(item.question),
    );
    if (!matches.length) return [];
    return [
      {
        concept,
        count: new Set(
          matches.map((item) => byQuestion.get(item.question)!.observationKey ?? item.question),
        ).size,
        lastObservedAt: matches
          .map((item) => byQuestion.get(item.question)!.observedAt)
          .sort()
          .at(-1)!,
        matches,
      },
    ];
  });
}

export function historyEvidence(
  id: string,
  questions: readonly HistoryQuestion[],
  matches: readonly CachedClassification[],
): LearningEvidence[] {
  const byQuestion = new Map(questions.map((question) => [question.key, question]));
  const evidence: LearningEvidence[] = matches
    .filter((item) => item.confidence !== null)
    .map((item) => ({
      id: `${id}:claude-code:${item.question}:${item.concept}`,
      observationKey: byQuestion.get(item.question)!.observationKey ?? item.question,
      conceptIds: [item.concept],
      source: { provider: "claude-code", importedBy: "file" },
      kind: "question",
      observedAt: byQuestion.get(item.question)!.observedAt,
      confidence: item.confidence!,
      importSessionId: id,
      externalRefHash: byQuestion.get(item.question)!.observationKey ?? item.question,
    }));
  const unique = new Map<string, LearningEvidence>();
  for (const item of evidence) {
    const key = `${item.observationKey}:${item.conceptIds[0]}`;
    const previous = unique.get(key);
    if (previous === undefined || previous.confidence < item.confidence) unique.set(key, item);
  }
  return [...unique.values()];
}
