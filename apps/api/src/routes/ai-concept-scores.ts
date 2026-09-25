/**
 * `POST /v1/ai/concept-scores`（Issue #130 の PoC）。
 *
 * Concept の分類を TypeSafe の structured evaluation model `typesafe/jev` で行う経路。
 * 既存方式（回答プロンプトの末尾へ conceptIds を出力させる方式、
 * apps/vscode-extension/src/ai/prompt）と同じ「既知の概念一覧」を対象に、
 * Concept ごとに `noul` を1問ずつ立て、返ってきた値を relevance score として扱う。
 *
 * 分類の精度・latency・token・cost を既存方式と比較するため、
 * 応答には採用結果だけでなく全 Concept の score と usage・latency を載せる。
 * コード本文はログにも D1 にも残さない（docs/architecture.md「データとプライバシー」）。
 */

import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import * as v from "valibot";
import { knownConceptsFor, type Concept } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { estimateInputTokens } from "../contract/ai-usage.js";

/** Workers AI 上での Jev のモデル名。 */
export const JEV_MODEL = "typesafe/jev";

/**
 * 採用閾値の既定値。noul の値がこの値以上の Concept を採用する。
 * 比較データが揃うまでの仮の値であり、リクエストの `threshold` で上書きできる。
 */
export const DEFAULT_CONCEPT_THRESHOLD = 0.7;

/**
 * Jev へ渡す `state` の入力トークンの上界。
 *
 * Jev のコンテキスト制約は「state + 最長の質問で 32k tokens」。
 * 質問側は Concept 1件ぶん（数十 tokens）しか要らないため、
 * state 側は余裕を持ってこの値で弾く。見積もりは `estimateInputTokens` と同じく
 * UTF-8 バイト数を上界にするため、通る入力は必ず実際の上限内に収まる。
 */
export const JEV_STATE_TOKEN_LIMIT = 28_000;

const requestSchema = v.object({
  /** 分類対象のコードまたはテキスト。 */
  selection: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
  /** VS Code の言語識別子。既知の概念一覧の絞り込みに使う。 */
  languageId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
  fileName: v.optional(v.pipe(v.string(), v.maxLength(500))),
  surroundingCode: v.optional(v.pipe(v.string(), v.maxLength(20_000))),
  question: v.optional(v.pipe(v.string(), v.maxLength(4_000))),
  /** 採用閾値。省略時は `DEFAULT_CONCEPT_THRESHOLD`。 */
  threshold: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
});

/**
 * Jev の `noul` 質問。Concept ごとに1問立てる。
 * `questions` のキーは推論には使われず、応答 `answers` のキーとしてそのまま
 * 返るため、Concept ID（`go.defer` など `.` を含む）をそのまま使える。
 */
interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

/** Concept 一覧を Jev の questions へ変換する。 */
export function buildJevQuestions(concepts: readonly Concept[]): Record<string, JevNoulQuestion> {
  const questions: Record<string, JevNoulQuestion> = {};
  for (const concept of concepts) {
    questions[concept.id] = {
      type: "noul",
      instructions:
        `Does the \`code\` in the state materially demonstrate the concept ` +
        `"${concept.label}" (${concept.id})? ` +
        `Judge by \`code\`; \`surroundingCode\`, \`language\`, \`fileName\`, ` +
        `and \`question\` are supporting context only.`,
      criteria: {
        true: `"${concept.label}" is materially used or demonstrated`,
        false: `"${concept.label}" is absent or only incidental`,
      },
    };
  }
  return questions;
}

interface ConceptScoresRequest {
  selection: string;
  languageId?: string;
  fileName?: string;
  surroundingCode?: string;
  question?: string;
}

/** Jev の `state`。取れている情報だけを載せ、無い項目はキー自体を省く。 */
function buildJevState(request: ConceptScoresRequest): Record<string, unknown> {
  const state: Record<string, unknown> = { code: request.selection };
  if (request.languageId !== undefined) state.language = request.languageId;
  if (request.fileName !== undefined) state.fileName = request.fileName;
  if (request.surroundingCode !== undefined) state.surroundingCode = request.surroundingCode;
  const question = request.question?.trim();
  if (question) state.question = question;
  return state;
}

/** Concept ごとの relevance score。 */
export interface ConceptScore {
  conceptId: string;
  score: number;
}

/** `POST /v1/ai/concept-scores` の応答本文。score 全件を返すのは比較材料を残すため。 */
export interface ConceptScoresBody {
  /** 実際に評価した Jev の版。応答に含まれない場合は省略される。 */
  model?: string;
  /** 採用に使った閾値。 */
  threshold: number;
  /** 問い合わせた全 Concept の score（score の降順）。 */
  scores: ConceptScore[];
  /** `score >= threshold` の Concept ID。 */
  conceptIds: string[];
  /** Jev が返した token 消費量。比較・コスト試算の材料。 */
  usage?: { inputTokens: number; outputTokens: number };
  /** Jev の評価に掛かった時間（ms）。 */
  latencyMs: number;
}

/**
 * Jev の応答から、問い合わせた Concept ごとの noul の値を取り出す。
 *
 * 問い合わせたのに応答へ無い Concept をスコア 0 として扱うと、
 * false negative を埋めてしまう。形が壊れている・キーが欠けている応答は
 * 全体を `null` で返し、呼び出し側が失敗として扱えるようにする（RULE-004）。
 */
export function readConceptScores(
  response: unknown,
  conceptIds: readonly string[],
): ConceptScore[] | null {
  if (typeof response !== "object" || response === null) return null;
  const answers = (response as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) return null;

  const scores: ConceptScore[] = [];
  for (const conceptId of conceptIds) {
    const answer = (answers as Record<string, unknown>)[conceptId];
    if (typeof answer !== "object" || answer === null) return null;
    const noul = (answer as { noul?: unknown }).noul;
    if (typeof noul !== "number" || !Number.isFinite(noul)) return null;
    scores.push({ conceptId, score: noul });
  }
  return scores.sort((a, b) => b.score - a.score);
}

/** 応答の `model`（実際に評価した版。例: `jev-1.13.0`）。取れなければ undefined。 */
function readModel(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const model = (response as { model?: unknown }).model;
  return typeof model === "string" ? model : undefined;
}

/** 応答の `usage` を API の形（camelCase）へ写す。無い・壊れていれば undefined。 */
function readUsage(response: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const usage = (response as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const input = (usage as { input_tokens?: unknown }).input_tokens;
  const output = (usage as { output_tokens?: unknown }).output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  return { inputTokens: input, outputTokens: output };
}

export interface ConceptScoresDeps {
  /** Workers AI のバインド（wrangler.jsonc の `ai`）。未設定なら 503 を返す。 */
  ai?: Ai;
  /** レイテンシ計測のための時刻源（ms）。テストでは固定値を挿す。 */
  now: () => number;
}

export type ConceptScoresDepsResolver = (env: CloudflareBindings) => ConceptScoresDeps;

export function createAiConceptScoresRoute(resolve: ConceptScoresDepsResolver) {
  const route = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  route.post("/ai/concept-scores", vValidator("json", requestSchema), async (c) => {
    const body = c.req.valid("json");
    const deps = resolve(c.env);
    if (!deps.ai) {
      // 設定漏れは利用者の失敗ではなく運営側の障害である。503 の応答だけでは
      // Workers のログから区別できないため残す（docs/architecture.md）。
      console.error("ai service is not configured", { path: c.req.path });
      return c.json({ error: "AI service is not configured" }, 503);
    }

    const state = buildJevState(body);

    // 入力の超過は切り捨てず拒否する。黙って切ると、利用者から見て
    // 文脈を読み落とした分類が返り、原因が分からない（RULE-004）。
    const estimatedStateTokens = estimateInputTokens(JSON.stringify(state));
    if (estimatedStateTokens > JEV_STATE_TOKEN_LIMIT) {
      return c.json(
        {
          error: "input is too large",
          message:
            `入力が上限（${String(JEV_STATE_TOKEN_LIMIT)} tokens）を超える見積もりです。` +
            "選択範囲を狭めてください。",
          limitTokens: JEV_STATE_TOKEN_LIMIT,
          estimatedTokens: estimatedStateTokens,
        },
        400,
      );
    }

    // 分類対象は「既知の概念一覧」と同じ集合。プロンプト方式と受理範囲を
    // 揃えるため、絞り込みは domain の `knownConceptsFor` を共有する。
    const concepts = knownConceptsFor(body.languageId);
    const questions = buildJevQuestions(concepts);
    const conceptIds = concepts.map((concept) => concept.id);
    const userId = c.get("user").userId;

    const startedAt = deps.now();
    let response: unknown;
    try {
      response = await deps.ai.run(JEV_MODEL, { state, questions });
    } catch (cause) {
      console.error("ai concept scoring failed", { userId, cause });
      return c.json({ error: "AI upstream request failed" }, 502);
    }
    const latencyMs = deps.now() - startedAt;

    const scores = readConceptScores(response, conceptIds);
    if (scores === null) {
      console.error("ai concept scoring returned an unexpected response", { userId });
      return c.json({ error: "AI upstream request failed" }, 502);
    }

    const threshold = body.threshold ?? DEFAULT_CONCEPT_THRESHOLD;
    const result: ConceptScoresBody = {
      model: readModel(response),
      threshold,
      scores,
      conceptIds: scores
        .filter((score) => score.score >= threshold)
        .map((score) => score.conceptId),
      usage: readUsage(response),
      latencyMs,
    };
    return c.json(result);
  });

  return route;
}
