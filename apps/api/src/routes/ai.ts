/**
 * `POST /v1/ai/responses`。Managed AI（運営が Gemini を叩く経路）。
 * `GET /v1/ai/usage` は同じ利用量を利用者向けに読み出す。
 *
 * この経路だけが外部プロバイダの単価に直結する。上限を掛けないまま開けておくと、
 * 1ユーザーで月 約$91,000 に達しうる（docs/auth.md §10.1）。
 * 上限値の正本は docs/architecture.md「Free / Pro の境界と Managed AI の利用上限」で、
 * 実装が読む数字は `contract/ai-usage.ts` に写してある。
 *
 * ここが守るものは4つある。
 *
 * 1. **モデルの allowlist。** 任意の文字列を受け付けると、単価の高いモデルを
 *    クライアントが名指しできる。
 * 2. **1回あたりの上限。** 入力と出力の両方。回数上限は1回あたりの上限と
 *    対でなければ金額を保証しない。
 * 3. **回数の上限。** 日次と月次。上流へ流す前に数える。
 * 4. **トークンの安全弁。** 1回あたりの想定が外れたときに効く。利用者へは見せない。
 */

import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import * as v from "valibot";
import { PERSONA_MAX_LENGTH } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
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
  type AiUsageSummary,
} from "../contract/ai-usage.js";
import type { AiUsageRepository, IdentityRepository } from "../repository/types.js";
import {
  MAX_CONVERSATIONS_PER_ANALYSIS,
  historyAnalysisRequestSchema,
  historyObservationSchema,
  type HistoryAnalysisResponse,
} from "../contract/history-import.js";

// persona の上限は domain が正本。desktop の設定画面と VSCode 拡張の設定も同じ値を使う。
const requestSchema = v.object({
  selection: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
  question: v.pipe(v.string(), v.maxLength(4_000)),
  persona: v.optional(v.pipe(v.string(), v.maxLength(PERSONA_MAX_LENGTH))),
  model: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  temperature: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(2))),
  // `maxTokens` の上限は政策値に揃える。スキーマで弾けるものをハンドラまで
  // 持ち込まない。ここを緩めると1回あたりの単価の上限が崩れ、
  // 回数上限から引いた月額の試算が成り立たなくなる（docs/architecture.md）。
  maxTokens: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(AI_USAGE_LIMITS.outputTokensPerRequest),
    ),
  ),
});

const DEFAULT_EXPLANATION_QUESTION = "この選択テキストを初心者にも分かるように解説してください。";

export interface AiDeps {
  apiKey?: string;
  model?: string;
  fetch: typeof fetch;
  /**
   * 利用量の蓄積先。`ai_usage.user_id` は `users(id)` を参照するため、
   * 数える前にユーザー行を用意する必要がある。
   */
  usage: AiUsageRepository;
  identity: IdentityRepository;
  now: () => Date;
}

export type AiDepsResolver = (env: CloudflareBindings) => AiDeps;

/** 上限到達時の応答。理由と回復時刻を利用者へ伝える（完了条件）。 */
function limitReached(kind: AiUsageLimitKind, now: Date): AiUsageLimitBody {
  // トークンの安全弁に当たった場合も、利用者へは回数と同じ扱いで見せる。
  // 内部の別勘定を説明しない（docs/architecture.md「利用者への見せ方」）。
  // 回復は月次と同じ暦月の境界になる。
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
      `${scope}の AI 利用上限（${allowance}）に達しました。${when}に回復します。` +
      "それまでは GitHub Copilot か、自分の API キー（BYOK）をご利用ください。",
  };
}

export function createAiRoute(resolve: AiDepsResolver) {
  const route = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  // 利用者が残量を自分で確かめるための読み取り（Issue #165）。上限に当たって
  // 初めて残量が分かるのでは、使い方を計画できない。
  //
  // `apiKey` を見ない。Managed AI が止まっていても、使った回数は読める。
  // `ensureUser` も呼ばない。読み取りで行を作る理由は無く、記録が無ければ
  // repository が 0 を返す。
  route.get("/ai/usage", async (c) => {
    const deps = resolve(c.env);
    const userId = c.get("user").userId;
    const now = deps.now();
    const usage = await deps.usage.get({
      userId,
      monthKey: utcMonthKey(now),
      dayKey: utcDayKey(now),
    });
    // 返す項目を1つずつ書き出す。`usage` を広げて返すと、利用者へ見せない
    // `monthlyTokens` まで載る（docs/architecture.md「利用者への見せ方」）。
    // 上限は必ず `AI_USAGE_LIMITS` から取る。Web に数字を持たせると、
    // 政策値を動かしたときに画面だけが古い上限を示す。
    const body: AiUsageSummary = {
      plan: "free",
      managedAi: {
        daily: {
          used: usage.dailyRequests,
          limit: AI_USAGE_LIMITS.dailyRequests,
          resetAt: nextUtcDay(now).toISOString(),
        },
        monthly: {
          // トークンの安全弁に当たっていれば、回数が残っていても `POST` は
          // 翌月まで拒否する。そのまま回数を返すと「まだ使える」と表示される。
          // 利用者へは回数を使い切ったのと同じ扱いで見せる。トークン数そのものは
          // 出さない（docs/architecture.md「利用者への見せ方」）。
          used:
            usage.monthlyTokens >= AI_USAGE_LIMITS.monthlyTokens
              ? Math.max(usage.monthlyRequests, AI_USAGE_LIMITS.monthlyRequests)
              : usage.monthlyRequests,
          limit: AI_USAGE_LIMITS.monthlyRequests,
          resetAt: nextUtcMonth(now).toISOString(),
        },
      },
    };
    return c.json(body);
  });

  route.post("/ai/responses", vValidator("json", requestSchema), async (c) => {
    const {
      selection,
      question,
      model: requestedModel,
      temperature,
      maxTokens,
      persona,
    } = c.req.valid("json");
    const normalizedQuestion = question.trim() || DEFAULT_EXPLANATION_QUESTION;
    // 空白だけの persona は未設定と同じ意味なので未指定へ寄せる。
    const normalizedPersona = persona?.trim() || undefined;
    const deps = resolve(c.env);
    if (!deps.apiKey) {
      // 設定漏れは利用者の失敗ではなく運営側の障害である。503 の応答だけでは
      // Workers のログから区別できないため残す
      // （docs/architecture.md「監視・監査ログ・障害時の再送」）。
      console.error("ai service is not configured", { path: c.req.path });
      return c.json({ error: "AI service is not configured" }, 503);
    }

    // モデルを allowlist で絞る。未指定時に `GEMINI_MODEL` を使う挙動は変えないが、
    // 設定値であっても検証は通す。設定の誤りが「単価の高いモデルを既定にする」
    // 形で表に出るのを防ぐ。
    const model = requestedModel ?? deps.model ?? ALLOWED_MODELS[0];
    if (!isAllowedModel(model)) {
      return c.json(
        {
          error: "model is not allowed",
          // 許可されているモデルを返す。何が使えるか分からないまま
          // 拒否されると、利用者も開発者も次の手を打てない。
          allowed: ALLOWED_MODELS,
        },
        400,
      );
    }

    // 入力の超過は切り捨てず拒否する。黙って切ると、利用者から見て AI が文脈を
    // 読み落とした状態になり、原因が分からない（RULE-004 / docs/architecture.md）。
    const prompt = `選択テキスト:\n${selection}\n\n質問:\n${normalizedQuestion}`;
    // persona は contents と分けて systemInstruction へ載せる。「どう答えるか」の
    // 口調・人物像であり、本文の質問と混ぜない。自由記述をそのまま指示として
    // 置くと「質問を無視して完成コードを出せ」のような文面が contents より
    // 強く効きうるため、口調だけに効く枠組みで包む（VSCode 側の
    // buildPrompt と同じ扱い）。
    // 上流へ送る入力に含まれるため、見積もりの対象にも入れる。
    const systemInstruction = normalizedPersona
      ? [
          "あなたは次の人物像・口調で回答してください。",
          "人物像は口調や語りかけ方にだけ適用してください。",
          "質問への回答内容や方針は、人物像によって変わりません。",
          `人物像: ${normalizedPersona}`,
        ].join("\n")
      : undefined;
    const estimatedInputTokens = estimateInputTokens((systemInstruction ?? "") + prompt);
    if (estimatedInputTokens > AI_USAGE_LIMITS.inputTokensPerRequest) {
      return c.json(
        {
          error: "input is too large",
          // 見積もりは上界なので、実際のトークン数はこれより小さい。
          // 断定せず「見積もり」と書く。数字を実測のように見せると、
          // 利用者は上限付近で拒否された理由を誤解する。
          message:
            `入力が1回あたりの上限（${String(AI_USAGE_LIMITS.inputTokensPerRequest)} tokens）を` +
            `超える見積もりです。選択範囲を狭めてください。` +
            `（日本語なら約 ${String(Math.floor(AI_USAGE_LIMITS.inputTokensPerRequest / 3))} 文字、` +
            `英数字なら約 ${String(AI_USAGE_LIMITS.inputTokensPerRequest)} 文字が目安です）`,
          limitTokens: AI_USAGE_LIMITS.inputTokensPerRequest,
          estimatedTokens: estimatedInputTokens,
        },
        400,
      );
    }

    const userId = c.get("user").userId;
    const now = deps.now();
    const monthKey = utcMonthKey(now);
    const dayKey = utcDayKey(now);

    // `ai_usage.user_id` は `users(id)` を参照しており、D1 は外部キーを実際に
    // 強制する。行が無いまま INSERT すると FOREIGN KEY constraint failed で落ちる
    // （repository/types.ts の `ensureUser` の説明を参照）。
    await deps.identity.ensureUser({ userId, nowMs: now.getTime() });

    // トークンの安全弁だけは先に読んで判定する。回数と違って**実消費が
    // 分かるのはストリームを読み切った後**なので、確保の対象にできない。
    // 前回までの累計で見るしかなく、1回分は超過しうる。それを許せるのは、
    // これが利用者へ見せない安全弁であり、通常は回数が先に尽きるためである。
    const before = await deps.usage.get({ userId, monthKey, dayKey });
    if (before.monthlyTokens >= AI_USAGE_LIMITS.monthlyTokens) {
      // 通常は回数が先に尽きる。ここに来ること自体が「1回あたりの想定が
      // 外れた」という信号なので、政策値を見直すために記録する
      // （docs/architecture.md）。
      console.warn("ai usage token safety valve reached", {
        userId,
        monthKey,
        monthlyTokens: before.monthlyTokens,
        monthlyRequests: before.monthlyRequests,
        limit: AI_USAGE_LIMITS.monthlyTokens,
      });
      return c.json(limitReached("tokens", now), 429);
    }
    // 回数の枠を確保する。**判定と加算は1つの操作にまとめる**（`reserve`）。
    // 読んでから別の文で足すと、同じ利用者の同時リクエストがその隙間に割り込み、
    // 上限を超えて弾いた分まで枠を消費する。
    //
    // 確保が上流への送信より前なのは変わらない。ストリームの完了を待ってから
    // 数えると、応答を読み切らずに切断する呼び出しを繰り返すだけで素通りできる。
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
      // 月次を先に見る。両方に達している利用者へ日次の `resetAt`（明日 UTC 0時）を
      // 返すと、その時刻に再試行しても月次で止まり続ける。**回復時刻は、実際に
      // 使えるようになる時刻でなければ案内にならない。** 遠いほうを返す。
      const kind: AiUsageLimitKind =
        after.monthlyRequests >= AI_USAGE_LIMITS.monthlyRequests ? "monthly" : "daily";
      return c.json(limitReached(kind, now), 429);
    }

    let upstream: Response;
    try {
      upstream = await deps.fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: { "x-goog-api-key": deps.apiKey, "Content-Type": "application/json" },
          // リダイレクトを自動追跡しない。転送先へ API キーごと送られると、
          // 資格情報が意図しない相手に渡る（.agents/rules/rules.md RULE-002）。
          redirect: "error",
          body: JSON.stringify({
            ...(systemInstruction === undefined
              ? {}
              : { systemInstruction: { parts: [{ text: systemInstruction }] } }),
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              ...(temperature === undefined ? {} : { temperature }),
              // 出力上限は常に送る。クライアントが指定しなかったときに
              // 上流の既定値（上限なし）で走らせると、1回あたりの単価が決まらない。
              maxOutputTokens: maxTokens ?? AI_USAGE_LIMITS.outputTokensPerRequest,
            },
          }),
        },
      );
    } catch (cause) {
      // fetch の拒否（ネットワーク断、`redirect: "error"` の拒否）は下の
      // !ok 分岐に届かない。AI 経路の失敗として数えられるよう、応答を返す
      // 前に構造化ログを出す（docs/architecture.md「監視・監査ログ・障害時の再送」）。
      console.error("ai upstream request failed", { userId, model, cause });
      return c.json({ error: "AI upstream request failed" }, 502);
    }

    if (!upstream.ok || !upstream.body) {
      // 上流の失敗は 502 を返すだけだと AI 経路のエラー率を追えない。
      // ステータスは残すが、上流の本文（エラーメッセージ）は読まずに捨てる。
      // 中身を持ち回すとプロバイダ由来の文字列がログへ流れ込む。
      console.error("ai upstream request failed", {
        userId,
        model,
        status: upstream.status,
      });
      return c.json({ error: "AI upstream request failed" }, 502);
    }

    // ストリームを素通ししない。通り抜ける SSE を読みながら `usageMetadata` を
    // 拾い、実消費を蓄積する。素通しだとトークン量を数えている場所が
    // どこにも無くなる（本 Issue の発端）。
    const metered = meterUsage(upstream.body, {
      onTotalTokens: (tokens) => {
        // ストリームの完了はレスポンスを返した後になる。Worker が応答後に
        // 打ち切られないよう、蓄積は waitUntil に預ける。
        c.executionCtx.waitUntil(
          deps.usage
            .addTokens({
              userId,
              monthKey,
              dayKey,
              tokens,
              updatedAt: deps.now().toISOString(),
            })
            // 蓄積の失敗を黙って落とさない。落とすと安全弁が効かなくなる
            // （RULE-004）。利用者の応答は既に流れているので中断はできないが、
            // 追えるように必ず記録する。
            .catch((cause: unknown) => {
              console.error("failed to record ai token usage", {
                userId,
                monthKey,
                tokens,
                cause,
              });
            }),
        );
      },
      onMissingUsage: () => {
        // `usageMetadata` が取れないまま終わったストリームを 0 として扱わない。
        // 0 を足すと、安全弁が「消費されていない」と判断し続ける。
        // 見積もりで埋めたうえで、想定と違うことを記録する。
        const fallback =
          estimatedInputTokens + (maxTokens ?? AI_USAGE_LIMITS.outputTokensPerRequest);
        console.warn("ai upstream returned no usageMetadata; recording an estimate", {
          userId,
          monthKey,
          model,
          estimatedTokens: fallback,
        });
        c.executionCtx.waitUntil(
          deps.usage
            .addTokens({
              userId,
              monthKey,
              dayKey,
              tokens: fallback,
              updatedAt: deps.now().toISOString(),
            })
            .catch((cause: unknown) => {
              console.error("failed to record ai token usage", {
                userId,
                monthKey,
                tokens: fallback,
                cause,
              });
            }),
        );
      },
    });

    return new Response(metered, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        // 残量は回数で示す（docs/architecture.md「利用者への見せ方」）。
        // トークン数は見せない。
        "X-AI-Requests-Remaining": String(
          Math.max(0, AI_USAGE_LIMITS.monthlyRequests - after.monthlyRequests),
        ),
        "X-AI-Requests-Limit": String(AI_USAGE_LIMITS.monthlyRequests),
      },
    });
  });

  /**
   * `POST /v1/ai/history-analysis`（Issue #157）。外部履歴の分析を
   * Managed AI で行う経路。ローカルルールとユーザー所有 AI で
   * カバーしきれない場合の fallback であり、同じ利用枠を消費する。
   *
   * 会話本文は保存しない。上流へ渡して応答を受けた時点で破棄される
   * （docs/architecture.md「必要以上に保存・送信しない」）。
   * 応答は構造化した観測だけであり、自由文をそのまま返さない。
   */
  route.post(
    "/ai/history-analysis",
    vValidator("json", historyAnalysisRequestSchema),
    async (c) => {
      const { conversations, knownConceptIds } = c.req.valid("json");
      const deps = resolve(c.env);
      if (!deps.apiKey) {
        console.error("ai service is not configured", { path: c.req.path });
        return c.json({ error: "AI service is not configured" }, 503);
      }

      const model = deps.model ?? ALLOWED_MODELS[0];
      if (!isAllowedModel(model)) {
        console.error("configured GEMINI_MODEL is not in the allowlist", { model });
        return c.json({ error: "model is not allowed" }, 503);
      }

      const prompt = buildHistoryAnalysisPrompt(conversations, knownConceptIds);
      const estimatedInputTokens = estimateInputTokens(prompt);
      if (estimatedInputTokens > AI_USAGE_LIMITS.inputTokensPerRequest) {
        return c.json(
          {
            error: "input is too large",
            message: `入力が1回あたりの上限を超える見積もりです。会話の件数を減らしてください。`,
            limitTokens: AI_USAGE_LIMITS.inputTokensPerRequest,
            estimatedTokens: estimatedInputTokens,
          },
          400,
        );
      }

      const userId = c.get("user").userId;
      const now = deps.now();
      const monthKey = utcMonthKey(now);
      const dayKey = utcDayKey(now);

      await deps.identity.ensureUser({ userId, nowMs: now.getTime() });

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
        // 分析は JSON を1回だけ受け取るため、ストリーミングではなく
        // 同期的な generateContent を使う。
        upstream = await deps.fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "x-goog-api-key": deps.apiKey, "Content-Type": "application/json" },
            // 資格情報を転送先へ流さない（RULE-002）。
            redirect: "error",
            // 複数会話の分析は時間がかかるが、応答が戻らないまま予約した
            // 回数枠をぶら下げ続けさせない（RULE-001）。
            signal: AbortSignal.timeout(120_000),
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: "application/json",
                maxOutputTokens: AI_USAGE_LIMITS.outputTokensPerRequest,
              },
            }),
          },
        );
      } catch (cause) {
        console.error("ai upstream request failed", { userId, model, cause });
        return c.json({ error: "AI upstream request failed" }, 502);
      }

      if (!upstream.ok) {
        console.error("ai upstream request failed", { userId, model, status: upstream.status });
        return c.json({ error: "AI upstream request failed" }, 502);
      }

      let upstreamBody: unknown;
      try {
        upstreamBody = await upstream.json();
      } catch (cause) {
        // 2xx で本文が読めないのは失敗として扱う。空の観測を返すと
        // 「分析したが何も見つからなかった」と区別がつかない（RULE-004）。
        console.error("ai analysis response is not valid JSON", { userId, model, cause });
        return c.json({ error: "AI analysis response was invalid" }, 502);
      }

      const text = extractGenerateContentText(upstreamBody);
      if (text === null) {
        console.error("ai analysis response has no text", { userId, model });
        return c.json({ error: "AI analysis response was invalid" }, 502);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        console.error("ai analysis output is not valid JSON", { userId, model, cause });
        return c.json({ error: "AI analysis response was invalid" }, 502);
      }
      const rawObservations = (parsed as { observations?: unknown }).observations;
      if (!Array.isArray(rawObservations)) {
        console.error("ai analysis output has no observations array", { userId, model });
        return c.json({ error: "AI analysis response was invalid" }, 502);
      }

      // 構造の合わない観測は黙って捨てず、件数を応答へ載せる。
      const observations: HistoryAnalysisResponse["observations"] = [];
      let dropped = 0;
      for (const item of rawObservations) {
        const observation = v.safeParse(historyObservationSchema, item);
        if (observation.success) observations.push(observation.output);
        else dropped += 1;
      }

      // 実消費のトークンを蓄積する。非ストリームなので応答本文から
      // usageMetadata を読める。取れなければ見積もりを足して記録する
      // （0 で済ませると安全弁が効かない）。
      const totalTokens = readUsageMetadataTokens(upstreamBody);
      const tokens = totalTokens ?? estimatedInputTokens + AI_USAGE_LIMITS.outputTokensPerRequest;
      if (totalTokens === null) {
        console.warn("ai analysis returned no usageMetadata; recording an estimate", {
          userId,
          monthKey,
          model,
          estimatedTokens: tokens,
        });
      }
      try {
        await deps.usage.addTokens({
          userId,
          monthKey,
          dayKey,
          tokens,
          updatedAt: deps.now().toISOString(),
        });
      } catch (cause) {
        console.error("failed to record ai token usage", { userId, monthKey, tokens, cause });
      }

      const body: HistoryAnalysisResponse = { observations, droppedObservations: dropped };
      return c.json(body);
    },
  );

  return route;
}

/**
 * 履歴分析のプロンプト。
 *
 * `knownConceptIds` を「選んでよい候補」として渡す。一覧に無い話題を
 * 既存 Concept へ押し込まないよう、一覧に無い候補は自然言語の名前のまま
 * 返してよいことを明示する。
 */
function buildHistoryAnalysisPrompt(
  conversations: readonly { sourceId: string; title?: string; body: string; observedAt?: string }[],
  knownConceptIds: readonly string[],
): string {
  const lines = conversations.map((conversation) =>
    [
      `--- conversation ${conversation.sourceId} ---`,
      conversation.title === undefined ? "" : `title: ${conversation.title}`,
      conversation.observedAt === undefined ? "" : `observedAt: ${conversation.observedAt}`,
      conversation.body,
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
  return [
    "あなたは学習履歴の分析器です。以下の会話履歴を読み、各会話で学習者が触れた概念を抽出してください。",
    '出力は JSON オブジェクト1つだけで、{"observations": [...]} の形にしてください。',
    "observations の各要素は次の形です:",
    '{ "sourceId": "会話のID（入力のものをそのまま）", "conceptCandidates": ["概念の候補"], "kind": "question|debugging|explanation|implementation|verification", "confidence": 0.0〜1.0, "observedAt": "ISO 8601（分かれば）" }',
    "conceptCandidates には、分かる場合は次の既知の Concept ID を使ってください:",
    knownConceptIds.join(", "),
    '一覧に合うものが無い場合は、無理に当てはめず短い名前（例: "kubernetes"）をそのまま返してください。',
    `会話数の上限は ${String(MAX_CONVERSATIONS_PER_ANALYSIS)} 件です。1会話につき観測は最大3件まで。`,
    "プログラミングと無関係な会話からは観測を作らないでください。",
    "",
    ...lines,
  ].join("\n");
}

/** generateContent の応答から本文テキストを取り出す。取れなければ null。 */
function extractGenerateContentText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const candidates = (body as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return null;
  const parts: string[] = [];
  for (const candidate of candidates) {
    const content = (candidate as { content?: unknown }).content;
    const partList = (content as { parts?: unknown })?.parts;
    if (!Array.isArray(partList)) continue;
    for (const part of partList) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length === 0 ? null : parts.join("");
}

/** generateContent の応答から usageMetadata.totalTokenCount を読む。 */
function readUsageMetadataTokens(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const usage = (body as { usageMetadata?: unknown }).usageMetadata;
  if (typeof usage !== "object" || usage === null) return null;
  const total = (usage as { totalTokenCount?: unknown }).totalTokenCount;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

/**
 * SSE を通しながら `usageMetadata.totalTokenCount` を拾う変換ストリーム。
 *
 * **本文は一切書き換えず、そのまま下流へ渡す。** 計測のために中身を加工すると、
 * クライアントの解析がサーバー側の都合に依存する。
 *
 * Gemini は各チャンクに `usageMetadata` を載せ、値は累計である。
 * したがって**最後に観測した値**が、そのリクエストの総消費になる。
 */
function meterUsage(
  body: ReadableStream<Uint8Array>,
  handlers: { onTotalTokens: (tokens: number) => void; onMissingUsage: () => void },
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffered = "";
  let lastTotalTokens: number | null = null;
  // 蓄積は1回だけ行う。`flush` と `cancel` の両方から呼びうるため。
  let recorded = false;

  const record = () => {
    if (recorded) return;
    recorded = true;
    const total = readTotalTokenCount(buffered);
    if (total !== null) lastTotalTokens = total;
    if (lastTotalTokens === null) handlers.onMissingUsage();
    else handlers.onTotalTokens(lastTotalTokens);
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // 先に下流へ渡す。計測は付随的な処理であり、これのために
        // 利用者への応答を遅らせない。
        controller.enqueue(chunk);

        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split(/\r?\n/);
        // 最後の要素は行の途中かもしれないので次のチャンクへ持ち越す。
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const total = readTotalTokenCount(line);
          if (total !== null) lastTotalTokens = total;
        }
      },
      flush: record,
      // 利用者が途中で読むのをやめても、上流は既にそこまで生成しており
      // 課金は発生している。`cancel` で数えないと、**中断するだけで
      // トークンの安全弁をすり抜けられる**（`flush` は cancel 時に呼ばれない）。
      // そこまでに観測した累計、無ければ見積もりを記録する。
      cancel: record,
    }),
  );
}

/**
 * SSE の1行から `usageMetadata.totalTokenCount` を読む。
 *
 * 取れなければ `null` を返す。`data:` 以外の行（コメント、空行、`[DONE]`）が
 * 混ざるのは正常なので、そこは失敗として扱わない。
 * ただし**数値でない値を 0 とみなさない**（RULE-004）。読めなかったことは
 * `null` のまま呼び出し側へ伝え、`onMissingUsage` の判断に委ねる。
 */
function readTotalTokenCount(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "" || payload === "[DONE]") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // 途中で切れた JSON を受け取ることはありうる。行として不完全なだけなので
    // 失敗にはしない。総消費は後続のチャンクに載る累計から取れる。
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const usage = (parsed as { usageMetadata?: unknown }).usageMetadata;
  if (typeof usage !== "object" || usage === null) return null;
  const total = (usage as { totalTokenCount?: unknown }).totalTokenCount;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}
