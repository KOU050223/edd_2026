import type {
  AnalysisInput,
  AnalysisProvider,
  Concept,
  EvidenceKind,
  HistoryAnalysisResult,
  HistoryObservation,
} from "@gakushu-sochi/domain";

/**
 * ローカルルールによる AnalysisProvider。
 *
 * Issue #157 の「ローカルで行う処理」を担う。AI へ送る前に、Concept の
 * ID・ラベル由来のキーワードを本文から数え、明らかに分かる概念だけを
 * 拾う。AI が不要な環境でも必ず利用できる（isAvailable は常に true）。
 *
 * 精度より「無関係な会話を AI へ送らない」ことを優先する。曖昧な
 * 会話はこの段階で観測を作らず、後段の AI Provider へ回す。
 */

/** 1会話あたりの候補上限。全部を候補にすると Evidence が薄まる。 */
const MAX_CANDIDATES_PER_CONVERSATION = 5;

/** キーワードとして拾う ASCII トークンの最小長。"if" 等の短すぎる語を除く。 */
const MIN_KEYWORD_LENGTH = 3;

/** language 名から補助キーワードへの写像。言語名だけでは誤爆が多い語を絞る。 */
const LANGUAGE_HINTS: Record<string, readonly string[]> = {
  go: ["golang"],
  ts: ["typescript"],
  js: ["javascript"],
  c: ["c言語"],
  cpp: ["c++"],
};

interface ConceptKeywords {
  conceptId: string;
  /** Concept 固有のキーワード。これらのどれかが当たらないと候補にしない。 */
  specific: readonly string[];
  /** 言語名とその別表記。固有キーワードが当たったあとの加点にだけ使う。 */
  languageHints: readonly string[];
}

/**
 * Concept から検索キーワードを作る。
 *
 * - ID 末尾（`go.pointer_receiver` → pointer, receiver）
 * - label 中の ASCII トークン（"error 型と if err != nil" → error, err）
 * - label 全体（日本語ラベルそのものが本文に現れるケース）
 * - language 名とその別表記（補助。これだけでは観測にしない）
 *
 * 「TypeScript について雑談した」だけの会話が全 ts.* Concept の形跡に
 * ならないよう、言語名は固有キーワードとの併用でのみ加点する。
 */
function keywordsOf(concept: Concept): ConceptKeywords {
  const specific = new Set<string>();
  const suffix = concept.id.slice(concept.id.indexOf(".") + 1);
  for (const token of suffix.split("_")) {
    const normalized = token.toLowerCase();
    if (normalized.length >= MIN_KEYWORD_LENGTH) specific.add(normalized);
  }
  for (const match of concept.label.matchAll(/[A-Za-z0-9_+-]+/g)) {
    const normalized = match[0].toLowerCase();
    if (normalized.length >= MIN_KEYWORD_LENGTH) specific.add(normalized);
  }
  const label = concept.label.trim().toLowerCase();
  if (label.length > 0) specific.add(label);
  const languageHints = new Set<string>();
  const language = concept.language.toLowerCase();
  if (language.length >= MIN_KEYWORD_LENGTH) languageHints.add(language);
  for (const hint of LANGUAGE_HINTS[language] ?? []) languageHints.add(hint);
  return { conceptId: concept.id, specific: [...specific], languageHints: [...languageHints] };
}

/** 本文中のヒット数を数える。同一キーワードの複数出現は1回と数える。 */
function countHits(body: string, keywords: readonly string[]): number {
  const lowered = body.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (lowered.includes(keyword)) hits += 1;
  }
  return hits;
}

/** ヒット数から確からしさを決める。局所的なキーワード一致なので控えめにする。 */
function confidenceOf(hits: number): number {
  if (hits >= 3) return 0.8;
  if (hits === 2) return 0.65;
  return 0.5;
}

/** 会話本文から EvidenceKind の粗い推定。誤っても Evidence の価値は保つ。 */
function inferKind(body: string): EvidenceKind {
  const lowered = body.toLowerCase();
  if (
    /(error|exception|stack ?trace|traceback|エラー|例外|スタックトレース|壊れた|動かない)/.test(
      lowered,
    )
  ) {
    return "debugging";
  }
  if (/(レビュー|review|確認して|チェックして|動作確認)/.test(lowered)) return "verification";
  if (/(実装|実装して|implement|コードを書|書いて|fix|修正して)/.test(lowered)) {
    return "implementation";
  }
  if (/(とは|とは何|教えて|explain|説明|how does|なぜ)/.test(lowered)) return "explanation";
  return "question";
}

export function createLocalRuleProvider(concepts: readonly Concept[]): AnalysisProvider {
  const index: ConceptKeywords[] = concepts.map(keywordsOf);
  const knownIds = new Set(concepts.map((concept) => concept.id));

  return {
    id: "local-rules",
    isAvailable: () => Promise.resolve(true),
    analyze(input: AnalysisInput): Promise<HistoryAnalysisResult> {
      const allowed = new Set(input.knownConceptIds.filter((id) => knownIds.has(id)));
      const observations: HistoryObservation[] = [];
      for (const conversation of input.conversations) {
        const scored = index
          .filter((entry) => allowed.has(entry.conceptId))
          .map((entry) => {
            // 固有キーワードが1つも当たらない Concept は候補にしない。
            // 言語名だけのヒットはその言語の全 Concept を誤検出する。
            const specificHits = countHits(conversation.body, entry.specific);
            return {
              ...entry,
              hits:
                specificHits === 0
                  ? 0
                  : specificHits + countHits(conversation.body, entry.languageHints),
            };
          })
          .filter((entry) => entry.hits > 0)
          .sort((a, b) => b.hits - a.hits || (a.conceptId < b.conceptId ? -1 : 1))
          .slice(0, MAX_CANDIDATES_PER_CONVERSATION);
        if (scored.length === 0) continue;
        observations.push({
          sourceId: conversation.sourceId,
          conceptCandidates: scored.map((entry) => entry.conceptId),
          kind: inferKind(conversation.body),
          ...(conversation.observedAt === undefined ? {} : { observedAt: conversation.observedAt }),
          confidence: confidenceOf(scored[0]?.hits ?? 1),
          ...(conversation.externalRefHash === undefined
            ? {}
            : { externalRefHash: conversation.externalRefHash }),
        });
      }
      return Promise.resolve({ observations });
    },
  };
}
