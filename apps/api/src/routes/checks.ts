/**
 * 確認問題（#184 / #236）。利用者ごとに生成して保存し、本人だけが読む。
 *
 * - `GET /v1/checks?conceptId=`: その Concept で保存済みの組。**AI を呼ばない。**
 * - `POST /v1/checks:generate`: 1組を生成して保存する（同じ狙いがあれば上書き＝作り直し）。
 * - `GET /v1/checks:export`: 保存済みの全件（学習データのエクスポート）。
 * - `GET` / `PUT` / `DELETE /v1/check-generation-consent`: 生成への同意の「今後表示しない」。
 *
 * ## 生成は利用者が選んだときだけ走る
 *
 * 画面を開いただけでは生成しない。保存済みを `GET` で表示し、利用者が技術レベルと範囲を選んで
 * 「作る」「作り直す」を押したときだけ `POST` が来る（#236 の決定 6）。
 *
 * ## 回数は `ai_usage` に1組1回で数える
 *
 * 問題は全員で使い回さないので、生成量は利用者数に比例する。`POST /v1/ai/responses` と
 * 同じ利用者ごとの枠（日 15 回 / 月 150 回）から、**1組の生成につき1回**引く。
 * 保存済みを読むだけなら数えない（#236 の決定）。
 *
 * ## 本人の質問を送るのは同意があるときだけ
 *
 * 「理解すること」を狙う組では、その項目で本人が自力解決した質問の本文を材料に渡す。
 * 送信の同意（Web Worker の KV、`CONSENT_NOTICE_VERSION`）とは別に、生成のその場で
 * 同意を取る（`CHECK_GENERATION_NOTICE`）。要求に今の版の `consentVersion` が載っているか、
 * 「今後表示しない」の記録が今の版であるときだけ生成する。**材料が無い組でも同じ**にする。
 * 送るかどうかが材料の有無で変わると、同意を求める画面が出たり出なかったりする。
 */

import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import * as v from "valibot";
import {
  CHECK_GENERATION_CONSENT_VERSION,
  CHECK_LEVELS,
  CHECK_MATERIAL_MAX_QUESTION_LENGTH,
  CHECK_MATERIAL_MAX_QUESTIONS,
  CHECK_SCOPES,
  CONCEPT_ID_PATTERN,
  LEARNING_OBJECTIVE_ID_PATTERN,
  MOCK_LEARNING_OBJECTIVES,
  type ConsentRecord,
  type LearningObjective,
  type PersonalConceptCheck,
} from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { rateLimit } from "../auth/rate-limit.js";
import {
  AI_USAGE_LIMITS,
  ALLOWED_MODELS,
  estimateInputTokens,
  isAllowedModel,
  nextUtcDay,
  nextUtcMonth,
  utcDayKey,
  utcMonthKey,
  type AiUsageLimitBody,
  type AiUsageLimitKind,
} from "../contract/ai-usage.js";
import { buildCheckPrompt, checkPromptInputFor, type CheckRequest } from "../checks/prompt.js";
import {
  parseConceptCheck,
  readGeneratedText,
  type CheckParseFailure,
  type GeneratedTextFailure,
} from "../checks/response.js";
import type {
  AiUsageRepository,
  AuditLogRepository,
  CheckGenerationConsentRepository,
  ConversationRepository,
  IdentityRepository,
  LearningEventRepository,
  PersonalCheckRepository,
  UserSettingsRepository,
} from "../repository/types.js";

/**
 * 上流への単発リクエストのタイムアウト（RULE-001）。
 *
 * ストリーミングではないので壁時計で切ってよい。2問と例示コードを作らせるため、
 * `ai/responses` の対話よりは長めに置く。ここで切れた場合、生成は失敗として
 * 利用者へ返る（黙って空の問題を出さない）。
 */
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * 生成の温度。
 *
 * 形式の逸脱を減らしたいため低めに固定し、クライアントからは指定させない。
 * 作り直したときに同じ問題へ寄りすぎないよう、0 にはしない。
 */
const TEMPERATURE = 0.5;

// 既知の ID かどうかは `checkPromptInputFor` が判定する。ここは形式だけを見る。
// 長さの上限を置くのは、巨大な文字列で照合を走らせないため。
const conceptIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(200),
  v.regex(CONCEPT_ID_PATTERN),
);

const generateSchema = v.object({
  conceptId: conceptIdSchema,
  scope: v.picklist(CHECK_SCOPES),
  level: v.picklist(CHECK_LEVELS),
  objectiveId: v.optional(
    v.pipe(v.string(), v.maxLength(300), v.regex(LEARNING_OBJECTIVE_ID_PATTERN)),
  ),
  /** 生成の画面でその場で同意した文面の版。「今後表示しない」の記録があれば省略できる。 */
  consentVersion: v.optional(v.pipe(v.number(), v.integer())),
});

const listQuerySchema = v.object({ conceptId: conceptIdSchema });

const consentSchema = v.object({ version: v.pipe(v.number(), v.integer()) });

export interface ChecksDeps {
  apiKey?: string;
  model?: string;
  fetch: typeof fetch;
  /** 生成した問題の保存先。利用者ごと（migrations/0012_user_concept_checks.sql）。 */
  checks: PersonalCheckRepository;
  consents: CheckGenerationConsentRepository;
  /** 自力解決した質問を探すために読む。 */
  events: LearningEventRepository;
  /** 自力解決した会話の本文。「質問履歴の保存」を有効にした人の分だけがある。 */
  conversations: ConversationRepository;
  /** 「質問履歴の保存」が今も有効かを見る。無効なら保存済みの会話も材料にしない。 */
  settings: UserSettingsRepository;
  /** `ai_usage.user_id` は `users(id)` を参照するので、数える前に行を用意する。 */
  usage: AiUsageRepository;
  identity: IdentityRepository;
  audit: AuditLogRepository;
  /** 「理解すること」の一覧。生成の口ができるまではモック（#224）。テストで差し替える。 */
  objectives?: readonly LearningObjective[];
  now: () => Date;
}

export type ChecksDepsResolver = (env: CloudflareBindings) => ChecksDeps;

/** 生成に失敗したことを利用者へ伝える本文。**黙って空の問題を返さない。** */
interface CheckGenerationErrorBody {
  error: "check generation failed";
  /** 失敗の種別。クライアントが文言を選ぶために使う。 */
  reason: GeneratedTextFailure | CheckParseFailure;
  /** 画面へそのまま出せる説明。上流の応答の断片は載せない。 */
  message: string;
}

/** `GET /v1/check-generation-consent` の応答。 */
export interface CheckGenerationConsentBody {
  /** 今の文面の版。クライアントは同意したときにこの値を送る。 */
  version: number;
  /** 今の版で「今後表示しない」を選んでいるか。古い版の記録は false。 */
  granted: boolean;
  grantedAt?: string;
}

/** `GET /v1/checks:export` の応答。 */
export interface CheckExportBody {
  version: 1;
  exportedAt: string;
  checks: PersonalConceptCheck[];
}

/**
 * 失敗の理由を利用者向けの文へ直す。
 *
 * 応答の中身（モデルが返した文字列や検証の詳細）は載せない。ログへは残す。
 * ただし**何が起きたかは伝える**。「失敗しました」だけでは、再試行すれば直るのか、
 * 別の Concept を選ぶべきなのかが分からない。
 */
function failureBody(reason: GeneratedTextFailure | CheckParseFailure): CheckGenerationErrorBody {
  const message = {
    "not-json": "AI の応答を問題として読めませんでした。もう一度お試しください。",
    blocked: "AI が生成を拒否しました。時間をおいて、もう一度お試しください。",
    "no-text": "AI が問題を返しませんでした。もう一度お試しください。",
    truncated: "AI の応答が途中で切れました。もう一度お試しください。",
    shape:
      "AI が作った問題が形式（概要問題と実践問題の2問1組・4択・正解1つ）を満たしていませんでした。" +
      "もう一度お試しください。",
    "answer-out-of-range":
      "AI が作った問題の正解が選択肢に含まれていませんでした。もう一度お試しください。",
    "duplicate-choices":
      "AI が作った問題に同じ選択肢が複数あり、正解が1つに定まりませんでした。もう一度お試しください。",
    "concept-mismatch": "AI が別の概念の問題を返しました。もう一度お試しください。",
  }[reason];
  return { error: "check generation failed", reason, message };
}

/**
 * 上限到達時の応答。形は `POST /v1/ai/responses` と同じ（`AiUsageLimitBody`）。
 *
 * 文面だけを変える。AI ルートの文面は Copilot や BYOK を案内するが、Web の確認問題には
 * どちらも無い。保存済みの問題は回数を使わずに解けることを伝える。
 */
function limitReached(kind: AiUsageLimitKind, now: Date): AiUsageLimitBody {
  const resetAt = kind === "daily" ? nextUtcDay(now) : nextUtcMonth(now);
  const when = kind === "daily" ? "明日 UTC 0時" : "翌月 UTC 1日 0時";
  const scope = kind === "daily" ? "今日" : "今月";
  const allowance =
    kind === "daily"
      ? `${String(AI_USAGE_LIMITS.dailyRequests)} 回`
      : `${String(AI_USAGE_LIMITS.monthlyRequests)} 回`;
  return {
    error: "ai usage limit reached",
    limit: kind,
    resetAt: resetAt.toISOString(),
    message:
      `${scope}の AI 利用上限（${allowance}）に達したため、問題を作れません。${when}に回復します。` +
      "作ってある問題は、回数を使わずにそのまま解けます。",
  };
}

function consentBody(record: ConsentRecord | null): CheckGenerationConsentBody {
  const granted = record !== null && record.version === CHECK_GENERATION_CONSENT_VERSION;
  return {
    version: CHECK_GENERATION_CONSENT_VERSION,
    granted,
    ...(granted ? { grantedAt: record.grantedAt } : {}),
  };
}

/**
 * 狙う項目で本人が自力解決した質問を、新しい順に上限まで集める。
 *
 * 学習イベントの `sessionId` が会話 ID である（#233）。会話が無い（保存していない、
 * または消した）なら材料は無い。それは失敗ではなく、通常の1組を作る（#236 の決定 3）。
 *
 * **「質問履歴の保存」を今無効にしている人の会話は、保存済みでも使わない。** 無効にしても
 * 保存済みの履歴は残る（`CONSENT_NOTICE_DETAIL`）が、無効にした人は自分の履歴を使ってほしくない
 * と読むのが自然で、生成の同意の文面（`CHECK_GENERATION_NOTICE`）もそう約束している。
 * 渡すのは**質問文（`user`）だけ**で、選択テキスト（`context`）と回答（`assistant`）は渡さない。
 */
async function solvedQuestionsFor(
  deps: ChecksDeps,
  userId: string,
  objectiveId: string,
): Promise<string[]> {
  const settings = await deps.settings.get(userId);
  if (settings?.saveConversationHistory !== true) return [];

  const events = await deps.events.listByUser(userId);
  const sessionIds: string[] = [];
  // listByUser は発生時刻の昇順なので、後ろから見ると新しい順になる。
  for (const event of [...events].reverse()) {
    if (
      event.type === "solved_independently" &&
      event.sessionId !== undefined &&
      event.objectiveIds?.includes(objectiveId) === true &&
      !sessionIds.includes(event.sessionId)
    ) {
      sessionIds.push(event.sessionId);
    }
  }

  const questions: string[] = [];
  for (const sessionId of sessionIds) {
    if (questions.length >= CHECK_MATERIAL_MAX_QUESTIONS) break;
    const conversation = await deps.conversations.getById(userId, sessionId);
    if (conversation === null) continue;
    const text = conversation.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text.trim())
      .filter((message) => message.length > 0)
      .join("\n");
    if (text.length === 0) continue;
    questions.push(text.slice(0, CHECK_MATERIAL_MAX_QUESTION_LENGTH));
  }
  return questions;
}

/**
 * 自力解決した質問を、プロンプト全体が1回あたりの入力上限に収まる長さまで削る。
 *
 * 質問は新しい順に並んでいる。新しいものから残りの予算の分だけ載せ、入らなくなったら
 * 古いものを落とす。上限で 500 にすると、同じ履歴からは何度試しても作れなくなる。
 * 見積もりは UTF-8 のバイト数（`estimateInputTokens`）なので、削るのもバイト数で行う。
 */
function fitQuestionsToInputLimit(
  input: Parameters<typeof buildCheckPrompt>[0],
  base: CheckRequest,
  questions: readonly string[],
): string[] {
  const limit = AI_USAGE_LIMITS.inputTokensPerRequest;
  const fits = (candidate: readonly string[]) =>
    estimateInputTokens(buildCheckPrompt(input, { ...base, solvedQuestions: candidate })) <= limit;
  if (fits(questions)) return [...questions];

  const kept: string[] = [];
  for (const question of questions) {
    // 区切りと見出しの分は、空の質問を載せたプロンプトで測る。
    const overhead = estimateInputTokens(
      buildCheckPrompt(input, { ...base, solvedQuestions: [...kept, ""] }),
    );
    const room = limit - overhead;
    if (room <= 0) break;
    const trimmed = truncateToBytes(question, room);
    if (trimmed.length === 0) break;
    kept.push(trimmed);
  }
  return kept;
}

/** 文字の途中で切らずに、UTF-8 で `maxBytes` バイト以内へ収める。 */
function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

export function createChecksRoute(resolve: ChecksDepsResolver) {
  const route = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  // 認証（`app.ts` の `/v1/*`）の後に走るので userId で数えられる。
  // 保存済みを読むだけの要求にも同じ上限を効かせる。
  route.use(
    "/checks*",
    rateLimit((env) => env.PROFILE_RATE_LIMITER),
  );
  route.use(
    "/check-generation-consent",
    rateLimit((env) => env.PROFILE_RATE_LIMITER),
  );

  route.get("/checks", vValidator("query", listQuerySchema), async (c) => {
    const { conceptId } = c.req.valid("query");
    const deps = resolve(c.env);
    const checks = await deps.checks.listByConcept(c.get("user").userId, conceptId);
    return c.json({ checks }, 200, { "cache-control": "no-store" });
  });

  route.get("/checks:export", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    // 監査ログは users(id) を参照する。一度も同期していない利用者でも記録できるようにする。
    await deps.identity.ensureUser({ userId, nowMs: deps.now().getTime() });
    const checks = await deps.checks.listAllByUser(userId);
    await deps.audit.record({
      userId,
      action: "concept_checks.exported",
      occurredAtMs: deps.now().getTime(),
      detail: { checkCount: checks.length },
    });
    const body: CheckExportBody = {
      version: 1,
      exportedAt: deps.now().toISOString(),
      checks,
    };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  route.get("/check-generation-consent", async (c) => {
    const deps = resolve(c.env);
    const record = await deps.consents.get(c.get("user").userId);
    return c.json(consentBody(record), 200, { "cache-control": "no-store" });
  });

  route.put("/check-generation-consent", vValidator("json", consentSchema), async (c) => {
    const { version } = c.req.valid("json");
    if (version !== CHECK_GENERATION_CONSENT_VERSION) {
      // 古い文面を見て押した同意を、今の文面への同意として記録しない。
      return c.json(
        {
          error: "consent_outdated",
          message:
            "確認の文面が更新されました。ページを再読み込みして、最新の内容を確認してください。",
        },
        409,
      );
    }
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const now = deps.now();
    await deps.identity.ensureUser({ userId, nowMs: now.getTime() });
    const record: ConsentRecord = {
      version: CHECK_GENERATION_CONSENT_VERSION,
      grantedAt: now.toISOString(),
    };
    await deps.consents.put(userId, record);
    return c.json(consentBody(record), 200, { "cache-control": "no-store" });
  });

  route.delete("/check-generation-consent", async (c) => {
    const deps = resolve(c.env);
    await deps.consents.delete(c.get("user").userId);
    return c.json(consentBody(null), 200, { "cache-control": "no-store" });
  });

  route.post("/checks:generate", vValidator("json", generateSchema), async (c) => {
    const { conceptId, scope, level, objectiveId, consentVersion } = c.req.valid("json");
    const deps = resolve(c.env);
    const userId = c.get("user").userId;

    const resolved = checkPromptInputFor(conceptId);
    if (!resolved.ok) {
      if (resolved.reason === "unknown-concept") {
        return c.json(
          {
            error: "unknown concept",
            message: "その概念は一覧にありません。確認問題を作れる概念を選んでください。",
          },
          400,
        );
      }
      // 概要の無い Concept は定義の不備であり、利用者の失敗ではない（RULE-004）。
      console.error("concept has no summary; refusing to generate a check", { conceptId });
      return c.json({ error: "concept definition is incomplete" }, 500);
    }

    // 狙う項目は、その Concept の「理解すること」の一覧にあるものだけを受け付ける。
    const objectives = (deps.objectives ?? MOCK_LEARNING_OBJECTIVES).filter(
      (candidate) => candidate.conceptId === conceptId,
    );
    const objective =
      objectiveId === undefined
        ? undefined
        : objectives.find((candidate) => candidate.id === objectiveId);
    if (scope === "objective" ? objective === undefined : objectiveId !== undefined) {
      return c.json(
        {
          error: "invalid objective",
          message:
            scope === "objective"
              ? "その「理解すること」はこの概念にありません。項目を選び直してください。"
              : "「理解すること」を選んだときだけ、項目を指定できます。",
        },
        400,
      );
    }
    // 項目を持つ Concept では、項目を狙わない組を作らない。正誤が項目の理解度に効かない
    // （#223 決定 6）。画面の「Concept 単位」は、まだ 1.0 でない項目ごとに1組を作る（#236）。
    if (scope === "concept" && objectives.length > 0) {
      return c.json(
        {
          error: "invalid objective",
          message: "この概念は「理解すること」の項目ごとに問題を作ります。項目を選んでください。",
        },
        400,
      );
    }

    // 送る前に同意を確かめる。その場の同意か、「今後表示しない」の記録のどちらか。
    if (consentVersion !== CHECK_GENERATION_CONSENT_VERSION) {
      const stored = await deps.consents.get(userId);
      if (stored?.version !== CHECK_GENERATION_CONSENT_VERSION) {
        return c.json(
          {
            error: "check generation consent required",
            message: "問題を作る前に、AI へ送る内容を確認して同意してください。",
            version: CHECK_GENERATION_CONSENT_VERSION,
          },
          403,
        );
      }
    }

    if (!deps.apiKey) {
      // 設定漏れは運営側の障害である。503 だけでは Workers のログから区別できない。
      console.error("ai service is not configured", { path: c.req.path });
      return c.json({ error: "AI service is not configured" }, 503);
    }
    // クライアントにモデルを選ばせない。設定値であっても allowlist は通す。
    const model = deps.model ?? ALLOWED_MODELS[0];
    if (!isAllowedModel(model)) {
      console.error("configured model is not allowed", { model, allowed: ALLOWED_MODELS });
      return c.json({ error: "AI service is not configured" }, 503);
    }

    // 材料（学習イベントと会話）を読む前の時刻。上流を待つ間に学習データが削除されたら、
    // 削除前の履歴から作った問題を保存しない（`PersonalCheckRepository.put`）。
    const startedAtMs = deps.now().getTime();
    const base: CheckRequest = {
      scope,
      level,
      ...(objective === undefined
        ? {}
        : { objective: { id: objective.id, label: objective.label } }),
      solvedQuestions: [],
    };
    // 材料の無いプロンプトが上限を超えるのは、定義と方針の文面の見積もり違いである。
    // 利用者には縮めようがないため、こちらの不備として 500 を返す。
    if (
      estimateInputTokens(buildCheckPrompt(resolved.input, base)) >
      AI_USAGE_LIMITS.inputTokensPerRequest
    ) {
      console.error("check prompt exceeds the per-request input limit without material", {
        conceptId,
        limit: AI_USAGE_LIMITS.inputTokensPerRequest,
      });
      return c.json({ error: "check prompt is too large" }, 500);
    }
    const request: CheckRequest = {
      ...base,
      solvedQuestions:
        objective === undefined
          ? []
          : fitQuestionsToInputLimit(
              resolved.input,
              base,
              await solvedQuestionsFor(deps, userId, objective.id),
            ),
    };
    const prompt = buildCheckPrompt(resolved.input, request);
    const estimatedInputTokens = estimateInputTokens(prompt);

    const now = deps.now();
    const monthKey = utcMonthKey(now);
    const dayKey = utcDayKey(now);
    // `ai_usage.user_id` は `users(id)` を参照する。行が無いまま数えると外部キーで落ちる。
    await deps.identity.ensureUser({ userId, nowMs: now.getTime() });

    // トークンの安全弁は前回までの累計で見る（`ai.ts` と同じ）。
    const before = await deps.usage.get({ userId, monthKey, dayKey });
    if (before.monthlyTokens >= AI_USAGE_LIMITS.monthlyTokens) {
      console.warn("ai usage token safety valve reached", {
        userId,
        monthKey,
        monthlyTokens: before.monthlyTokens,
        limit: AI_USAGE_LIMITS.monthlyTokens,
      });
      return c.json(limitReached("tokens", now), 429);
    }
    // 判定と加算を1つの操作で行う。上流へ送る前に確保する（`ai.ts` と同じ理由）。
    const { reserved, usage: after } = await deps.usage.reserve({
      userId,
      monthKey,
      dayKey,
      updatedAt: now.toISOString(),
      limits: {
        dailyRequests: AI_USAGE_LIMITS.dailyRequests,
        monthlyRequests: AI_USAGE_LIMITS.monthlyRequests,
      },
    });
    if (!reserved) {
      const kind: AiUsageLimitKind =
        after.monthlyRequests >= AI_USAGE_LIMITS.monthlyRequests ? "monthly" : "daily";
      return c.json(limitReached(kind, now), 429);
    }

    let upstream: Response;
    try {
      upstream = await deps.fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": deps.apiKey, "Content-Type": "application/json" },
          // リダイレクトを自動追跡しない。転送先へ API キーごと送られると、
          // 資格情報が意図しない相手に渡る（RULE-002）。
          redirect: "error",
          // 応答を一括で受け取る単発のリクエストなので、壁時計で必ず切る（RULE-001）。
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: TEMPERATURE,
              // 出力上限は常に送る。上流の既定値で走らせると1回あたりの単価が決まらない。
              maxOutputTokens: AI_USAGE_LIMITS.outputTokensPerRequest,
              // JSON を要求する。コードブロックの囲みが来ないようにするための指定で、
              // 受理側（`response.ts`）は囲みを剥がさずに拒否する。
              responseMimeType: "application/json",
            },
          }),
        },
      );
    } catch (cause) {
      // fetch の拒否（ネットワーク断、タイムアウト、`redirect: "error"` の拒否）は
      // 下の !ok 分岐に届かない。失敗として数えられるよう応答の前に記録する。
      console.error("check generation upstream request failed", { conceptId, model, cause });
      return c.json({ error: "AI upstream request failed" }, 502);
    }

    if (!upstream.ok) {
      // ステータスは残すが、上流の本文（エラーメッセージ）は読まずに捨てる。
      console.error("check generation upstream request failed", {
        conceptId,
        model,
        status: upstream.status,
      });
      return c.json({ error: "AI upstream request failed" }, 502);
    }

    let raw: string;
    try {
      raw = await upstream.text();
    } catch (cause) {
      // 2xx でも本文が読めなければ失敗である（RULE-004）。
      console.error("check generation upstream body could not be read", {
        conceptId,
        model,
        cause,
      });
      return c.json({ error: "AI upstream request failed" }, 502);
    }

    // 実消費を当月へ足す。本文が使えない応答（切れた・空・拒否）でも上流では課金されるので、
    // 判定より先に足す。取れなければ 0 で済ませず、上界の見積もりを足して残す（RULE-004）。
    const generated = readGeneratedText(raw);
    const tokens =
      generated.totalTokens ?? estimatedInputTokens + AI_USAGE_LIMITS.outputTokensPerRequest;
    if (generated.totalTokens === undefined) {
      console.warn("check generation did not report token usage; adding an estimate", {
        conceptId,
        model,
        tokens,
      });
    }
    await deps.usage.addTokens({
      userId,
      monthKey,
      dayKey,
      tokens,
      updatedAt: now.toISOString(),
    });

    if (!generated.ok) {
      console.error("check generation response was not usable", {
        conceptId,
        model,
        reason: generated.reason,
        detail: generated.detail,
      });
      return c.json(failureBody(generated.reason), 502);
    }

    const parsed = parseConceptCheck(generated.text, resolved.input.id);
    if (!parsed.ok) {
      console.error("generated check was rejected", {
        conceptId,
        model,
        reason: parsed.reason,
        detail: parsed.detail,
      });
      return c.json(failureBody(parsed.reason), 502);
    }

    const check: PersonalConceptCheck = {
      ...parsed.check,
      scope,
      level,
      ...(objective === undefined ? {} : { objectiveId: objective.id }),
      model: generated.modelVersion ?? model,
      generatedAt: now.toISOString(),
    };
    // 保存に失敗したら例外のまま 500 にする。問題だけ返して保存の失敗を飲み込むと、
    // 次に開いたときに問題が無く、回数だけが減っている（RULE-004）。
    const { saved } = await deps.checks.put(userId, check, startedAtMs);
    if (!saved) {
      // 生成中に学習データが削除された。削除を優先し、作った問題は返さない。
      console.info("generated check was discarded by a learning data reset", { conceptId });
      return c.json(
        {
          error: "check discarded by reset",
          message: "生成中に学習データが削除されたため、作った問題は保存しませんでした。",
        },
        409,
      );
    }

    // その場の同意は、生成のたびに記録しない。「今後表示しない」は PUT で別に記録する。
    console.info("check generation completed", {
      conceptId,
      scope,
      level,
      materialCount: request.solvedQuestions.length,
      model: check.model,
      totalTokens: generated.totalTokens ?? "unknown",
    });
    return c.json(check, 200, { "cache-control": "no-store" });
  });

  return route;
}
