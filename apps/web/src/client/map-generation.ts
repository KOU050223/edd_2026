/**
 * 学習マップの AI 生成（Issue #243 / Web/19）と、作るときの確認問題（#247）。
 *
 * 契約は apps/api/src/contract/learning-maps.ts。Web は API のパッケージを import しないので、
 * 使う形だけをここに写す。描画から切り離してあるのは、jsdom が無くても検証できるようにするため
 * （apps/web/AGENTS.md）。
 *
 * 流れ: テーマ・目標を入れて `POST /v1/learning-maps:generate` → 「確認問題も作る」なら
 * 続けて `POST /v1/learning-maps/:id/checks:generate` → Web/18 の編集画面で開く。
 */

import { CHECK_LEVELS, type CheckLevel, type PersonalConceptCheck } from "@gakushu-sochi/domain";
import type { AiUsageSummary } from "./ai-usage.js";
import { ApiError, writeErrorOf } from "./api.js";
import { LEARNING_MAPS_PATH, MapLimitError, type LearningMapView } from "./learning-maps.js";

export const MAP_GENERATE_PATH = `${LEARNING_MAPS_PATH}:generate`;
export const MAP_GENERATION_CONSENT_PATH = "/api/v1/map-generation-consent";

/** API と同じ入力の上限。入力欄の `maxLength` に使う。 */
export const MAP_GENERATION_LIMITS = { theme: 80, goal: 400 } as const;

/**
 * 1マップの生成で使う AI の利用回数（API の `MAP_GENERATION_USAGE_COST`）。
 * 確認問題も作るなら、さらに同じ回数を使う（#247）。
 */
export const MAP_GENERATION_COST = 5;

/**
 * マップの生成の締め切り（RULE-001）。
 *
 * API は骨組みと「理解すること」を順に作り、それぞれ上流を最大 150 秒待つ（送り直しを含む）。
 * そこへ保存と中継の分を足す。確認問題の生成（`CHECK_GENERATE_TIMEOUT_MS`、3 分）より長い。
 */
export const MAP_GENERATE_TIMEOUT_MS = 330_000;

/** 作成時の確認問題の締め切り。上流は並列で1巡なので、確認問題の生成と同じ 3 分。 */
export const CREATION_CHECKS_TIMEOUT_MS = 180_000;

/** 生成の種類。 */
export type MapGenerationKind = "field" | "goal";

export const MAP_GENERATION_KIND_LABELS: Record<MapGenerationKind, string> = {
  field: "分野の全体マップ",
  goal: "目標までのマップ",
};

/** 生成の要求。`goal` は目標までのマップでだけ送る。 */
export interface MapGenerateRequest {
  kind: MapGenerationKind;
  theme: string;
  goal?: string;
  level: CheckLevel;
  checks: boolean;
  /** その場で同意した文面の版。「今後表示しない」の記録があれば省く。 */
  consentVersion?: number;
}

/**
 * 入力欄の値から要求を組み立てる。送れない入力（空のテーマ、目標までのマップで空の目標）なら `undefined`。
 * 分野の全体マップでは目標を送らない（API は受け取らない）。
 */
export function buildMapGenerateRequest(input: {
  kind: MapGenerationKind;
  theme: string;
  goal: string;
  level: CheckLevel;
  checks: boolean;
}): Omit<MapGenerateRequest, "consentVersion"> | undefined {
  const theme = input.theme.trim();
  const goal = input.goal.trim();
  if (theme === "" || !(CHECK_LEVELS as readonly string[]).includes(input.level)) return undefined;
  if (input.kind === "goal" && goal === "") return undefined;
  return {
    kind: input.kind,
    theme,
    ...(input.kind === "goal" ? { goal } : {}),
    level: input.level,
    checks: input.checks,
  };
}

/** 生成に要る回数。確認問題も作るなら倍になる。 */
export function generationCost(withChecks: boolean): number {
  return withChecks ? MAP_GENERATION_COST * 2 : MAP_GENERATION_COST;
}

/** 今使える回数（日と月の残りの小さい方）。 */
export function remainingRequests(usage: AiUsageSummary): number {
  const { daily, monthly } = usage.managedAi;
  return Math.max(0, Math.min(daily.limit - daily.used, monthly.limit - monthly.used));
}

/** 生成への同意が無い（または文面の版が変わった）ため、API が送る前に止めた。 */
export class MapConsentRequiredError extends ApiError {
  constructor(readonly version: number) {
    super("unavailable");
  }
}

/**
 * 生成に失敗した理由を API が利用者向けの文で返したもの（形式の逸脱・回数の上限など）。
 * 文面をそのまま出す。途中までのマップは API が保存していない。
 */
export class MapGenerationError extends ApiError {
  constructor(readonly detail: string) {
    super("unavailable");
  }
}

/** 作成時の確認問題を作れなかった。`retryable` なら、もう一度だけ頼める。 */
export class CreationChecksError extends ApiError {
  constructor(
    readonly detail: string,
    readonly retryable: boolean,
  ) {
    super("unavailable");
  }
}

/** POST して JSON を読む。失敗の本文は `onFailure` に渡し、そこで種類ごとの例外にする。 */
async function postJson(
  path: string,
  payload: unknown,
  fetcher: typeof fetch,
  timeoutMs: number,
  onFailure: (status: number, body: Record<string, unknown>) => never,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError("unavailable");
  }
  if (!response.ok) {
    // 読めない本文は空として扱い、状態コードで分ける。
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    onFailure(response.status, body);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    // 2xx でも本文が読めなければ失敗として扱う（RULE-004）。
    throw new ApiError("unavailable");
  }
}

/** API が画面向けの文を添えた失敗なら、それを持つ例外にする。無ければ共通の種別にする。 */
function withMessage(
  status: number,
  body: Record<string, unknown>,
  make: (message: string) => ApiError,
): never {
  // 送信の同意（Worker）やログインの失敗は、共通の種別へ分ける。
  const common = writeErrorOf(status, body);
  if (common.kind !== "unavailable" && common.kind !== "rate_limited") throw common;
  if (typeof body.message === "string" && body.message.length > 0) throw make(body.message);
  throw common;
}

/** テーマ・目標から AI でマップを作って保存する。数分かかることがある。 */
export async function generateLearningMap(
  request: MapGenerateRequest,
  fetcher: typeof fetch = fetch,
): Promise<LearningMapView> {
  const body = await postJson(
    MAP_GENERATE_PATH,
    request,
    fetcher,
    MAP_GENERATE_TIMEOUT_MS,
    (status, failure) => {
      if (
        failure.error === "map generation consent required" &&
        typeof failure.version === "number"
      ) {
        throw new MapConsentRequiredError(failure.version);
      }
      if (status === 409 && failure.error === "learning_map_limit_reached") {
        throw new MapLimitError();
      }
      return withMessage(status, failure, (message) => new MapGenerationError(message));
    },
  );
  const map = (body as { map?: unknown } | null)?.map;
  if (!isMapView(map)) throw new ApiError("unavailable");
  return map;
}

/** `POST /v1/learning-maps/:id/checks:generate` の応答。 */
export interface CreationChecksResult {
  checks: PersonalConceptCheck[];
  /** 頼んだが作れなかった組の数。 */
  failedCount: number;
  /** 入力の上限や回数分のトークンに収まらず、頼まなかった組の数。 */
  skippedCount: number;
}

/** AI で作ったマップに、作成時の確認問題を作る（#247）。 */
export async function generateCreationChecks(
  mapId: string,
  fetcher: typeof fetch = fetch,
): Promise<CreationChecksResult> {
  const body = await postJson(
    `${LEARNING_MAPS_PATH}/${encodeURIComponent(mapId)}/checks:generate`,
    {},
    fetcher,
    CREATION_CHECKS_TIMEOUT_MS,
    (status, failure) =>
      withMessage(
        status,
        failure,
        (message) => new CreationChecksError(message, failure.retryable === true),
      ),
  );
  if (!isCreationChecksResult(body)) throw new ApiError("unavailable");
  return body;
}

/**
 * 取り込んだマップを公開する前に、まだ公開の問題が無いノードの確認問題を作る（#246 の V4-a）。
 * 同意はマップの生成の同意を使う。同意が無ければ {@link MapConsentRequiredError}。
 */
export async function generateForkChecks(
  mapId: string,
  request: { level: CheckLevel; consentVersion?: number },
  fetcher: typeof fetch = fetch,
): Promise<CreationChecksResult> {
  const body = await postJson(
    `${LEARNING_MAPS_PATH}/${encodeURIComponent(mapId)}/fork-checks:generate`,
    request,
    fetcher,
    CREATION_CHECKS_TIMEOUT_MS,
    (status, failure) => {
      if (
        failure.error === "map generation consent required" &&
        typeof failure.version === "number"
      ) {
        throw new MapConsentRequiredError(failure.version);
      }
      if (status === 409 && failure.error === "creation_checks_level_locked") {
        throw new CreationChecksError(
          "一度頼んだあとは、最初に選んだ技術レベルでしか作り直せません。",
          true,
        );
      }
      return withMessage(
        status,
        failure,
        (message) => new CreationChecksError(message, failure.retryable === true),
      );
    },
  );
  if (!isCreationChecksResult(body)) throw new ApiError("unavailable");
  return body;
}

/** 作成時の確認問題の結果を、画面に出す1文にする。 */
export function creationChecksSummary(result: CreationChecksResult): string {
  const missed = result.failedCount + result.skippedCount;
  return missed === 0
    ? `確認問題を ${String(result.checks.length)} 組作りました。`
    : `確認問題を ${String(result.checks.length)} 組作りました（${String(missed)} 組は作れませんでした。確認問題の画面から1組ずつ作れます）。`;
}

function isMapView(value: unknown): value is LearningMapView {
  if (typeof value !== "object" || value === null) return false;
  const map = value as Record<string, unknown>;
  return (
    typeof map.id === "string" &&
    typeof map.title === "string" &&
    Array.isArray(map.nodes) &&
    Array.isArray(map.edges)
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCreationChecksResult(value: unknown): value is CreationChecksResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    Array.isArray(result.checks) && isCount(result.failedCount) && isCount(result.skippedCount)
  );
}
