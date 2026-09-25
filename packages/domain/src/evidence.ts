/**
 * 外部履歴を LearningEvidence へ正規化し、Familiarity と Map の状態を
 * 導出する純粋関数（Issue #157）。
 *
 * Provider（AnalysisProvider）が返した観測をそのまま Profile へ流さず、
 * 必ずここを通す。Concept への対応付け・confidence の検証・重複の
 * まとめ・unmapped の切り分けはすべてこの層の責務である。
 *
 * mastery.ts と同じく、VS Code・HTTP・DB・ファイルシステムへ依存しない。
 */

import { isIsoDateTime } from "./mastery.js";
import type {
  AnalysisBudget,
  AnalysisMode,
  AnalysisProvider,
  ConceptFamiliarity,
  EvidenceImportedBy,
  HistoryAnalysisResult,
  HistoryObservation,
  HistoryProviderId,
  LearningEvidence,
  LearningMapStatus,
} from "./history-import.js";
import type { Concept, ConceptId, ConceptMastery } from "./profile.js";

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * 正規化時の環境情報。
 *
 * `concepts` は照合先の Concept 一覧（packages/domain の正典）。
 * ID の完全一致だけでなく、label や ID 末尾への一意な照合もここで試す。
 * Provider は自由な候補を返してよいが、Evidence に残すのは
 * 一覧へ一意に対応付いたものだけにする。
 */
export interface NormalizeEvidenceContext {
  provider: HistoryProviderId;
  importedBy: EvidenceImportedBy;
  importSessionId: string;
  concepts: readonly Concept[];
}

/** 棄却した観測。reason で棄却の種別を区別できるようにする。 */
export interface RejectedObservation {
  sourceId: string;
  reason:
    "missing-source-id" | "no-concept-candidates" | "invalid-confidence" | "invalid-observed-at";
}

/** Concept 一覧に無かった候補。unknown のまま残す。 */
export interface UnmappedCandidate {
  sourceId: string;
  candidate: string;
}

export interface NormalizationResult {
  /** 正規化された Evidence。重複した sourceId は1件へまとめ済み。 */
  evidence: LearningEvidence[];
  unmapped: UnmappedCandidate[];
  rejected: RejectedObservation[];
}

/**
 * HistoryAnalysisResult を LearningEvidence へ正規化する。
 *
 * - `sourceId` が空の観測は棄却する。Evidence ID の元になるため、
 *   取れないものを進めると追跡不能なデータが生まれる。
 * - `confidence` が 0.0〜1.0 に収まらない観測は棄却する。
 *   丸めて通すと、Provider の不具合が確からしさの値を装って残る。
 * - `observedAt` が解釈できない観測は棄却する。
 *   「最後に触れた時期」の根拠を壊れた値で汚さないため。
 * - `conceptCandidates` が1つも無い観測は棄却する。
 *   Concept の無い Evidence は Learning Map に載らず、記録しても
 *   判断材料にならない。
 * - 候補が Concept 一覧に無い場合は推測で近い Concept へ写さず、
 *   `unmapped` として残す（Issue #157）。
 * - 同じ `sourceId` の観測は1件の Evidence へまとめる。
 */
export function normalizeAnalysisResult(
  result: HistoryAnalysisResult,
  context: NormalizeEvidenceContext,
): NormalizationResult {
  const conceptIndex = buildConceptIndex(context.concepts);
  const rejected: RejectedObservation[] = [];
  const unmapped: UnmappedCandidate[] = [];
  const bySourceId = new Map<string, HistoryObservation[]>();

  for (const observation of result.observations) {
    if (observation.sourceId.length === 0) {
      rejected.push({ sourceId: observation.sourceId, reason: "missing-source-id" });
      continue;
    }
    if (
      !Number.isFinite(observation.confidence) ||
      observation.confidence < 0 ||
      observation.confidence > 1
    ) {
      rejected.push({ sourceId: observation.sourceId, reason: "invalid-confidence" });
      continue;
    }
    if (observation.observedAt !== undefined && !isIsoDateTime(observation.observedAt)) {
      rejected.push({ sourceId: observation.sourceId, reason: "invalid-observed-at" });
      continue;
    }
    if (observation.conceptCandidates.length === 0) {
      rejected.push({ sourceId: observation.sourceId, reason: "no-concept-candidates" });
      continue;
    }
    const existing = bySourceId.get(observation.sourceId);
    if (existing === undefined) bySourceId.set(observation.sourceId, [observation]);
    else existing.push(observation);
  }

  const evidence: LearningEvidence[] = [];
  for (const [sourceId, observations] of bySourceId) {
    const conceptIds = new Set<ConceptId>();
    let mapped = false;
    for (const observation of observations) {
      for (const candidate of observation.conceptCandidates) {
        const resolved = resolveConceptCandidate(candidate, conceptIndex);
        if (resolved === undefined) {
          unmapped.push({ sourceId, candidate });
        } else {
          conceptIds.add(resolved);
          mapped = true;
        }
      }
    }
    // どの候補も一覧へ写らなかった観測は Evidence にしない。
    // unmapped として残すので「分からなかった」事実自体は消えない。
    if (!mapped) continue;

    // 同じ会話に対する複数の観測を畳む。confidence は最大値、
    // kind は最も確からしい観測のもの、observedAt は最新のものを採る。
    const primary = observations.reduce((best, current) =>
      current.confidence > best.confidence ? current : best,
    );
    const observedAt = observations
      .map((observation) => observation.observedAt)
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1);
    evidence.push({
      id: `${context.importSessionId}:${context.provider}:${sourceId}`,
      conceptIds: [...conceptIds],
      source: { provider: context.provider, importedBy: context.importedBy },
      kind: primary.kind,
      ...(observedAt === undefined ? {} : { observedAt }),
      confidence: primary.confidence,
      importSessionId: context.importSessionId,
      ...(primary.externalRefHash === undefined
        ? {}
        : { externalRefHash: primary.externalRefHash }),
    });
  }

  return { evidence, unmapped, rejected };
}

/**
 * 候補文字列を Concept ID へ写すための索引。
 *
 * 3つのキーを持つ:
 * - `byId`: ID そのもの（完全一致）
 * - `byLabel`: label の完全一致（大文字小文字を無視）
 * - `bySuffix`: ID の `.` 以降への一致。一意に決まる場合だけ写す。
 */
interface ConceptIndex {
  byId: ReadonlyMap<string, ConceptId>;
  byLabel: ReadonlyMap<string, ConceptId>;
  bySuffix: ReadonlyMap<string, ConceptId | undefined>;
}

function buildConceptIndex(concepts: readonly Concept[]): ConceptIndex {
  const byId = new Map<string, ConceptId>();
  const byLabel = new Map<string, ConceptId>();
  const bySuffix = new Map<string, ConceptId | undefined>();
  for (const concept of concepts) {
    byId.set(concept.id, concept.id);
    byLabel.set(concept.label.toLowerCase(), concept.id);
    const suffix = concept.id.slice(concept.id.indexOf(".") + 1);
    // 同じ末尾を持つ Concept が複数あると一意に決まらない。
    // その場合は undefined を入れて「曖昧」を表現する。
    bySuffix.set(suffix, bySuffix.has(suffix) ? undefined : concept.id);
  }
  return { byId, byLabel, bySuffix };
}

/**
 * 1つの候補を Concept ID へ写す。一意に決まらない場合は undefined。
 *
 * 照合の順序:
 * 1. ID として完全一致
 * 2. 大小文字を無視した ID 完全一致（`Go.Pointer_Receiver` 等の揺れ）
 * 3. label の完全一致
 * 4. ID 末尾への一致（`type_narrowing` → `ts.type_narrowing`）。
 *    一意に決まるときだけ。複数あるなら曖昧として写さない。
 */
function resolveConceptCandidate(candidate: string, index: ConceptIndex): ConceptId | undefined {
  const normalized = candidate.trim().toLowerCase().replaceAll(" ", "_");
  const exact = index.byId.get(candidate) ?? index.byId.get(normalized);
  if (exact !== undefined) return exact;
  const byLabel = index.byLabel.get(candidate.trim().toLowerCase());
  if (byLabel !== undefined) return byLabel;
  return index.bySuffix.get(normalized);
}

// ---------------------------------------------------------------------------
// Familiarity
// ---------------------------------------------------------------------------

/**
 * Evidence の列から Concept ごとの Familiarity を導出する。
 *
 * `deriveMasteryFromEvents` と同じく「エントリが無いこと」で未観測を表す。
 * `lastObservedAt` は observedAt の最大値、sources は provider 名の昇順で
 * 固定し、導出結果を一意にする。
 *
 * observedAt が解釈できない Evidence は例外にする（mastery.ts の
 * toEpochMs と同じ方針）。Normalizer を通っていれば起きないはずの値を
 * ここで丸めると、根拠の時刻が黙って壊れる。
 */
export function deriveFamiliarityFromEvidence(
  evidence: readonly LearningEvidence[],
): Record<ConceptId, ConceptFamiliarity | undefined> {
  const familiarity: Record<ConceptId, ConceptFamiliarity | undefined> = {};

  for (const item of evidence) {
    const observedMs = item.observedAt === undefined ? undefined : parseObservedAt(item.observedAt);
    for (const conceptId of new Set(item.conceptIds)) {
      const current = familiarity[conceptId] ?? {
        conceptId,
        observationCount: 0,
        maxConfidence: 0,
        sources: [],
      };
      const sources = current.sources.map((source) => ({ ...source }));
      let source = sources.find((entry) => entry.provider === item.source.provider);
      if (source === undefined) {
        source = { provider: item.source.provider, count: 0 };
        sources.push(source);
      }
      source.count += 1;
      if (
        observedMs !== undefined &&
        (source.lastObservedAt === undefined || observedMs > parseObservedAt(source.lastObservedAt))
      ) {
        source.lastObservedAt = item.observedAt;
      }
      sources.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));

      familiarity[conceptId] = {
        conceptId,
        observationCount: current.observationCount + 1,
        maxConfidence: Math.max(current.maxConfidence, item.confidence),
        ...(observedMs === undefined
          ? current.lastObservedAt === undefined
            ? {}
            : { lastObservedAt: current.lastObservedAt }
          : current.lastObservedAt === undefined ||
              observedMs > parseObservedAt(current.lastObservedAt)
            ? { lastObservedAt: item.observedAt }
            : { lastObservedAt: current.lastObservedAt }),
        sources,
      };
    }
  }

  return familiarity;
}

function parseObservedAt(observedAt: string): number {
  if (!isIsoDateTime(observedAt)) {
    throw new TypeError(`observedAt is not a valid ISO 8601 date-time: ${observedAt}`);
  }
  return Date.parse(observedAt);
}

// ---------------------------------------------------------------------------
// Learning Map の状態
// ---------------------------------------------------------------------------

/**
 * Mastery と Familiarity を合成して、Map 上の表示状態を導出する。
 *
 * - Mastery がある Concept はその状態（learning / confirmed）を使う。
 *   Familiarity は「触れた」だけであり、Mastery を底上げしない。
 * - Mastery が無く Familiarity だけある Concept は `familiar`。
 *   「過去に触れた形跡あり」と「一度も観測していない」を分けるための段階。
 * - どちらも無ければ `unobserved`。
 */
export function deriveLearningMapStatus(
  mastery: ConceptMastery | undefined,
  familiarity: ConceptFamiliarity | undefined,
): LearningMapStatus {
  if (mastery !== undefined) return mastery.status;
  if (familiarity !== undefined) return "familiar";
  return "unobserved";
}

// ---------------------------------------------------------------------------
// Analysis Router
// ---------------------------------------------------------------------------

/**
 * Router が管理する Provider の候補。
 *
 * `managed` は運営の予算を使う経路かどうか。Managed AI だけが
 * `AnalysisBudget` の対象であり、モード `user-ai` では選ばれない。
 */
export interface AnalysisProviderEntry {
  provider: AnalysisProvider;
  managed: boolean;
}

/** Router の選択結果。選べない場合は理由を持つ。 */
export type AnalysisSelection =
  | { kind: "provider"; provider: AnalysisProvider }
  | { kind: "unavailable"; reason: "no-provider" | "budget-exhausted" };

/**
 * 優先順位の先頭から、利用可能な最初の Provider を選ぶ。
 *
 * - `auto`: すべての候補を順に見る。Managed は予算の残りがある場合のみ。
 * - `user-ai`: Managed を除外して順に見る。
 * - `managed`: Managed だけを見る。
 *
 * 利用者が AI を持っていない場合や予算を使い切った場合は、
 * 黙って Managed へ倒さず「選べない」を理由付きで返す。
 * 「何が使えないか」を UI が説明できるようにするためである。
 */
export async function selectAnalysisProvider(
  entries: readonly AnalysisProviderEntry[],
  options: {
    mode: AnalysisMode;
    managedCallsUsed: number;
    budget: AnalysisBudget;
  },
): Promise<AnalysisSelection> {
  let skippedManaged = false;
  for (const entry of entries) {
    if (options.mode === "user-ai" && entry.managed) continue;
    if (options.mode === "managed" && !entry.managed) continue;
    if (!(await entry.provider.isAvailable())) continue;
    if (entry.managed && options.managedCallsUsed >= options.budget.managedAiMaxCalls) {
      skippedManaged = true;
      continue;
    }
    return { kind: "provider", provider: entry.provider };
  }
  return {
    kind: "unavailable",
    reason: skippedManaged ? "budget-exhausted" : "no-provider",
  };
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/** Calibration で利用者へ聞く Concept の上限。全部を聞かない（Issue #157）。 */
export const CALIBRATION_MAX_QUESTIONS = 5;

/**
 * Mastery を参照する導出関数が実際に読む最小の形。
 *
 * クライアント側は完全な `ConceptMastery` を持たない表示用の型で動くため、
 * ここで必要なのは status だけである。`ConceptMastery` はこの型を満たす。
 */
export type MasteryStatusView = Pick<ConceptMastery, "status">;

/**
 * Calibration で確認する Concept を選ぶ。
 *
 * 「確認価値の高いものだけ」を選ぶ。観測が多いほど Map への影響が大きく、
 * 推定を間違えたときの被害も大きいため、観測数の多い順に上限まで聞く。
 * 既に confirmed の Concept は聞き直さない（確認済みの根拠があるため）。
 *
 * 同率のときは Concept ID の昇順にし、結果を一意にする。
 */
export function selectCalibrationCandidates(options: {
  familiarity: Record<ConceptId, ConceptFamiliarity | undefined>;
  mastery: Record<ConceptId, MasteryStatusView | undefined>;
  limit?: number;
}): ConceptId[] {
  const { familiarity, mastery } = options;
  const limit = options.limit ?? CALIBRATION_MAX_QUESTIONS;

  return Object.values(familiarity)
    .filter((entry): entry is ConceptFamiliarity => entry !== undefined)
    .filter((entry) => mastery[entry.conceptId]?.status !== "confirmed")
    .sort(
      (a, b) =>
        b.observationCount - a.observationCount ||
        b.maxConfidence - a.maxConfidence ||
        (a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0),
    )
    .slice(0, limit)
    .map((entry) => entry.conceptId);
}

// ---------------------------------------------------------------------------
// Next step
// ---------------------------------------------------------------------------

/**
 * 「次に学ぶこと」の候補を返す。
 *
 * 過去に触れた形跡があるのに確定していない Concept を、
 * 最近触れた順に並べる。触れたばかりの Concept ほど、学び直しの
 * 文脈が生きているためである。confirmed は含めない。
 */
export function suggestNextConcepts(
  options: {
    familiarity: Record<ConceptId, ConceptFamiliarity | undefined>;
    mastery: Record<ConceptId, MasteryStatusView | undefined>;
  },
  limit = 3,
): ConceptId[] {
  const { familiarity, mastery } = options;

  return Object.values(familiarity)
    .filter((entry): entry is ConceptFamiliarity => entry !== undefined)
    .filter((entry) => mastery[entry.conceptId]?.status !== "confirmed")
    .sort((a, b) => {
      const aTime = a.lastObservedAt === undefined ? 0 : Date.parse(a.lastObservedAt);
      const bTime = b.lastObservedAt === undefined ? 0 : Date.parse(b.lastObservedAt);
      return (
        bTime - aTime ||
        b.observationCount - a.observationCount ||
        (a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0)
      );
    })
    .slice(0, limit)
    .map((entry) => entry.conceptId);
}

// ---------------------------------------------------------------------------
// Local preprocessing
// ---------------------------------------------------------------------------

/**
 * 会話本文がプログラミング関連かどうかの粗い判定。
 *
 * AI へ送る前にローカルで絞るためのフィルタ（Issue #157「ローカルで行う処理」）。
 * 精度よりも除外の確実さを優先する。関連かどうか曖昧なものは true 側へ倒し、
 * 明確に無関係と言えるものだけを落とす。厳しい判定は AI 側に任せる。
 */
const PROGRAMMING_SIGNALS: readonly RegExp[] = [
  // コードフェンス・インラインコード
  /```|`[^`]+`/,
  // 英語の開発用語
  /\b(error|exception|stack ?trace|compile|runtime|function|class|interface|type|import|export|const|let|var|return|async|await|promise|component|hook|api|sdk|cli|npm|pnpm|yarn|pip|cargo|git|docker|kubernetes|terraform|sql|database|query|schema|test|debug|deploy|build|lint|regex|algorithm|refactor)\b/i,
  // 言語名
  /\b(go|golang|typescript|javascript|python|rust|java|kotlin|swift|c\+\+|c#|php|ruby|html|css|react|vue|next\.?js|node\.?js|deno|bun)\b/i,
  // 日本語の開発用語
  /(コンパイル|エラー|例外|スタックトレース|関数|変数|引数|戻り値|クラス|インターフェース|継承|実装|デバッグ|テスト|ビルド|デプロイ|ライブラリ|フレームワーク|非同期|ポインタ|スライス|配列|オブジェクト|型付け|ジェネリクス|命名規則|設計|アルゴリズム)/,
];

export function isProbablyProgrammingRelated(text: string): boolean {
  return PROGRAMMING_SIGNALS.some((pattern) => pattern.test(text));
}
