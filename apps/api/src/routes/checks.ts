/**
 * `POST /v1/checks:generate`。確認問題（2問1組）を AI に生成させる経路（#184）。
 *
 * ## `POST /v1/ai/responses` と別の口にする理由
 *
 * 既存の経路は `selection`（コード選択、1〜20,000文字）が必須で、コード選択を
 * 前提としたスキーマである。問題生成には渡すべき `selection` が無い。
 *
 * ## `ai_usage` の回数上限の対象外である
 *
 * 生成した問題は全利用者で使い回す（#185）。1 Concept につき1回の呼び出しで2問を作り、
 * Concept は 148 件の有限集合なので、**生成量は利用者数に比例しない。**
 * 全員が使う問題を作るコストを、最初にアクセスした利用者の枠（日 15 回 / 月 150 回）から
 * 引く理由が無い。したがってこのルートは `AiUsageRepository` を持たず、加算もしない。
 *
 * **外すのは回数の勘定だけである。** 代わりの歯止めは全部効かせる。
 *
 * - 既知の `conceptId` だけを受理する（`checkPromptInputFor`）
 * - 利用者ごとのレート制限（30 回/分）
 * - model allowlist と、1回あたりの入力・出力トークン上限
 * - 上流への単発リクエストにタイムアウト（RULE-001）
 *
 * ## #185 より先に有効化しない
 *
 * 歯止めの本体は「保存済みがあれば生成しない」であり、それを実装するのは #185 である。
 * **このルートは `app.ts` へまだ繋いでいない。** 単独で開けると `ai_usage` の外で
 * 毎回生成が走る経路になる。#185 のキャッシュ確認とセットで有効化する
 * （`app.test.ts` が、公開されていないことを検査している）。
 *
 * レート制限をこのファイルで掛けているのはそのためである。他のルートの上限は
 * `app.ts` に並んでいるが、まだ `app.route` していないルートの上限だけを
 * `app.ts` へ置くと、参照先の無い設定になる。**上限をルートと一緒に持ち歩かせる。**
 */

import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import * as v from "valibot";
import { CONCEPT_ID_PATTERN } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { rateLimit } from "../auth/rate-limit.js";
import {
  AI_USAGE_LIMITS,
  ALLOWED_MODELS,
  estimateInputTokens,
  isAllowedModel,
} from "../contract/ai-usage.js";
import { buildCheckPrompt, checkPromptInputFor } from "../checks/prompt.js";
import {
  parseConceptCheck,
  readGeneratedText,
  type CheckParseFailure,
  type GeneratedTextFailure,
} from "../checks/response.js";

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
 * 1 Concept 1組を保存して使い回す（#185）ので、毎回違う問題を作る必要は無い。
 * 形式の逸脱を減らしたいため低めに固定し、クライアントからは指定させない。
 */
const TEMPERATURE = 0.3;

const requestSchema = v.object({
  // 既知の ID かどうかは `checkPromptInputFor` が判定する。ここは形式だけを見る。
  // 長さの上限を置くのは、巨大な文字列で照合を走らせないため。
  conceptId: v.pipe(v.string(), v.minLength(1), v.maxLength(200), v.regex(CONCEPT_ID_PATTERN)),
});

export interface ChecksDeps {
  apiKey?: string;
  model?: string;
  fetch: typeof fetch;
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

export function createChecksRoute(resolve: ChecksDepsResolver) {
  const route = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  // 頻度の歯止めは維持する（#184 の決定表）。外すのは `ai_usage` の回数だけである。
  // 認証（`app.ts` の `/v1/*`）の後に走るので userId で数えられる。
  route.use(
    "/checks:generate",
    rateLimit((env) => env.PROFILE_RATE_LIMITER),
  );

  route.post("/checks:generate", vValidator("json", requestSchema), async (c) => {
    const { conceptId } = c.req.valid("json");
    const deps = resolve(c.env);

    const resolved = checkPromptInputFor(conceptId);
    if (!resolved.ok) {
      if (resolved.reason === "unknown-concept") {
        // 一覧に無い ID は弾く。ここが生成回数の上界を決めている。
        return c.json(
          {
            error: "unknown concept",
            message: "その概念は一覧にありません。確認問題を作れる概念を選んでください。",
          },
          400,
        );
      }
      // 概要の無い Concept は定義の不備であり、利用者の失敗ではない。
      // 表示名だけで生成へ進めず、追える形で残す（RULE-004）。
      console.error("concept has no summary; refusing to generate a check", { conceptId });
      return c.json({ error: "concept definition is incomplete" }, 500);
    }

    if (!deps.apiKey) {
      // 設定漏れは運営側の障害である。503 だけでは Workers のログから区別できない。
      console.error("ai service is not configured", { path: c.req.path });
      return c.json({ error: "AI service is not configured" }, 503);
    }

    // クライアントにモデルを選ばせない。生成は全利用者が使う問題を作る経路なので、
    // 単価とふるまいを設定側で固定する。設定値であっても allowlist は通す。
    const model = deps.model ?? ALLOWED_MODELS[0];
    if (!isAllowedModel(model)) {
      console.error("configured model is not allowed", { model, allowed: ALLOWED_MODELS });
      return c.json({ error: "AI service is not configured" }, 503);
    }

    const prompt = buildCheckPrompt(resolved.input);
    const estimatedInputTokens = estimateInputTokens(prompt);
    if (estimatedInputTokens > AI_USAGE_LIMITS.inputTokensPerRequest) {
      // 入力は Concept の定義から組み立てたもので、利用者が渡した文字列ではない。
      // 400 で「短くしてください」と言っても利用者には縮めようがないため、
      // こちらの不備として 500 を返し、上限を見直せるようログへ残す。
      console.error("check prompt exceeds the per-request input limit", {
        conceptId,
        estimatedInputTokens,
        limit: AI_USAGE_LIMITS.inputTokensPerRequest,
      });
      return c.json({ error: "check prompt is too large" }, 500);
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
      // 中身を持ち回すとプロバイダ由来の文字列がログへ流れ込む。
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

    const generated = readGeneratedText(raw);
    if (!generated.ok) {
      console.error("check generation response was not usable", {
        conceptId,
        model,
        reason: generated.reason,
        detail: generated.detail,
      });
      return c.json(failureBody(generated.reason), 502);
    }

    // 生成のコストは `ai_usage` に載らない。**唯一の記録がこのログである。**
    // 148 件を埋めるまでの総量を後から数えられるよう、1件ずつ残す
    // （docs/architecture.md「監視・監査ログ・障害時の再送」）。
    // トークン数が取れなければ 0 で埋めず、取れなかったこととして残す。
    console.info("check generation completed", {
      conceptId,
      model: generated.modelVersion ?? model,
      totalTokens: generated.totalTokens ?? "unknown",
    });

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

    return c.json(
      {
        ...parsed.check,
        model: generated.modelVersion ?? model,
        generatedAt: deps.now().toISOString(),
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  return route;
}
