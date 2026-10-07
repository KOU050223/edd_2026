/**
 * LearningEvent をAPIサーバーへ同期する。
 *
 * globalStateへのローカル保存（store.ts）とは別に、サーバー側の正本（D1）へも
 * 送る。docs/architecture.md の通りサーバー側が習熟度導出の正本であり、
 * ローカル保存だけでは他端末やWebから見えない。
 *
 * apps/api の外部契約（apps/api/src/contract/learning-event.ts）をそのまま
 * importしない。apps/api/README.md が「このアプリ固有の型を他パッケージから
 * 参照させない」と定めているため、送受信に必要な最小限の形をここで独自に持つ。
 *
 * 同期に失敗しても例外を投げない。store.ts の recordEvent と同じ方針で、
 * 同期の失敗が質問フローを止めてはならない。呼び出し側はログに残すためだけに
 * 戻り値を使う。
 */

import type { LearningEvent, UserConcepts } from "@gakushu-sochi/domain";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { toUserConcepts } from "./user-concepts";

/** 同期に使う設定。VS Codeの設定（package.jsonのcontributes.configuration）から読む値をここへ集約する。 */
export interface SyncConfig {
  /** 例: https://gakushu-sochi-api.uozumi05.workers.dev */
  apiBaseUrl: string;
  /** `Authorization: Bearer <token>` に使う短命トークンを取得する。 */
  apiToken: () => Promise<string>;
  /** この端末のID。store.ts の getOrCreateClientId で取得する。 */
  clientId: string;
  /** トークン取得の待機中に同意が取り消されていないか、送信直前に確認する。 */
  canSend?: () => boolean;
}

/** サーバーがイベント1件ごとに返す結果種別。apps/api/src/contract/learning-event.ts の SyncResultStatus と対応する。 */
export type SyncEventStatus = "accepted" | "duplicate" | "rejected";

/** サーバー応答の最小限の形。呼び出し側が使わない項目は持たない。 */
interface SyncResponseBody {
  results: {
    status: SyncEventStatus;
    reason?: string;
    /**
     * 受理されたが削除境界の内側に倒れ、サーバーへは保存されなかった
     * イベントなら true（Issue #124）。古いサーバーは返さないため、
     * 省略は false と同じ意味で扱う。
     */
    droppedByReset?: boolean;
  }[];
  /**
   * サーバーで学習履歴が最後に削除された時刻（epoch ミリ秒）。無ければ null。
   *
   * この端末以外から `DELETE /v1/learning-events` が呼ばれたとき、次回の同期で
   * 削除を知るための手がかり（Issue #124）。古いサーバーはこのフィールドを
   * 返さないため、省略は「削除されたことが無い」ではなく「不明」として扱い、
   * 省略されたことだけを理由にローカルのコピーは消さない。
   */
  historyResetAtMs?: number | null;
}

export type SyncOutcome =
  | {
      ok: true;
      status: SyncEventStatus;
      reason?: string;
      /**
       * サーバーが伝えてきた削除時刻。応答に含まれなければ null。
       * 「削除無し」と「フィールドが無い古いサーバー」を区別しないのは、
       * どちらの場合もローカルを消す根拠にしないためである。
       */
      historyResetAtMs: number | null;
      /**
       * 受理されたが削除境界の内側に倒れ、サーバーへは保存されなかった
       * なら true。追従後にローカルへ記録し直すかの判断に使う。
       */
      droppedByReset: boolean;
    }
  | { ok: false; reason: string };

/**
 * 応答が返らない場合に待ち続けない上限。
 *
 * fetch は既定でタイムアウトしないため、これが無いと syncEvent が解決せず、
 * 呼び出し元の persistEvent も待ち続ける。同期は質問フローを止めてはならない。
 */
const TIMEOUT_MS = 10_000;

/**
 * 送信先として安全なURLかどうか。
 *
 * apiBaseUrl には `Authorization: Bearer` を付けて送るため、平文の http: を許すと
 * トークンが盗聴されうる。https: を基本とし、ローカル開発（apps/api の
 * `npm run dev` は http://localhost:8787）だけ例外として認める。
 * apps/desktop の isSafeApiBaseUrl と同じ判断基準を用いる。
 * conversations/sync.ts など他の送信経路からも使うため export する。
 */
export function isSafeApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// 失敗の種類。呼び出し側へは `reasonOf` で理由の文にして返す。
/** 再ログインが必要（トークンが取れない、401）。 */
class NeedsLogin extends Data.TaggedError("NeedsLogin") {}
/** トークン取得の待機中に、送信の同意が取り消された。 */
class ConsentWithdrawn extends Data.TaggedError("ConsentWithdrawn") {}
/** 送信先が安全ではない（RULE-003）。トークンを載せる前に弾く。 */
class UnsafeApiBaseUrl extends Data.TaggedError("UnsafeApiBaseUrl")<{ url: string }> {}
/** 届かなかった・時間切れ・トークン取得の失敗。 */
class NetworkFailure extends Data.TaggedError("NetworkFailure")<{ cause: unknown }> {}
/** 2xx 以外が返った（401 を除く）。 */
class HttpFailure extends Data.TaggedError("HttpFailure")<{ status: number }> {}
/** 2xx だが本文が契約と違う。成功として扱わない（RULE-004）。 */
class MalformedResponse extends Data.TaggedError("MalformedResponse")<{ detail?: string }> {}

type RequestFailure =
  | NeedsLogin
  | ConsentWithdrawn
  | UnsafeApiBaseUrl
  | NetworkFailure
  | HttpFailure
  | MalformedResponse;

/** 失敗を、呼び出し側がログへ残す理由の文にする。 */
function reasonOf(failure: RequestFailure): string {
  switch (failure._tag) {
    case "NeedsLogin":
      return "再ログインが必要です";
    case "ConsentWithdrawn":
      return "送信の同意が取り消されました";
    case "UnsafeApiBaseUrl":
      return `APIのURLが安全ではありません（https、またはローカル開発のみ許可）: ${failure.url}`;
    case "NetworkFailure":
      return `ネットワークエラー: ${String(failure.cause)}`;
    case "HttpFailure":
      return `HTTP ${failure.status}`;
    case "MalformedResponse":
      return failure.detail === undefined
        ? "サーバー応答の形式が不正です"
        : `サーバー応答の形式が不正です（${failure.detail}）`;
  }
}

/**
 * トークンを付けて API を呼び、2xx の本文を JSON として返す。
 *
 * `canSend` はトークン取得の後、送信の直前に確認する。トークン取得中に同意が
 * 取り消されることがあり、取り消し後に Authorization ヘッダー付きで送らないため。
 */
const requestJson = Effect.fnUntraced(function* (
  config: Pick<SyncConfig, "apiBaseUrl" | "apiToken" | "canSend">,
  path: string,
  init: { method: string; body?: string },
): Effect.fn.Return<unknown, RequestFailure> {
  if (!isSafeApiBaseUrl(config.apiBaseUrl)) {
    // ワークスペース設定で書き換えられた不正なURLへ送ってしまうと、
    // トークンと学習イベントが第三者へ渡る。
    return yield* new UnsafeApiBaseUrl({ url: config.apiBaseUrl });
  }
  const url = `${config.apiBaseUrl.replace(/\/+$/, "")}${path}`;

  const apiToken = yield* Effect.tryPromise({
    try: () => config.apiToken(),
    catch: (cause) =>
      cause instanceof Error && cause.message === "再ログインが必要です"
        ? new NeedsLogin()
        : new NetworkFailure({ cause }),
  });
  if (!apiToken) return yield* new NeedsLogin();
  if (config.canSend && !config.canSend()) return yield* new ConsentWithdrawn();

  // 応答が返らない場合に待ち続けない（RULE-001）。期限は送信と本文の読み込みに掛け、
  // トークン取得には掛けない。
  //
  // `tryPromise` が渡す signal は fetch が応答を返した時点で役目を終え、そのあとの本文の
  // 読み込みを止められない。送信と本文の両方を止められるよう、自前の signal を渡す。
  const deadline = new AbortController();
  return yield* Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: init.method,
          headers: {
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            authorization: `Bearer ${apiToken}`,
          },
          body: init.body,
          // リダイレクトを自動追跡しない。転送先へ Authorization ヘッダごと
          // 送られると、トークンが意図しない相手に渡る（RULE-002）。
          redirect: "error",
          // 下の `timeoutOrElse` で中断されたら abort する。
          signal: deadline.signal,
        }),
      catch: (cause) => new NetworkFailure({ cause }),
    });
    if (!response.ok) {
      return yield* response.status === 401
        ? new NeedsLogin()
        : new HttpFailure({ status: response.status });
    }
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new MalformedResponse({ detail: "JSON ではありません" }),
    });
  }).pipe(
    // 期限で中断されたら、送信中の fetch も読み込み中の本文も止める。
    Effect.onInterrupt(() => Effect.sync(() => deadline.abort())),
    Effect.timeoutOrElse({
      duration: Duration.millis(TIMEOUT_MS),
      orElse: () =>
        Effect.fail(
          new NetworkFailure({ cause: `${String(TIMEOUT_MS)} ms 以内に応答がありませんでした` }),
        ),
    }),
  );
});

/**
 * Effect を、例外を投げない Promise にする（このファイル冒頭の約束）。
 *
 * 型付きの失敗は理由の文にする。想定外の例外（`canSend` や本文の組み立てが投げた、など）も
 * 「ネットワークエラー」として返す。書き直し前は関数全体を try/catch で包み、同じ扱いをしていた。
 */
function runToOutcome<A>(
  program: Effect.Effect<A, RequestFailure>,
): Promise<A | { ok: false; reason: string }> {
  return Effect.runPromise(
    program.pipe(
      Effect.catch((failure) => Effect.succeed({ ok: false as const, reason: reasonOf(failure) })),
      Effect.catchDefect((defect) =>
        Effect.succeed({ ok: false as const, reason: `ネットワークエラー: ${String(defect)}` }),
      ),
    ),
  );
}

/**
 * 1件の学習イベントをAPIサーバーへ送る。
 *
 * `POST /v1/learning-events:sync` は複数件をまとめて送れるバッチAPIだが、
 * persistEvent がイベントを1件ずつ確定させるのに合わせて、ここでも1件ずつ送る。
 * まとめ送りは、送信頻度が実際に問題になってから最適化する。
 */
export function syncEvent(event: LearningEvent, config: SyncConfig): Promise<SyncOutcome> {
  // 本文の組み立て（JSON.stringify）も Effect の内側で行い、投げても失敗として返す。
  const request = Effect.suspend(() =>
    requestJson(config, "/v1/learning-events:sync", {
      method: "POST",
      body: JSON.stringify({ clientId: config.clientId, events: [event] }),
    }),
  );
  return runToOutcome(
    request.pipe(
      Effect.flatMap((json) => {
        const body = json as Partial<SyncResponseBody> | null;
        if (!Array.isArray(body?.results)) {
          return Effect.fail(new MalformedResponse({ detail: "results が配列ではありません" }));
        }
        // あるのに数値でも null でもない値は、サーバー応答の形が契約と違うという
        // ことなので黙って無視しない（RULE-004）。フィールド自体が無い古い
        // サーバーとの後方互換だけは残す。
        const resetAt = body.historyResetAtMs;
        if (resetAt !== undefined && resetAt !== null && typeof resetAt !== "number") {
          return Effect.fail(
            new MalformedResponse({ detail: "historyResetAtMs が数値ではありません" }),
          );
        }
        const result = body.results[0];
        if (!result) {
          // 件数が合わない応答はサーバー側のバグである。黙って「成功」扱いにしない。
          return Effect.fail(
            new MalformedResponse({ detail: "このイベントの結果が含まれていません" }),
          );
        }
        return Effect.succeed<SyncOutcome>({
          ok: true,
          status: result.status,
          reason: result.reason,
          historyResetAtMs: resetAt ?? null,
          droppedByReset: result.droppedByReset === true,
        });
      }),
    ),
  );
}

/** `DELETE /v1/learning-events` の応答（apps/api/src/routes/learning-data.ts の DeleteLearningEventsResponse と対応）。 */
interface DeleteResponseBody {
  deletedCount: number;
  /** `learning_history_resets` へ記録された削除時刻（epoch ミリ秒）。 */
  resetAtMs: number;
}

export type DeleteOutcome =
  { ok: true; deletedCount: number; resetAtMs: number } | { ok: false; reason: string };

/**
 * サーバー側の学習イベントを全件削除する（Issue #124）。
 *
 * `syncEvent` と同じく例外を投げず、失敗は理由付きの `ok: false` で返す。
 * 呼び出し側は `ok: true` の場合だけローカルのコピーを消す。順序をこの向きに
 * するのは、サーバー側の削除が失敗したときに手元だけ消えて
 * 「消えたように見える」状態を作らないためである（docs/data-privacy.md
 * 「クライアント側に残るコピー」）。
 */
export function deleteServerLearningData(
  config: Pick<SyncConfig, "apiBaseUrl" | "apiToken">,
): Promise<DeleteOutcome> {
  return runToOutcome(
    requestJson(config, "/v1/learning-events", { method: "DELETE" }).pipe(
      Effect.flatMap((json) => {
        const body = json as Partial<DeleteResponseBody> | null;
        if (typeof body?.deletedCount !== "number" || typeof body?.resetAtMs !== "number") {
          return Effect.fail(new MalformedResponse({}));
        }
        return Effect.succeed<DeleteOutcome>({
          ok: true,
          deletedCount: body.deletedCount,
          resetAtMs: body.resetAtMs,
        });
      }),
    ),
  );
}

export type UserConceptsOutcome = { ok: true; value: UserConcepts } | { ok: false; reason: string };

/**
 * 利用者が手で作った学習マップのノードを読む（`GET /v1/learning-maps:concepts`、Issue #242）。
 *
 * サーバーは更新の新しいマップから合計 100 ノードまで返す（プロンプトの長さを抑えるため）。
 * 学習データを送る経路ではないので、送信の同意は見ない（ログインは要る）。
 * `syncEvent` と同じく例外を投げず、失敗は理由付きの `ok: false` で返す。
 */
export function fetchUserConcepts(
  config: Pick<SyncConfig, "apiBaseUrl" | "apiToken">,
): Promise<UserConceptsOutcome> {
  return runToOutcome(
    requestJson(config, "/v1/learning-maps:concepts", { method: "GET" }).pipe(
      Effect.flatMap((json) => {
        const value = toUserConcepts(json);
        return value === undefined
          ? Effect.fail(new MalformedResponse({ detail: "concepts の形が契約と違います" }))
          : Effect.succeed<UserConceptsOutcome>({ ok: true, value });
      }),
    ),
  );
}
