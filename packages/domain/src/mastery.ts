/**
 * 学習イベントから習熟度を導出する純粋関数。
 *
 * profile.ts と同じく VS Code API にも HTTP にも DB にも依存しない。
 * ルールは docs/concepts.md の「習熟度の更新ルール」が正典であり、ここはその実装。
 *
 * 入口は2つあり、係数と判定条件（{@link SCORE_DELTA} / {@link deriveStatus}）は共有する。
 *
 * - {@link applyEvent}: 手元の LearnerProfile へ1件を追記する。クライアントの
 *   楽観的なローカルキャッシュ更新に使う。
 * - {@link deriveMasteryFromEvents}: イベントログ全体から習熟度を導出し直す。
 *   API Server が正本を計算するのに使う。
 *
 * 両者は結果が食い違いうる。オフラインキューの同期でイベントが発生順と異なる順に
 * 届いた場合、クライアントは到着順に畳み込み、サーバーは発生時刻順に畳み込むためである。
 * これは不具合ではなく、docs/architecture.md が定める「サーバーの導出結果を正本とする」
 * 設計の帰結である。差異はクライアントが同期後にサーバーの Profile を取り込んで解消する。
 */

import type { LearningObjective } from "./learning-objective.js";
import {
  MASTERY_SCORE_RANGE,
  type ConceptId,
  type ConceptMastery,
  type LearnerProfile,
  type LearningEvent,
  type LearningEventType,
  type MasteryEvidence,
  type MasteryStatus,
} from "./profile.js";

/**
 * イベント種別ごとの score 加減。docs/concepts.md の表と一致させること。
 *
 * Record<LearningEventType, number> にしているのは、LearningEventType へ
 * 種別が追加されたときにこの定義がコンパイルエラーになり、係数を決め忘れたまま
 * 新種別を素通りさせないため。
 */
const SCORE_DELTA: Record<LearningEventType, number> = {
  question_asked: 0,
  answer_viewed: 0,
  solved_independently: 0.25,
  error_recurred: -0.2,
  check_passed: 0.2,
  check_failed: -0.15,
};

/** 質問だけで上がる、項目1つあたりの理解度の上限。docs/concepts.md 参照。 */
const QUESTION_OBJECTIVE_CAP = 0.5;

/**
 * イベント種別ごとの、触れた「理解すること」の項目1つへの影響（設計/04 #223）。
 * docs/concepts.md の表と一致させること。Record にしている理由は {@link SCORE_DELTA} と同じ。
 *
 * 質問は上げるだけで下げない。下げるのは確認問題の不正解だけで、
 * 同じエラーの再発（`error_recurred`）は evidence に記録するだけで項目の値は動かさない。
 */
const OBJECTIVE_UPDATE: Record<LearningEventType, (value: number) => number> = {
  question_asked: (value) =>
    value >= QUESTION_OBJECTIVE_CAP ? value : Math.min(value + 0.05, QUESTION_OBJECTIVE_CAP),
  answer_viewed: (value) => value,
  solved_independently: (value) => Math.min(value + 0.5, 1),
  error_recurred: (value) => value,
  check_passed: () => 1,
  check_failed: (value) => Math.max(value - 0.25, 0),
};

/**
 * 項目の平均がこれ以上（0.01 単位。90 は 0.9）で、かつ全項目に進みがあれば確認済み。
 * docs/concepts.md 参照。浮動小数を掛けて作らないよう、最初から整数で持つ。
 */
const OBJECTIVE_CONFIRMED_AVERAGE_HUNDREDTHS = 90;

/** recentTypes に保持する直近イベントの上限件数。docs/concepts.md 参照。 */
const RECENT_TYPES_LIMIT = 5;

/** events 配列の保存上限。超えた分は古いものから捨てる。docs/concepts.md 参照。 */
const EVENT_HISTORY_LIMIT = 1000;

const EMPTY_EVIDENCE: MasteryEvidence = {
  questionCount: 0,
  answerViewCount: 0,
  solvedIndependentlyCount: 0,
  errorRecurrenceCount: 0,
  checkPassedCount: 0,
  checkFailedCount: 0,
  recentTypes: [],
};

function clampScore(score: number, status: MasteryStatus): number {
  const range = MASTERY_SCORE_RANGE[status];
  return Math.min(range.max, Math.max(range.min, score));
}

/**
 * evidence から status を導出する。
 *
 * `unobserved` はここでは返らない。この関数は「その Concept に対する
 * イベントが少なくとも1件ある」ことが前提の経路（後述の foldEventIntoMastery）
 * からしか呼ばれず、`unobserved` は `LearnerProfile.mastery` にエントリ自体が
 * 無いことで表現するため。
 */
function deriveStatus(evidence: MasteryEvidence): MasteryStatus {
  const hasRecentFailure = evidence.recentTypes.some(
    (type) => type === "error_recurred" || type === "check_failed",
  );
  const confirmed =
    evidence.solvedIndependentlyCount + evidence.checkPassedCount >= 2 && !hasRecentFailure;

  return confirmed ? "confirmed" : "learning";
}

function incrementEvidenceCount(
  evidence: MasteryEvidence,
  type: LearningEventType,
): MasteryEvidence {
  switch (type) {
    case "question_asked":
      return { ...evidence, questionCount: evidence.questionCount + 1 };
    case "answer_viewed":
      return { ...evidence, answerViewCount: evidence.answerViewCount + 1 };
    case "solved_independently":
      return { ...evidence, solvedIndependentlyCount: evidence.solvedIndependentlyCount + 1 };
    case "error_recurred":
      return { ...evidence, errorRecurrenceCount: evidence.errorRecurrenceCount + 1 };
    case "check_passed":
      return { ...evidence, checkPassedCount: evidence.checkPassedCount + 1 };
    case "check_failed":
      return { ...evidence, checkFailedCount: evidence.checkFailedCount + 1 };
  }
}

/**
 * 項目の値を 0.01 単位へ丸める。
 *
 * 係数は 0.05 刻みだが、浮動小数で足し続けると 0.15000000000000002 のような値になり、
 * 確認済みの閾値（平均 0.9）をわずかに下回って判定が揺れる。
 */
function roundObjectiveValue(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 項目ごとの値から、その Concept の status と score を導く（設計/04 #223）。
 *
 * score は項目の平均。確認済みは「平均が 0.9 以上」かつ
 * 「値が 0 の項目が無い」。閾値だけだと、項目の多い Concept で1項目まったく触れて
 * いなくても届くため、2つを組み合わせる。比較は 0.01 単位の整数で行い、浮動小数の誤差を持ち込まない。
 */
function deriveFromObjectives(values: Record<string, number>): {
  status: MasteryStatus;
  score: number;
} {
  const hundredths = Object.values(values).map((value) => Math.round(value * 100));
  const total = hundredths.reduce((sum, value) => sum + value, 0);
  const confirmed =
    total >= OBJECTIVE_CONFIRMED_AVERAGE_HUNDREDTHS * hundredths.length &&
    hundredths.every((value) => value > 0);
  return { status: confirmed ? "confirmed" : "learning", score: total / (100 * hundredths.length) };
}

/**
 * 1件のイベントを、ある Concept の習熟度へ畳み込む唯一の規則。
 *
 * {@link applyEvent} と {@link deriveMasteryFromEvents} の双方がこれを呼ぶ。
 * 係数や判定順序をここ以外に複製すると、クライアントとサーバーで習熟度の意味が
 * ずれる。
 *
 * `conceptObjectives`（この Concept の「理解すること」の一覧）が空なら、回数による
 * 従来の判定を使う。docs/concepts.md の通り、status を先に判定してから score をクランプする。
 * 空でなければ、項目ごとの値を更新し、その平均と全項目の進みで判定する（設計/04 #223）。
 * 項目の値は毎回この一覧に合わせ直すので、消えた項目の値は捨てられ、増えた項目は 0 から始まる。
 */
export function foldEventIntoMastery(
  conceptId: ConceptId,
  mastery: ConceptMastery | undefined,
  event: LearningEvent,
  conceptObjectives: readonly LearningObjective[] = [],
): ConceptMastery {
  const previousEvidence = mastery?.evidence ?? EMPTY_EVIDENCE;
  const evidence: MasteryEvidence = {
    ...incrementEvidenceCount(previousEvidence, event.type),
    recentTypes: [...previousEvidence.recentTypes, event.type].slice(-RECENT_TYPES_LIMIT),
    lastObservedAt: event.occurredAt,
  };

  if (conceptObjectives.length === 0) {
    const status = deriveStatus(evidence);
    const score = clampScore((mastery?.score ?? 0) + SCORE_DELTA[event.type], status);
    return { conceptId, status, score, evidence };
  }

  const previous = mastery?.objectives ?? {};
  const touched = new Set(event.objectiveIds ?? []);
  const objectives: Record<string, number> = {};
  for (const { id } of conceptObjectives) {
    const before = previous[id] ?? 0;
    objectives[id] = touched.has(id)
      ? roundObjectiveValue(OBJECTIVE_UPDATE[event.type](before))
      : before;
  }

  return { conceptId, ...deriveFromObjectives(objectives), evidence, objectives };
}

/** 「理解すること」の一覧を Concept ごとにまとめる。 */
function groupObjectivesByConcept(
  objectives: readonly LearningObjective[],
): Map<ConceptId, LearningObjective[]> {
  const byConcept = new Map<ConceptId, LearningObjective[]>();
  for (const objective of objectives) {
    byConcept.set(objective.conceptId, [...(byConcept.get(objective.conceptId) ?? []), objective]);
  }
  return byConcept;
}

/**
 * 1件の学習イベントを LearnerProfile へ追記し、関係する Concept の習熟度を
 * 更新した新しい LearnerProfile を返す（引数は書き換えない）。
 *
 * `event.conceptIds` が空の場合は events への追記のみ行い、mastery は変えない
 * （AIがConceptを特定できなかった質問も、記録自体は残す）。
 *
 * @param objectives その時点の「理解すること」の一覧。{@link foldEventIntoMastery} を参照。
 */
export function applyEvent(
  profile: LearnerProfile,
  event: LearningEvent,
  objectives: readonly LearningObjective[] = [],
): LearnerProfile {
  const events = [...profile.events, event].slice(-EVENT_HISTORY_LIMIT);

  const objectivesByConcept = groupObjectivesByConcept(objectives);
  const mastery = { ...profile.mastery };
  for (const conceptId of uniqueConceptIds(event)) {
    mastery[conceptId] = foldEventIntoMastery(
      conceptId,
      mastery[conceptId],
      event,
      objectivesByConcept.get(conceptId),
    );
  }

  return { ...profile, updatedAt: event.occurredAt, mastery, events };
}

/**
 * 1件のイベントが対象とする Concept を、重複を除いて返す。
 *
 * `conceptIds` は配列であり、同じ ID が複数入りうる。除かずに畳み込むと
 * 1件のイベントで evidence が二重に加算され、自力解決を1回しただけで
 * `confirmed`（score 0.7）へ到達する。`recentTypes` にも同じ種別が2つ積まれ、
 * `confirmed` の判定窓（直近5件）まで歪む。
 *
 * 除去はここで行い、HTTP の契約やクライアントの解析側に持たせない。
 * 二重計上が起きるのはこの畳み込みだけであり、境界を分散させると
 * 守り忘れる場所が増える。誰が配列を作ったかに関わらず、ドメインの側で成立させる。
 */
function uniqueConceptIds(event: LearningEvent): Iterable<ConceptId> {
  return new Set(event.conceptIds);
}

/**
 * イベントログ全体から習熟度を導出し直す。API Server が正本を計算する入口。
 *
 * オフラインキューを同期するため、イベントは発生順とは異なる順に到着しうる。
 * そのため到着順ではなく発生時刻順に畳み込む。docs/architecture.md の
 * 「習熟度のルールはイベント到着順ではなく、発生時刻と安定したタイブレーク規則を
 * 前提に設計する」に対応する。
 *
 * @param events 任意の順序でよい。この関数は引数を書き換えない。
 * @param objectives その時点の「理解すること」の一覧。項目の増減は、この一覧で
 *   導出し直すことで反映される（設計/04 #223）。{@link foldEventIntoMastery} を参照。
 * @returns Concept ID をキーにした習熟度。イベントが1件も無い Concept は
 *   キー自体が存在しない。`unobserved` を値として持たせると「未観測」と
 *   「観測した結果スコアが0」を UI が区別できなくなるため、
 *   {@link deriveStatus} と同じく「エントリが無いこと」で未観測を表現する。
 */
export function deriveMasteryFromEvents(
  events: readonly LearningEvent[],
  objectives: readonly LearningObjective[] = [],
): Record<ConceptId, ConceptMastery | undefined> {
  const mastery: Record<ConceptId, ConceptMastery | undefined> = {};
  const objectivesByConcept = groupObjectivesByConcept(objectives);

  // 並べ替える前に全件の時刻を検証する。sort は要素が1件だと比較関数を呼ばないため、
  // compareEventOrder の中の検査だけに頼ると、イベントが1件のときに壊れた occurredAt が
  // 素通りする。件数によって検証されたりされなかったりする状態を作らない。
  const ordered = events.map((event) => ({ event, epochMs: toEpochMs(event.occurredAt) }));
  ordered.sort(compareEventOrder);

  for (const { event } of ordered) {
    for (const conceptId of uniqueConceptIds(event)) {
      mastery[conceptId] = foldEventIntoMastery(
        conceptId,
        mastery[conceptId],
        event,
        objectivesByConcept.get(conceptId),
      );
    }
  }

  return mastery;
}

/**
 * イベントの畳み込み順序。発生時刻の昇順、同時刻は ID の昇順。
 *
 * `occurredAt` は ISO 8601 文字列だが、タイムゾーンオフセットや小数秒の桁数は
 * クライアントによって異なりうるため、文字列の辞書順で比較してはならない。
 * 必ず時刻としてパースして比較する。
 *
 * ID によるタイブレークは、同時刻のイベントが複数あっても導出結果を一意にするために要る。
 * これが無いと、同じイベント集合でも入力順によって score が変わり、サーバーの
 * 導出結果が「正本」として安定しない。
 */
function compareEventOrder(a: OrderedEvent, b: OrderedEvent): number {
  const timeDiff = a.epochMs - b.epochMs;
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0;
}

/** 並べ替えのために発生時刻を数値へ解決したイベント。 */
interface OrderedEvent {
  event: LearningEvent;
  epochMs: number;
}

/**
 * ISO 8601 文字列を epoch ミリ秒へ変換する。
 *
 * パースできない値は握りつぶさず例外にする。ここで NaN や 0 へ丸めると、
 * 壊れた時刻を持つイベントが黙って先頭へ並び、習熟度の導出結果を汚染したまま
 * 正常応答として返ってしまう。呼び出し側（API の同期境界）が受理前に
 * 弾けるよう、失敗を値ではなく例外として表に出す。
 */
function toEpochMs(occurredAt: string): number {
  if (!isIsoDateTime(occurredAt)) {
    throw new TypeError(`occurredAt is not a valid ISO 8601 date-time: ${occurredAt}`);
  }
  return Date.parse(occurredAt);
}

/**
 * ISO 8601 の date-time であり、UTC またはオフセット付きであることを要求する。
 *
 * `Date.parse` の成功だけを条件にしてはならない。`"2026/09/05"` や
 * `"September 5, 2026"` は解釈できてしまい、しかも**実行環境のタイムゾーンで**
 * 解釈される。同じ入力が開発機と Worker で別の時刻になり、習熟度の畳み込み順が
 * 環境によって変わる。
 *
 * 同じ理由で、オフセットの無い `"2026-09-05T00:00:00"` や日付のみの
 * `"2026-09-05"` も受け付けない。前者はローカル時刻として解釈され、後者は
 * UTC 深夜として解釈されるが、いずれも送信側が意図した瞬間を一意に表さない。
 */
export function isIsoDateTime(value: string): boolean {
  if (!ISO_DATE_TIME_PATTERN.test(value)) {
    return false;
  }
  // 形式が合っていても Date.parse が解釈できない値は弾く。
  //
  // ただし `2026-02-31` のような存在しない日付は弾けない。Date.parse は
  // これを 3/3 へ繰り上げて解釈する。暦の妥当性まで検査しないのは、
  // ここで守りたいのが「送信側が意図した瞬間が一意に定まること」であり、
  // 繰り上げは一意に定まるためである。誤った日付を送るのはクライアントの
  // 不具合であって、この関数の責務ではない。
  return !Number.isNaN(Date.parse(value));
}

/** `YYYY-MM-DDTHH:MM:SS[.sss](Z|±HH:MM)`。オフセットは必須。 */
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
