/**
 * 確認問題の生成で上流（Gemini）を呼ぶ。送り直しと、失敗の原因を切り分けるための経過を持つ。
 *
 * 呼び出し元は `checks/generate.ts`。ここは HTTP の応答を組み立てない。
 * 失敗は {@link UpstreamResult} の理由と経過で返し、本文は `checks/errors.ts` が作る。
 */

import { AI_USAGE_LIMITS, type AllowedModel } from "../contract/ai-usage.js";

/**
 * 上流への単発リクエストのタイムアウト（RULE-001）。
 *
 * ストリーミングではないので壁時計で切ってよい。2問と例示コードを作らせるため、
 * `ai/responses` の対話よりは長めに置く。ここで切れた場合、生成は失敗として
 * 利用者へ返る（黙って空の問題を出さない）。
 *
 * 生成は時間がかかる前提で長く取る（#259 の決定）。30 秒では、混雑で遅れた生成や、
 * 503 のあとの送り直しが間に合わずに失敗していた。送り直しの待ちもこの内側に収める。
 * Web の締め切り（`apps/web/src/client/check.ts` の `CHECK_GENERATE_TIMEOUT_MS`、3 分）より
 * 短くし、ここで切れたときの理由を利用者へ返せるようにする。
 */
const UPSTREAM_TIMEOUT_MS = 150_000;

/**
 * 上流の一時的な失敗のあとに送り直すまでの待ち時間。要素の数が再送の回数になる。
 *
 * Gemini は混雑すると 503（UNAVAILABLE）を返す。本番で生成が続けて失敗した（#259）。
 * 待ちは {@link UPSTREAM_TIMEOUT_MS} の期限の内側に収める。
 */
export const UPSTREAM_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/**
 * 送り直してよい上流の状態コード。上流側の一時的な障害に限る。
 *
 * 429（割り当て超過）は入れない。分単位で回復しないことが多く、すぐ送り直すと
 * 割り当てをさらに減らす。4xx は要求の誤りなので送り直しても直らない。
 */
const RETRYABLE_UPSTREAM_STATUSES: ReadonlySet<number> = new Set([500, 503]);

/**
 * 生成の温度。
 *
 * 形式の逸脱を減らしたいため低めに固定し、クライアントからは指定させない。
 * 作り直したときに同じ問題へ寄りすぎないよう、0 にはしない。
 */
const TEMPERATURE = 0.5;

/** `ms` 待つ。`signal` が先に中断されたら、その理由で拒否する。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason as Error);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 上流（Gemini）への呼び出しが失敗した理由。応答の中身ではなく、届き方の問題。 */
export type UpstreamFailure =
  "upstream-timeout" | "upstream-unreachable" | "upstream-status" | "upstream-unreadable";

/**
 * 上流への呼び出しの経過。失敗の原因を切り分けるために応答へ添える（#253）。
 *
 * 状態コードだけでは、混雑（UNAVAILABLE）か割り当て超過（RESOURCE_EXHAUSTED）か、
 * キーやプロジェクトの問題かが分からず、本番で原因を絞れなかった。
 */
export type UpstreamTrace = {
  /** 送った回数（送り直しを含む）。 */
  attempts: number;
  /** 送った順のモデル（#268）。 */
  models: string[];
  /** 送った順の状態コード。届かなかった回は含まない。 */
  statuses: number[];
  /** 最初の送信から失敗が決まるまでの時間。 */
  elapsedMs: number;
  /** Gemini のエラー本文の `error.status`（例: `UNAVAILABLE`）。 */
  upstreamStatus?: string;
  /** Gemini のエラー本文の `error.message`。長さを切り、キーらしい文字列は伏せる。 */
  upstreamMessage?: string;
  /** `ErrorInfo.reason`（例: `API_KEY_INVALID`）。 */
  upstreamReason?: string;
  /** `QuotaFailure` で超えた割り当て（例: `GenerateRequestsPerDayPerProjectPerModel`）。 */
  quotaId?: string;
  /** `RetryInfo.retryDelay`（例: `33s`）。 */
  retryDelay?: string;
  /** 届かなかったときの例外の名前と文。 */
  cause?: string;
};

type UpstreamErrorDetail = Pick<
  UpstreamTrace,
  "upstreamStatus" | "upstreamMessage" | "upstreamReason" | "quotaId" | "retryDelay"
>;

/** 応答へ載せる上流の文の上限。想定外に長い本文をそのまま中継しない。 */
const UPSTREAM_TEXT_LIMIT = 300;

/** 載せる文を切り詰め、API キーらしい文字列を伏せる。Gemini はキーを返さないが念のため。 */
function clipUpstreamText(text: string): string {
  const redacted = text.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]");
  return redacted.length > UPSTREAM_TEXT_LIMIT
    ? `${redacted.slice(0, UPSTREAM_TEXT_LIMIT)}…`
    : redacted;
}

/**
 * Gemini のエラー本文（`{ error: { code, message, status, details } }`）から、
 * 原因の切り分けに使う項目だけを取り出す。JSON でなければ本文の先頭を文として返す。
 */
function readUpstreamError(raw: string): UpstreamErrorDetail {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const text = raw.trim();
    return text.length === 0 ? {} : { upstreamMessage: clipUpstreamText(text) };
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (typeof error !== "object" || error === null) return {};
  const { status, message, details } = error as {
    status?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const found: UpstreamErrorDetail = {};
  if (typeof status === "string") found.upstreamStatus = clipUpstreamText(status);
  if (typeof message === "string") found.upstreamMessage = clipUpstreamText(message);
  if (Array.isArray(details)) {
    for (const detail of details as unknown[]) {
      if (typeof detail !== "object" || detail === null) continue;
      const item = detail as Record<string, unknown>;
      const type = typeof item["@type"] === "string" ? item["@type"] : "";
      if (type.endsWith("ErrorInfo") && typeof item.reason === "string") {
        found.upstreamReason = clipUpstreamText(item.reason);
      } else if (type.endsWith("RetryInfo") && typeof item.retryDelay === "string") {
        found.retryDelay = clipUpstreamText(item.retryDelay);
      } else if (type.endsWith("QuotaFailure") && Array.isArray(item.violations)) {
        const first = (item.violations as unknown[])[0] as { quotaId?: unknown } | undefined;
        if (typeof first?.quotaId === "string") found.quotaId = clipUpstreamText(first.quotaId);
      }
    }
  }
  return found;
}

/** 経過を、画面の文の末尾に添える形にする。 */
export function describeTrace(trace: UpstreamTrace): string {
  const parts: string[] = [];
  const labels = [trace.upstreamStatus, trace.upstreamReason, trace.quotaId].filter(
    (part) => part !== undefined,
  );
  if (labels.length > 0) parts.push(labels.join(" / "));
  if (trace.upstreamMessage !== undefined) parts.push(`「${trace.upstreamMessage}」`);
  if (trace.retryDelay !== undefined) parts.push(`再試行の目安 ${trace.retryDelay}`);
  if (trace.cause !== undefined) parts.push(trace.cause);
  // モデルを切り替えたときだけ、どのモデルが何を返したかを並べる。
  const switched = new Set(trace.models).size > 1;
  const sent = trace.statuses.map((status, index) =>
    switched ? `${trace.models[index] ?? "?"} ${String(status)}` : String(status),
  );
  const statuses = sent.length > 0 ? `（${sent.join(", ")}）` : "";
  parts.push(`${String(trace.attempts)} 回送信${statuses}`);
  parts.push(`${(trace.elapsedMs / 1000).toFixed(1)} 秒`);
  return `［詳細: ${parts.join("・")}］`;
}

/** `AbortSignal.timeout` による打ち切りか。 */
function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

export interface UpstreamRequest {
  fetch: typeof fetch;
  apiKey: string;
  /** 順に試すモデル。allowlist を通したものだけを渡す。空にしない。 */
  models: readonly AllowedModel[];
  prompt: string;
  retryDelaysMs: readonly number[];
  /** ログに載せるため。 */
  conceptId: string;
}

export type UpstreamResult =
  | {
      ok: true;
      /** 2xx の応答本文。中身の検証は `checks/response.ts` が行う。 */
      raw: string;
      /** 応答を返したモデル。 */
      model: AllowedModel;
    }
  | {
      ok: false;
      reason: UpstreamFailure;
      trace: UpstreamTrace;
      /** `upstream-status` のときの上流の状態コード。 */
      status?: number;
    };

/**
 * 上流へ生成を頼み、2xx の本文を返す。
 *
 * 1巡でモデルを順に試し（混雑はモデルごとなので、待たずに次へ送る）、全部が一時的な失敗なら
 * 少し待って次の巡へ。巡の数は待ち時間の要素の数 + 1（#259・#268）。
 * 失敗は例外にせず、理由と経過を返す。ログはここで残す。
 */
export async function requestCheckGeneration(request: UpstreamRequest): Promise<UpstreamResult> {
  const { conceptId, models, retryDelaysMs } = request;
  let upstream: Response;
  // 最後に送ったモデル。成功したらこれが問題を作ったモデルになる。
  let model: AllowedModel = models[0];
  // 再送をまたいで1つの期限を使う。再送のたびに延ばすと、利用者を待たせる上限が決まらない（RULE-001）。
  const deadline = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  // 失敗したときに原因を切り分けられるよう、送った回数・モデル・状態コード・時間を残す（#253）。
  const startedAt = Date.now();
  const statuses: number[] = [];
  const sentModels: string[] = [];
  let attempts = 0;
  const trace = (detail: Partial<UpstreamTrace> = {}): UpstreamTrace => ({
    attempts,
    models: [...sentModels],
    statuses: [...statuses],
    elapsedMs: Date.now() - startedAt,
    ...detail,
  });
  try {
    rounds: for (let round = 0; ; round += 1) {
      for (const [index, candidate] of models.entries()) {
        model = candidate;
        attempts += 1;
        sentModels.push(model);
        upstream = await request.fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "x-goog-api-key": request.apiKey, "Content-Type": "application/json" },
            // リダイレクトを自動追跡しない。転送先へ API キーごと送られると、
            // 資格情報が意図しない相手に渡る（RULE-002）。Workers は `redirect: "error"` を
            // 実装しておらず送信前に例外を投げるので `manual` にし、3xx は下の
            // `!upstream.ok` で失敗として扱う（#253）。
            redirect: "manual",
            // 応答を一括で受け取る単発のリクエストなので、壁時計で必ず切る（RULE-001）。
            signal: deadline,
            body: JSON.stringify({
              contents: [{ parts: [{ text: request.prompt }] }],
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
        statuses.push(upstream.status);
        if (!RETRYABLE_UPSTREAM_STATUSES.has(upstream.status)) break rounds;
        const lastInRound = index === models.length - 1;
        if (lastInRound && retryDelaysMs[round] === undefined) break rounds;
        // 混雑（503）などの一時的な失敗は、次のモデルか次の巡で送り直す。上流は失敗した
        // 呼び出しを課金しないので、利用量の予約（1回）はそのままにする。本文は読まずに捨てる。
        console.warn("check generation upstream is unavailable; retrying", {
          conceptId,
          model,
          status: upstream.status,
          attempt: attempts,
        });
        try {
          await upstream.body?.cancel();
        } catch (cause) {
          // 捨てる本文の読み込みが壊れていても、送り直しの判断（状態コード）は変わらない。
          // 外側の catch へ流すと「接続できなかった」になり、送り直さずに終わる。
          console.warn("check generation could not discard an upstream body", {
            conceptId,
            model,
            cause,
          });
        }
      }
      await sleep(retryDelaysMs[round] ?? 0, deadline);
    }
  } catch (cause) {
    // fetch の拒否（ネットワーク断、タイムアウト）は
    // 下の !ok 分岐に届かない。失敗として数えられるよう応答の前に記録する。
    const failed = trace({
      cause: clipUpstreamText(
        cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
      ),
    });
    console.error("check generation upstream request failed", {
      conceptId,
      model,
      cause,
      trace: failed,
    });
    return {
      ok: false,
      reason: isTimeout(cause) ? "upstream-timeout" : "upstream-unreachable",
      trace: failed,
    };
  }

  if (!upstream.ok) {
    // 上流のエラー本文から、原因の切り分けに使う要点だけを取り出して添える（#253）。
    // 本文が読めなくても、状態コードで失敗は伝えられるので続ける。
    let errorBody = "";
    try {
      errorBody = await upstream.text();
    } catch (cause) {
      console.warn("check generation could not read an upstream error body", {
        conceptId,
        model,
        cause,
      });
    }
    const failed = trace(readUpstreamError(errorBody));
    console.error("check generation upstream request failed", {
      conceptId,
      model,
      status: upstream.status,
      trace: failed,
    });
    return { ok: false, reason: "upstream-status", trace: failed, status: upstream.status };
  }

  try {
    return { ok: true, raw: await upstream.text(), model };
  } catch (cause) {
    // 2xx でも本文が読めなければ失敗である（RULE-004）。
    console.error("check generation upstream body could not be read", {
      conceptId,
      model,
      cause,
    });
    return { ok: false, reason: "upstream-unreadable", trace: trace() };
  }
}
