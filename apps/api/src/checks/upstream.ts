/**
 * 確認問題の生成で上流（Gemini）を呼ぶ。送り直しと、失敗の原因を切り分けるための経過を持つ。
 *
 * 呼び出し元は `checks/generate.ts`。ここは HTTP の応答を組み立てない。
 * 失敗は {@link UpstreamResult} の理由と経過で返し、本文は `checks/errors.ts` が作る。
 */

import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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

export interface UpstreamRequest {
  fetch: typeof fetch;
  apiKey: string;
  /** 順に試すモデル。allowlist を通したものだけを渡す。空にしない。 */
  models: readonly AllowedModel[];
  prompt: string;
  retryDelaysMs: readonly number[];
  /**
   * 出力の上限（tokens）。省略は `AI_USAGE_LIMITS.outputTokensPerRequest`。
   * マップの生成（`maps/generate.ts`）だけが、1回で多くのノードを作るために広げる。
   */
  maxOutputTokens?: number;
  /**
   * 思考に使ってよいトークンの上限。省略は上流の既定（無制限に近い）。
   * 思考が出力上限を食うと JSON が途中で切れる（#249 のスパイクで、出力上限 3,000 のうち思考が
   * 約 2,900 を使った）。要約・選択のような短い出力は小さく絞る。
   */
  thinkingBudget?: number;
  /** ログに載せるため。マップの生成では何を作る呼び出しか（例: `map:skeleton`）。 */
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

/** 送って状態コードまで受け取れた応答と、送ったモデル。 */
interface Sent {
  response: Response;
  model: AllowedModel;
}

// 失敗の種類。最後に `catchTags` で種類ごとの応答にする。種類を足して扱い忘れると型が合わなくなる。
/** 混雑などの一時的な失敗。次のモデルか次の巡へ送り直す合図で、外へは出ない。 */
class UpstreamBusy extends Data.TaggedError("UpstreamBusy") {}
/** 上流へ届かなかった（ネットワーク断など）。 */
class UpstreamUnreachable extends Data.TaggedError("UpstreamUnreachable")<{ cause: unknown }> {}
/** 期限（{@link UPSTREAM_TIMEOUT_MS}）までに終わらなかった。 */
class UpstreamTimedOut extends Data.TaggedError("UpstreamTimedOut")<{ cause: unknown }> {}
/** 2xx 以外が返った。送り直しを使い切った一時的な失敗と、3xx・4xx を含む。 */
class UpstreamRejected extends Data.TaggedError("UpstreamRejected")<{
  status: number;
  model: AllowedModel;
  detail: UpstreamErrorDetail;
}> {}
/** 2xx だが本文が読めなかった。成功の状態コードで失敗を隠さない（RULE-004）。 */
class UpstreamUnreadable extends Data.TaggedError("UpstreamUnreadable")<{
  model: AllowedModel;
  cause: unknown;
}> {}
/** 捨てる・エラーとして読むだけの本文が読めなかった。ログに残して先へ進むためのもので、外へは出ない。 */
class UpstreamBodyFailed extends Data.TaggedError("UpstreamBodyFailed")<{ cause: unknown }> {}

/** 1回の送信が失敗する理由。状態コードを受け取れなかった場合に限る。 */
type SendError = UpstreamUnreachable | UpstreamTimedOut;

/** fetch の拒否が時間切れによるものか。 */
function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

/**
 * `tries` を先頭から順に試し、混雑なら次へ回す。最後に `last` を試す。
 * 混雑以外の失敗（届かない・時間切れ）は次へ回さずにそのまま返す。
 */
function inTurn<E>(
  tries: readonly Effect.Effect<Sent, SendError | UpstreamBusy>[],
  last: Effect.Effect<Sent, E>,
): Effect.Effect<Sent, SendError | E> {
  return tries.reduceRight<Effect.Effect<Sent, SendError | E>>(
    (next, current) => current.pipe(Effect.catchTag("UpstreamBusy", () => next)),
    last,
  );
}

/**
 * 上流へ生成を頼み、2xx の本文を返す。
 *
 * 1巡でモデルを順に試し（混雑はモデルごとなので、待たずに次へ送る）、全部が一時的な失敗なら
 * 少し待って次の巡へ。巡の数は待ち時間の要素の数 + 1（#259・#268）。
 * 失敗は例外にせず、理由と経過を返す。ログはここで残す。
 */
export function requestCheckGeneration(request: UpstreamRequest): Promise<UpstreamResult> {
  const { conceptId, models, retryDelaysMs } = request;
  // 失敗したときに原因を切り分けられるよう、送ったモデル・状態コード・時間を残す（#253）。
  const startedAt = Date.now();
  const sentModels: AllowedModel[] = [];
  const statuses: number[] = [];
  const trace = (detail: Partial<UpstreamTrace> = {}): UpstreamTrace => ({
    attempts: sentModels.length,
    models: [...sentModels],
    statuses: [...statuses],
    elapsedMs: Date.now() - startedAt,
    ...detail,
  });
  // 送信と本文の読み込みの両方を、期限で中断するためのもの。`tryPromise` が渡す signal は
  // fetch が応答を返した時点で役目を終えるので、そのあとの本文の読み込みを止められない。
  // 本物の fetch は、この signal の中断で本文のストリームも失敗させる。
  const deadline = new AbortController();
  // 再送の待ちと本文の読み込みまで含めて1つの期限にする。再送のたびに延ばすと、
  // 利用者を待たせる上限が決まらない（RULE-001）。
  const deadlineAt = startedAt + UPSTREAM_TIMEOUT_MS;

  /**
   * 期限の残りで切る。切れたら送信中の fetch も読み込み中の本文も abort し、`onTimeout` で失敗にする。
   * 期限が来たときの扱いは段ごとに違うので、呼ぶ側が決める。
   */
  const withinDeadline = <A, E, E2>(
    effect: Effect.Effect<A, E>,
    onTimeout: (cause: DOMException) => E2,
  ): Effect.Effect<A, E | E2> =>
    Effect.suspend(() =>
      effect.pipe(
        Effect.onInterrupt(() => Effect.sync(() => deadline.abort())),
        Effect.timeoutOrElse({
          duration: Duration.millis(Math.max(0, deadlineAt - Date.now())),
          orElse: () =>
            Effect.fail(
              onTimeout(
                // fetch の `AbortSignal.timeout` と同じ名前にし、経過（`trace.cause`）の書式を揃える。
                new DOMException(
                  `no response within ${String(UPSTREAM_TIMEOUT_MS)} ms`,
                  "TimeoutError",
                ),
              ),
            ),
        }),
      ),
    );

  /** 1回送る。状態コードを受け取れたら、それが何であっても成功とする。 */
  const send = Effect.fnUntraced(function* (
    model: AllowedModel,
  ): Effect.fn.Return<Sent, SendError> {
    sentModels.push(model);
    const response = yield* Effect.tryPromise({
      try: () =>
        request.fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "x-goog-api-key": request.apiKey, "Content-Type": "application/json" },
            // リダイレクトを自動追跡しない。転送先へ API キーごと送られると、
            // 資格情報が意図しない相手に渡る（RULE-002）。Workers は `redirect: "error"` を
            // 実装しておらず送信前に例外を投げるので `manual` にし、3xx は
            // `UpstreamRejected` として扱う（#253）。
            redirect: "manual",
            // 応答を一括で受け取る単発のリクエストなので、壁時計で必ず切る（RULE-001）。
            // 期限は再送をまたいで1つで、`withinDeadline` で切れたら `deadline` を abort する。
            signal: deadline.signal,
            body: JSON.stringify({
              contents: [{ parts: [{ text: request.prompt }] }],
              generationConfig: {
                temperature: TEMPERATURE,
                // 出力上限は常に送る。上流の既定値で走らせると1回あたりの単価が決まらない。
                maxOutputTokens: request.maxOutputTokens ?? AI_USAGE_LIMITS.outputTokensPerRequest,
                // JSON を要求する。コードブロックの囲みが来ないようにするための指定で、
                // 受理側（`response.ts`）は囲みを剥がさずに拒否する。
                responseMimeType: "application/json",
                ...(request.thinkingBudget === undefined
                  ? {}
                  : { thinkingConfig: { thinkingBudget: request.thinkingBudget } }),
              },
            }),
          },
        ),
      catch: (cause) =>
        isTimeout(cause) ? new UpstreamTimedOut({ cause }) : new UpstreamUnreachable({ cause }),
    });
    statuses.push(response.status);
    return { response, model };
  });

  /** 1回送り、一時的な失敗なら本文を捨てて {@link UpstreamBusy} にする。 */
  const sendOrBusy = Effect.fnUntraced(function* (
    model: AllowedModel,
  ): Effect.fn.Return<Sent, SendError | UpstreamBusy> {
    const sent = yield* send(model);
    const { status } = sent.response;
    if (!RETRYABLE_UPSTREAM_STATUSES.has(status)) return sent;
    // 上流は失敗した呼び出しを課金しないので、利用量の予約（1回）はそのままにする。
    console.warn("check generation upstream is unavailable; retrying", {
      conceptId,
      model,
      status,
      attempt: sentModels.length,
    });
    yield* Effect.tryPromise({
      try: async () => sent.response.body?.cancel(),
      catch: (cause) => new UpstreamBodyFailed({ cause }),
    }).pipe(
      // 捨てる本文の読み込みが壊れていても、送り直しの判断（状態コード）は変わらない。
      // 失敗として流すと「接続できなかった」になり、送り直さずに終わる。
      Effect.catchTag("UpstreamBodyFailed", ({ cause }) =>
        Effect.sync(() =>
          console.warn("check generation could not discard an upstream body", {
            conceptId,
            model,
            cause,
          }),
        ),
      ),
    );
    return yield* new UpstreamBusy();
  });

  /** `index` 巡目。最後の巡の最後のモデルだけは、混雑でもそのまま返して状態コードで失敗を伝える。 */
  const round = (index: number): Effect.Effect<Sent, SendError> => {
    const delay = retryDelaysMs[index];
    const head = models.slice(0, -1).map((model) => sendOrBusy(model));
    const tail = models[models.length - 1];
    if (delay === undefined) return inTurn(head, send(tail));
    return inTurn(head, sendOrBusy(tail)).pipe(
      Effect.catchTag("UpstreamBusy", () =>
        Effect.sleep(Duration.millis(delay)).pipe(Effect.andThen(round(index + 1))),
      ),
    );
  };

  /** 2xx 以外の応答を、エラー本文の要点つきの失敗にする（#253）。 */
  const reject = ({ response, model }: Sent): Effect.Effect<never, UpstreamRejected> =>
    withinDeadline(
      Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => new UpstreamBodyFailed({ cause }),
      }),
      // 期限が来ても状態コードはもう分かっている。時間切れで上書きすると、原因を切り分ける
      // 手がかり（400 か 403 か、など）が消える（#253）。本文が読めなかったとして扱う。
      (cause) => new UpstreamBodyFailed({ cause }),
    ).pipe(
      // 本文が読めなくても、状態コードで失敗は伝えられるので続ける。
      Effect.catchTag("UpstreamBodyFailed", ({ cause }) =>
        Effect.sync(() => {
          console.warn("check generation could not read an upstream error body", {
            conceptId,
            model,
            cause,
          });
          return "";
        }),
      ),
      Effect.flatMap((body) =>
        Effect.fail(
          new UpstreamRejected({ status: response.status, model, detail: readUpstreamError(body) }),
        ),
      ),
    );

  const read = ({ response, model }: Sent) =>
    withinDeadline(
      Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => new UpstreamUnreadable({ model, cause }),
      }),
      (cause) => new UpstreamTimedOut({ cause }),
    ).pipe(Effect.map((raw): UpstreamResult => ({ ok: true, raw, model })));

  /** 届かなかった・時間切れを、例外の名前と文つきの失敗にする。 */
  const unsent = (reason: UpstreamFailure, cause: unknown): UpstreamResult => {
    const failed = trace({ cause: clipUpstreamText(describeCause(cause)) });
    console.error("check generation upstream request failed", {
      conceptId,
      model: sentModels.at(-1) ?? models[0],
      cause,
      trace: failed,
    });
    return { ok: false, reason, trace: failed };
  };

  const program = withinDeadline(round(0), (cause) => new UpstreamTimedOut({ cause })).pipe(
    Effect.flatMap(
      (
        sent,
      ): Effect.Effect<UpstreamResult, UpstreamRejected | UpstreamUnreadable | UpstreamTimedOut> =>
        sent.response.ok ? read(sent) : reject(sent),
    ),
    // 失敗の種類ごとに応答を作る。種類を足して扱い忘れると、ここで型が合わなくなる。
    Effect.catchTags({
      UpstreamUnreachable: ({ cause }) => Effect.succeed(unsent("upstream-unreachable", cause)),
      UpstreamTimedOut: ({ cause }) => Effect.succeed(unsent("upstream-timeout", cause)),
      UpstreamRejected: ({ status, model, detail }) => {
        const failed = trace(detail);
        console.error("check generation upstream request failed", {
          conceptId,
          model,
          status,
          trace: failed,
        });
        return Effect.succeed<UpstreamResult>({
          ok: false,
          reason: "upstream-status",
          trace: failed,
          status,
        });
      },
      UpstreamUnreadable: ({ model, cause }) => {
        console.error("check generation upstream body could not be read", {
          conceptId,
          model,
          cause,
        });
        return Effect.succeed<UpstreamResult>({
          ok: false,
          reason: "upstream-unreadable",
          trace: trace(),
        });
      },
    }),
  );
  return Effect.runPromise(program);
}
