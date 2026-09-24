/**
 * `POST /v1/learning-events:sync` の外部契約。
 *
 * docs/architecture.md の通り、これは「イベントを一件作る」CRUD API ではなく、
 * オフラインキューを同期するためのプロトコルである。リクエストは複数イベントを含み、
 * レスポンスはイベントごとに受理・重複・拒否を返す。
 *
 * 契約はこのアプリに置く（apps/api/AGENTS.md）。packages/domain の型は利用してよいが、
 * この型を他パッケージから参照させない。
 */

import * as v from "valibot";
import { CONCEPT_ID_PATTERN, isIsoDateTime, type LearningEvent } from "@gakushu-sochi/domain";

/**
 * 受け入れるイベント種別。packages/domain の `LearningEventType` と一致させる。
 *
 * ここで種別を明示的に列挙するのは、HTTP 境界を通る値を閉じた許可リストで
 * 受けるためである。下の型検査により、domain 側に種別が増えたときは
 * この配列を更新しない限りコンパイルが通らない。
 */
const EVENT_TYPES = [
  "question_asked",
  "hint_used",
  "answer_viewed",
  "solved_independently",
  "error_recurred",
  "check_passed",
  "check_failed",
] as const;

/** 受け入れる観測元。packages/domain の `EventOrigin` と一致させる。 */
const EVENT_ORIGINS = ["vscode", "github", "web", "cli"] as const;

/**
 * 列挙が domain の型と過不足なく一致していることをコンパイル時に検査する。
 *
 * 両方向を見る必要がある。配列を `readonly T[]` へ代入するだけでは
 * 「domain にあるが列挙に無い」値を検出できず、種別が追加されたときに
 * API が黙って受け付けなくなる。逆に `Exclude` だけでは domain が知らない値を
 * API が受けてしまう状態を検出できない。
 *
 * 差集合が両方向とも `never` であることを要求し、どちらかにズレた時点で
 * 型エラーにする。
 */
function assertNever<T extends never>(): void {
  void 0 as T | void;
}

assertNever<Exclude<LearningEvent["type"], (typeof EVENT_TYPES)[number]>>();
assertNever<Exclude<(typeof EVENT_TYPES)[number], LearningEvent["type"]>>();
assertNever<Exclude<LearningEvent["origin"], (typeof EVENT_ORIGINS)[number]>>();
assertNever<Exclude<(typeof EVENT_ORIGINS)[number], LearningEvent["origin"]>>();

/** ID の最大長。際限なく長い ID を DB の主キーへ入れないための上限。 */
const MAX_ID_LENGTH = 128;

/** 1リクエストで受け付けるイベントの最大件数。 */
export const MAX_EVENTS_PER_SYNC = 500;

/**
 * `occurredAt` の検査。ISO 8601 として解釈できることを要求する。
 *
 * 形式だけでなく実際にパースできることまで見るのは、習熟度の導出
 * （`deriveMasteryFromEvents`）が解釈不能な値に対して例外を投げるためである。
 * 導出は読み取りパスでも動くので、ここを通してしまうと `GET /v1/learning-profile`
 * が永続的に 500 になり、ユーザー側に回復手段が無くなる。
 * docs/concepts.md「サーバー側の導出」を参照。
 */
const occurredAtSchema = v.pipe(
  v.string(),
  v.minLength(1, "occurredAt is required"),
  // 検査は packages/domain の isIsoDateTime に委ねる。ここで独自に書くと、
  // API が受理した値を導出側が拒否する（あるいはその逆の）状態を作りうる。
  v.check(isIsoDateTime, "occurredAt must be an ISO 8601 date-time with a UTC or numeric offset"),
);

const conceptIdSchema = v.pipe(
  v.string(),
  v.regex(CONCEPT_ID_PATTERN, "conceptId must match <language>.<concept>"),
);

/**
 * 1件の学習イベント。
 *
 * `v.object` ではなく `v.strictObject` を使う。未知のキーを黙って捨てるのではなく
 * 拒否するためである。`LearningEvent` にはコード本文・質問文・AI回答を置く場所が無く
 * （docs/architecture.md のプライバシー二段階の方針）、クライアントがそれらを
 * 送ってきた場合は受理せずに理由を返す必要がある。剥がして受理すると、送信側は
 * 保存されたと誤解したまま気づけない。
 */
export const learningEventSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LENGTH)),
  occurredAt: occurredAtSchema,
  type: v.picklist(EVENT_TYPES),
  origin: v.picklist(EVENT_ORIGINS),
  conceptIds: v.array(conceptIdSchema),
  language: v.optional(v.pipe(v.string(), v.maxLength(64))),
  diagnosticCode: v.optional(v.pipe(v.string(), v.maxLength(128))),
  sessionId: v.optional(v.pipe(v.string(), v.maxLength(MAX_ID_LENGTH))),
});

/**
 * 同期リクエストのエンベロープ。
 *
 * `events` の要素は意図的に `v.unknown()` にしてある。エンベロープ全体を1つの
 * スキーマで検証すると、1件の不正なイベントでリクエスト全体が失敗し、
 * 同じバッチに含まれる正常なイベントまで捨ててしまう。オフラインキューの同期では
 * それは受け入れられない。各要素は `learningEventSchema` で個別に検証し、
 * 拒否の理由をイベントごとに返す。
 */
export const syncRequestSchema = v.strictObject({
  clientId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LENGTH)),
  events: v.pipe(v.array(v.unknown()), v.maxLength(MAX_EVENTS_PER_SYNC)),
});

export type SyncRequest = v.InferOutput<typeof syncRequestSchema>;

/**
 * イベント1件の処理結果。
 *
 * - `accepted`: 新規に保存した
 * - `duplicate`: 同じ ID が既に存在したため保存しなかった（再送の正常系）
 * - `rejected`: 検証に失敗した。`reason` に理由が入る
 *
 * `duplicate` を `accepted` と区別するのは、クライアントが送信キューから
 * 安全に取り除ける点では同じでも、両者の件数が食い違うこと自体が
 * 再送の実態を示す診断情報になるためである。
 */
export type SyncResultStatus = "accepted" | "duplicate" | "rejected";

export interface SyncEventResult {
  /**
   * リクエストの `events` 配列における位置。
   *
   * ID だけでは対応づけられない。ID 自体が不正で読めなかったイベントは
   * `id` が `null` になり、クライアントは自分の送信キューのどの項目が
   * 拒否されたのか分からなくなる。位置を返せば、ID が読めなくても
   * 送信元を特定して取り除ける。
   */
  index: number;
  /** 対象イベントの ID。ID 自体が不正で読めなかった場合は `null`。 */
  id: string | null;
  status: SyncResultStatus;
  /** `rejected` のときだけ入る、人が読める拒否理由。 */
  reason?: string;
}

export interface SyncResponse {
  /**
   * イベントごとの結果。リクエストの `events` と同じ順序・同じ件数で返す。
   * 各要素の `index` が対応する位置を示す。
   */
  results: SyncEventResult[];
  /** 件数の内訳。クライアントがログへ残す際に results を数え直さずに済む。 */
  summary: Record<SyncResultStatus, number>;
  /**
   * このユーザーの学習履歴が最後に削除された時刻（epoch ミリ秒）。
   * 削除されたことが無ければ `null`。
   *
   * `DELETE /v1/learning-events` は呼んだ端末のローカルコピーしか消せない。
   * 他の端末はこの値を前回同期時のものと比較し、新しければローカルに残る
   * コピーを消すことで削除へ追従する（Issue #124）。
   * `learning_history_resets` に記録された値そのものであり、
   * 削除を知らせるためだけの追加の履歴は持たない。
   */
  historyResetAtMs: number | null;
}
