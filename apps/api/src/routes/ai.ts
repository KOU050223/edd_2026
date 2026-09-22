/**
 * `POST /v1/ai/responses`。Managed AI（運営が Gemini を叩く経路）。
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
} from "../contract/ai-usage.js";
import type { AiUsageRepository, IdentityRepository } from "../repository/types.js";

const requestSchema = v.object({
  selection: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
  question: v.pipe(v.string(), v.maxLength(4_000)),
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

  route.post("/ai/responses", vValidator("json", requestSchema), async (c) => {
    const {
      selection,
      question,
      model: requestedModel,
      temperature,
      maxTokens,
    } = c.req.valid("json");
    const normalizedQuestion = question.trim() || DEFAULT_EXPLANATION_QUESTION;
    const deps = resolve(c.env);
    if (!deps.apiKey) return c.json({ error: "AI service is not configured" }, 503);

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
    const estimatedInputTokens = estimateInputTokens(prompt);
    if (estimatedInputTokens > AI_USAGE_LIMITS.inputTokensPerRequest) {
      return c.json(
        {
          error: "input is too large",
          message:
            `入力が1回あたりの上限（約 ${String(AI_USAGE_LIMITS.inputTokensPerRequest)} tokens）を` +
            `超えています（約 ${String(estimatedInputTokens)} tokens）。選択範囲を狭めてください。`,
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

    // 上流へ流す前に読む。トークンの安全弁は前回までの累計で判定する
    // （今回の消費は終わるまで分からない）。
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
    if (before.dailyRequests >= AI_USAGE_LIMITS.dailyRequests) {
      return c.json(limitReached("daily", now), 429);
    }
    if (before.monthlyRequests >= AI_USAGE_LIMITS.monthlyRequests) {
      return c.json(limitReached("monthly", now), 429);
    }

    // 回数は上流へ流す前に増やす。ストリームの完了を待ってから数えると、
    // 応答を読み切らずに切断する呼び出しを繰り返すだけで上限を素通りできる。
    const after = await deps.usage.increment({
      userId,
      monthKey,
      dayKey,
      updatedAt: now.toISOString(),
    });
    // 読みと加算の間に同じユーザーの別リクエストが割り込みうる。加算後の値で
    // もう一度見て、上限を越えていたら流さない。D1 側の加算は1文なので、
    // 競合しても回数を数え落とすことはない。
    if (after.dailyRequests > AI_USAGE_LIMITS.dailyRequests) {
      return c.json(limitReached("daily", now), 429);
    }
    if (after.monthlyRequests > AI_USAGE_LIMITS.monthlyRequests) {
      return c.json(limitReached("monthly", now), 429);
    }

    const upstream = await deps.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "x-goog-api-key": deps.apiKey, "Content-Type": "application/json" },
        // リダイレクトを自動追跡しない。転送先へ API キーごと送られると、
        // 資格情報が意図しない相手に渡る（.agents/rules/rules.md RULE-002）。
        redirect: "error",
        body: JSON.stringify({
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

    if (!upstream.ok || !upstream.body) {
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

  return route;
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
