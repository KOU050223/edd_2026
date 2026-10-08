/**
 * 確認問題（Issue #43 / #236）の取得・生成・採点と、生成画面の判断。
 *
 * 問題は利用者ごとに API が生成して保存する（apps/api/src/routes/checks.ts）。
 *
 * - 画面を開いたときは保存済みを読むだけで、AI は呼ばない（`GET /v1/checks`）。
 * - 利用者が技術レベルと範囲を選んで「作る」「作り直す」を押したときだけ生成する
 *   （`POST /v1/checks:generate`）。1組につき AI の利用回数を1回使う。
 * - 生成の前に、AI へ送る内容への同意をその場で取る。「今後表示しない」を選んだ人には出さない。
 *
 * 正誤の記録は `check-result.ts` が持つ。
 *
 * 描画から切り離してあるのは、jsdom が無くても検証できるようにするため
 * （apps/web/AGENTS.md）。
 */

import {
  CHECK_LEVELS,
  CHECK_LIMITS,
  CHECK_QUESTION_KINDS,
  CHECK_SCOPES,
  checkTargetOf,
  type CheckLevel,
  type CheckQuestion,
  type CheckQuestionKind,
  type CheckScope,
  type ConceptCheck,
  type ConceptId,
  type PersonalConceptCheck,
  type PracticeCheckQuestion,
} from "@gakushu-sochi/domain";
import { ApiError, requestJson, writeErrorOf } from "./api.js";
import type { CheckCorrectness } from "./check-result.js";
import { toErrorText } from "./errors.js";
import type { ObjectiveProgress } from "./learning-map.js";
import type { MasteryStatus } from "./overrides.js";

export const CHECKS_PATH = "/api/v1/checks";
export const CHECKS_GENERATE_PATH = "/api/v1/checks:generate";
export const CHECKS_EXPORT_PATH = "/api/v1/checks:export";
export const CHECK_GENERATION_CONSENT_PATH = "/api/v1/check-generation-consent";

/**
 * 生成の締め切り（RULE-001）。
 *
 * API は上流（Gemini）を送り直しも含めて 150 秒で切る。そこへ中継と保存の分を足す。
 * 他の書き込みと同じ 10 秒にすると、生成が終わる前にこちらが諦めてしまう。
 * 生成は時間がかかる前提で、上限を 3 分にする（#259 の決定）。
 */
export const CHECK_GENERATE_TIMEOUT_MS = 180_000;

/** 同意の記録の読み書きの締め切り（RULE-001）。 */
const CONSENT_TIMEOUT_MS = 10_000;

/**
 * 生成に失敗した理由を API が利用者向けの文で返したもの（形式の逸脱・回数の上限など）。
 *
 * 「失敗しました」だけでは再試行すれば直るのかが分からないため、
 * API が選んだ文面（`message`）をそのまま画面へ出す。
 */
export class CheckGenerationError extends ApiError {
  constructor(readonly detail: string) {
    super("unavailable");
  }
}

/**
 * 生成への同意が無い（または文面の版が変わった）ため、API が送る前に止めた。
 * 画面は同意の確認を出し直す。
 */
export class CheckConsentRequiredError extends ApiError {
  constructor(readonly version: number) {
    super("unavailable");
  }
}

function isQuestion(value: unknown): value is CheckQuestion {
  if (typeof value !== "object" || value === null) return false;
  const question = value as Record<string, unknown>;
  return (
    typeof question.prompt === "string" &&
    question.prompt.length > 0 &&
    Array.isArray(question.choices) &&
    question.choices.length === CHECK_LIMITS.choiceCount &&
    question.choices.every((choice) => typeof choice === "string" && choice.length > 0) &&
    Number.isInteger(question.answerIndex) &&
    (question.answerIndex as number) >= 0 &&
    (question.answerIndex as number) < question.choices.length &&
    typeof question.explanation === "string"
  );
}

function isPracticeQuestion(value: unknown): value is PracticeCheckQuestion {
  return (
    isQuestion(value) && typeof (value as unknown as Record<string, unknown>).code === "string"
  );
}

/**
 * 応答が求めた Concept の2問1組になっているかを見る。
 * 正解の添字が選択肢の外を指していると採点できないので、ここで弾く。
 */
export function isConceptCheck(value: unknown, conceptId: ConceptId): value is ConceptCheck {
  if (typeof value !== "object" || value === null) return false;
  const check = value as Record<string, unknown>;
  return (
    check.conceptId === conceptId &&
    isQuestion(check.overview) &&
    isPracticeQuestion(check.practice)
  );
}

/** 利用者ごとに保存した1組として読めるか。範囲が項目なら項目 ID も要る。 */
export function isPersonalConceptCheck(
  value: unknown,
  conceptId: ConceptId,
): value is PersonalConceptCheck {
  if (!isConceptCheck(value, conceptId)) return false;
  const check = value as unknown as Record<string, unknown>;
  return (
    (CHECK_SCOPES as readonly unknown[]).includes(check.scope) &&
    (CHECK_LEVELS as readonly unknown[]).includes(check.level) &&
    (check.scope === "objective"
      ? typeof check.objectiveId === "string"
      : check.objectiveId === undefined) &&
    typeof check.model === "string" &&
    typeof check.generatedAt === "string"
  );
}

/**
 * Concept で保存済みの組を読む。AI は呼ばない。
 *
 * 2xx でも形が違えば失敗にする（RULE-004）。採点できない問題を出すと、
 * 利用者の回答が正しくても不正解として記録されうる。
 */
export async function fetchSavedChecks(
  conceptId: ConceptId,
  fetcher: typeof fetch = fetch,
  sessionRetries: boolean | number = false,
): Promise<PersonalConceptCheck[]> {
  const body = await requestJson<unknown>(
    `${CHECKS_PATH}?conceptId=${encodeURIComponent(conceptId)}`,
    fetcher,
    sessionRetries,
  );
  const checks = (body as { checks?: unknown } | null)?.checks;
  if (
    !Array.isArray(checks) ||
    !checks.every((check) => isPersonalConceptCheck(check, conceptId))
  ) {
    console.error("saved checks did not match the expected shape", { conceptId });
    throw new ApiError("unavailable");
  }
  return checks;
}

/** 生成の要求。範囲が `objective` のときだけ `objectiveId` を持つ。 */
export interface CheckGenerateRequest {
  conceptId: ConceptId;
  scope: CheckScope;
  level: CheckLevel;
  objectiveId?: string;
  /** その場で同意した文面の版。「今後表示しない」の記録があれば省略できる。 */
  consentVersion?: number;
}

/** 1組を生成して保存する。同じ狙いの組があれば上書きになる（作り直し）。 */
export async function generateCheck(
  request: CheckGenerateRequest,
  fetcher: typeof fetch = fetch,
): Promise<PersonalConceptCheck> {
  let response: Response;
  try {
    response = await fetcher(CHECKS_GENERATE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
      signal: AbortSignal.timeout(CHECK_GENERATE_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError("unavailable");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      message?: unknown;
      version?: unknown;
    };
    if (body.error === "check generation consent required" && typeof body.version === "number") {
      throw new CheckConsentRequiredError(body.version);
    }
    // 送信の同意（Worker）やログインの失敗は、共通の種別へ分ける。
    const common = writeErrorOf(response.status, body);
    if (common.kind !== "unavailable" && common.kind !== "rate_limited") throw common;
    // 生成の失敗・回数の上限・未知の Concept は、API が画面向けの文を添えて返す。
    if (typeof body.message === "string" && body.message.length > 0) {
      throw new CheckGenerationError(body.message);
    }
    throw common;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("unavailable");
  }
  if (!isPersonalConceptCheck(body, request.conceptId)) {
    console.error("generated check did not match the expected shape", {
      conceptId: request.conceptId,
    });
    throw new ApiError("unavailable");
  }
  return body;
}

/** 生成への同意（「今後表示しない」）の状態。API の `CheckGenerationConsentBody`。 */
export interface CheckGenerationConsent {
  /** 今の文面の版。同意したときにこの値を送る。 */
  version: number;
  /** 今の版で「今後表示しない」を選んでいるか。 */
  granted: boolean;
  grantedAt?: string;
}

function isGenerationConsent(value: unknown): value is CheckGenerationConsent {
  if (typeof value !== "object" || value === null) return false;
  const consent = value as Record<string, unknown>;
  return (
    typeof consent.version === "number" &&
    typeof consent.granted === "boolean" &&
    (consent.grantedAt === undefined || typeof consent.grantedAt === "string")
  );
}

/**
 * 生成への同意の状態を読む。`path` は確認問題（既定）か、マップの AI 生成
 * （`MAP_GENERATION_CONSENT_PATH`、#243）。どちらも同じ形で返る。
 */
export async function fetchGenerationConsent(
  fetcher: typeof fetch = fetch,
  sessionRetries: boolean | number = false,
  path: string = CHECK_GENERATION_CONSENT_PATH,
): Promise<CheckGenerationConsent> {
  const body = await requestJson<unknown>(path, fetcher, sessionRetries);
  if (!isGenerationConsent(body)) throw new ApiError("unavailable");
  return body;
}

/** 「今後表示しない」を記録する、または取り消す。`path` は {@link fetchGenerationConsent} と同じ。 */
export async function changeGenerationConsent(
  change: { grant: number } | "revoke",
  fetcher: typeof fetch = fetch,
  path: string = CHECK_GENERATION_CONSENT_PATH,
): Promise<CheckGenerationConsent> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method: change === "revoke" ? "DELETE" : "PUT",
      ...(change === "revoke"
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: change.grant }),
          }),
      cache: "no-store",
      signal: AbortSignal.timeout(CONSENT_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError("unavailable");
  }
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    const failure = (body ?? {}) as { error?: unknown };
    // 古い文面を見て押した同意。画面を読み込み直して最新の文面を見せる。
    if (failure.error === "consent_outdated") throw new ApiError("consent_outdated");
    throw writeErrorOf(response.status, failure);
  }
  if (!isGenerationConsent(body)) throw new ApiError("unavailable");
  return body;
}

/** 失敗を確認問題の画面向けの文にする。 */
export function checkErrorText(error: unknown): string {
  if (error instanceof CheckGenerationError) return error.detail;
  // 既定の「学習データの取得に失敗しました」は、問題を作れなかった場面に合わない。
  if (error instanceof ApiError && error.kind === "unavailable")
    return "確認問題を用意できませんでした。時間をおいて、もう一度お試しください。";
  return toErrorText(error);
}

/** 各問で選んだ選択肢の添字。未回答は `undefined`。 */
export type CheckAnswers = Partial<Record<CheckQuestionKind, number>>;

/**
 * 2問とも答えたときだけ正誤を返す。1問でも未回答なら `null`。
 *
 * 片方だけで採点させないのは、#43 の「2問まとめて判定」を崩さないため。
 * 未回答を不正解として送ると、解き終えていない組が `check_failed` として残る。
 */
export function gradeCheck(check: ConceptCheck, answers: CheckAnswers): CheckCorrectness | null {
  if (CHECK_QUESTION_KINDS.some((kind) => answers[kind] === undefined)) return null;
  return {
    overview: answers.overview === check.overview.answerIndex,
    practice: answers.practice === check.practice.answerIndex,
  };
}

/**
 * 領域（言語）の今の技術レベル。生成画面で「推奨」として示す（#236 の決定）。
 *
 * 目安の規則はこの画面だけの仮のもので、マップ全体の目安（#239）とは別である。
 * 領域の Concept のうち確認済みの割合が 1/3 未満なら入門、2/3 未満なら基礎、それ以上は応用。
 */
export function recommendedLevel(statuses: readonly MasteryStatus[]): {
  level: CheckLevel;
  confirmed: number;
  total: number;
} {
  const total = statuses.length;
  const confirmed = statuses.filter((status) => status === "confirmed").length;
  // 割合を整数で比べ、浮動小数の誤差で境界を揺らさない。
  const level: CheckLevel =
    confirmed * 3 < total ? "intro" : confirmed * 3 < total * 2 ? "basic" : "advanced";
  return { level, confirmed, total };
}

/**
 * 「理解すること」のうち、最初から選んでおく項目。
 *
 * **まだ満点（1.0）でない項目**を選ぶ（#226 の決定）。ただし作ってある組がある項目は外す。
 * 作り直すと回数を使うので、作り直しは利用者が明示的に選んだときだけにする。
 */
export function defaultObjectiveSelection(
  objectives: readonly ObjectiveProgress[],
  savedTargets: ReadonlySet<string>,
): string[] {
  return objectives
    .filter((objective) => (objective.value ?? 0) < 1 && !savedTargets.has(objective.id))
    .map((objective) => objective.id);
}

/** 保存済みの組の狙いの集合。生成画面の「作成済み」の印と既定の選択に使う。 */
export function savedTargetsOf(checks: readonly PersonalConceptCheck[]): Set<string> {
  return new Set(checks.map(checkTargetOf));
}

/**
 * 生成した組を一覧へ入れる。同じ狙いの組があれば置き換えて先頭へ、無ければ先頭へ足す。
 * API の上書き（作り直し）と同じ規則で、一覧に同じ狙いが2つ並ばないようにする。
 */
export function upsertCheck(
  checks: readonly PersonalConceptCheck[],
  generated: PersonalConceptCheck,
): PersonalConceptCheck[] {
  const target = checkTargetOf(generated);
  return [generated, ...checks.filter((check) => checkTargetOf(check) !== target)];
}

/**
 * 組を出す順番（#270 の決定）。「理解すること」の一覧の上から順（AI へ渡す順と同じ）で、
 * Concept 全体の組は先頭。作った日時では並べ替えず、作り直しても位置は変わらない。
 * 狙い1つにつき組は1つ（作り直しは上書き）なので、出すのはいつも最新の組になる。
 * 一覧に無い項目の組は末尾に、元の並びのまま置く。
 */
export function orderedChecks(
  checks: readonly PersonalConceptCheck[],
  objectiveIds: readonly string[],
): PersonalConceptCheck[] {
  const rank = (check: PersonalConceptCheck) => {
    if (check.objectiveId === undefined) return -1;
    const index = objectiveIds.indexOf(check.objectiveId);
    return index === -1 ? objectiveIds.length : index;
  };
  return [...checks].sort((left, right) => rank(left) - rank(right));
}

/**
 * 解いている1組を指す鍵。作り直すと日時が、解き直すと回（`round`）が変わり、
 * 前の採点の結果を引き継がない。
 */
export function checkSetKey(check: PersonalConceptCheck, round: number): string {
  return `${checkTargetOf(check)}:${check.generatedAt}:${String(round)}`;
}

/**
 * 「次の組へ」「スキップ」で移る先（#270）。今の組より後ろで、まだ終えていない最初の組。
 * 後ろに無ければ前から探す。解いている組より上の項目の組があとからできても
 * （項目を一覧と違う順に選んだときや、上の項目を作り直したとき）、出さないまままとめへ進まない。終えていない組が無ければ `undefined`（まとめへ）。
 *
 * @param open 並びの順に、まだ終えていない（採点も「次へ」もしていない）か。
 */
export function nextCheckIndex(open: readonly boolean[], position: number): number | undefined {
  const isOpen = (index: number) => index !== position && open[index] === true;
  for (let index = position + 1; index < open.length; index += 1) if (isOpen(index)) return index;
  for (let index = 0; index < position; index += 1) if (isOpen(index)) return index;
  return undefined;
}

/**
 * 全部の組を終えたときのまとめ（#270 の決定）。例「3 組中 2 組正解」。
 * スキップした組は採点していないので、正解に数えない。スキップの数は出さない。
 *
 * @param results 採点した組の鍵（`checkSetKey`）と、2問とも正解だったか。
 */
export function checkTally(
  checks: readonly PersonalConceptCheck[],
  round: number,
  results: ReadonlyMap<string, boolean>,
): { total: number; passed: number } {
  return {
    total: checks.length,
    passed: checks.filter((check) => results.get(checkSetKey(check, round)) === true).length,
  };
}

/** 生成する狙い1つ。範囲が項目なら項目 ID を持つ。 */
export type CheckTarget = { scope: CheckScope; objectiveId?: string };

/**
 * 生成する狙いの一覧（#236 のコメント 5987364522）。
 *
 * - Concept 単位: 項目を持つ Concept では、**まだ 1.0 でない項目を自動ですべて選び、1項目1組**。
 *   作成済みの項目は外す（作り直しは組ごとのボタンで行い、回数を黙って使わない）。
 *   項目を持たない Concept では、まだ作っていなければ Concept の定義から1組。
 * - 理解すること単位: 利用者が選んだ項目ごとに1組。
 *
 * 項目を持つ Concept で項目を狙わない組は作らない。正誤が項目の理解度に効かないため。
 */
export function generationTargets(
  scope: CheckScope,
  objectives: readonly ObjectiveProgress[],
  selectedObjectiveIds: readonly string[],
  savedTargets: ReadonlySet<string>,
): CheckTarget[] {
  const objectiveTargets = (ids: readonly string[]) =>
    ids.map((objectiveId): CheckTarget => ({ scope: "objective", objectiveId }));
  if (scope === "objective") return objectiveTargets(selectedObjectiveIds);
  if (objectives.length === 0) return savedTargets.has("concept") ? [] : [{ scope: "concept" }];
  return objectiveTargets(defaultObjectiveSelection(objectives, savedTargets));
}

/** すべての項目が 1.0 に達しているか。達していれば作るボタンを「復習する」に変える。 */
export function allObjectivesUnderstood(objectives: readonly ObjectiveProgress[]): boolean {
  return objectives.length > 0 && objectives.every((objective) => (objective.value ?? 0) >= 1);
}

/** `GET /v1/checks:export` の応答。 */
export interface CheckExport {
  version: number;
  exportedAt: string;
  checks: PersonalConceptCheck[];
}

/** 保存済みの全件をエクスポート用に読む。2xx でも形が違えば失敗にする（RULE-004）。 */
export async function fetchChecksExport(
  fetcher: typeof fetch = fetch,
  sessionRetries: boolean | number = false,
): Promise<CheckExport> {
  const body = await requestJson<unknown>(CHECKS_EXPORT_PATH, fetcher, sessionRetries);
  const result = (body ?? {}) as Record<string, unknown>;
  if (
    typeof result.version !== "number" ||
    typeof result.exportedAt !== "string" ||
    !Array.isArray(result.checks) ||
    !result.checks.every(
      (check) =>
        typeof check === "object" &&
        check !== null &&
        isPersonalConceptCheck(check, (check as { conceptId?: unknown }).conceptId as ConceptId),
    )
  ) {
    throw new ApiError("unavailable");
  }
  return result as unknown as CheckExport;
}

export function exportChecksFileName(now: Date): string {
  return `gakushu-sochi-checks-${now.toISOString().slice(0, 10)}.json`;
}
