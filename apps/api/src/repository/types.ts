/**
 * 永続化の境界。
 *
 * ルートハンドラは D1 を直接触らず、この interface だけに依存する。
 * `test:unit` は素の vitest であり `@cloudflare/vitest-pool-workers` ではないため、
 * この継ぎ目が無いとハンドラのテストに Worker ランタイムが要る。
 *
 * SQL とドメインの変換もここへ閉じ込める。イベントの `conceptIds` は D1 上では
 * JSON 文字列、発生時刻は文字列と数値の2列という表現になっているが、
 * この境界の外へその都合を漏らさない。
 */

import type { LearningEvent } from "@gakushu-sochi/domain";
import type {
  HistoryProviderId,
  LearningEvidence,
  MasteryStatus,
  UnmappedCandidate,
} from "@gakushu-sochi/domain";
import type { UserSettings, UserSettingsInput } from "../contract/user-settings.js";
import type { ImportSessionView } from "../contract/history-import.js";

/** 退会済みの sub を、発行済みアクセストークンの寿命を超えて再利用可能にする期間。 */
export const ACCOUNT_DELETION_TOMBSTONE_TTL_MS = 60 * 60 * 1_000;

/** 保存するイベント。検証済みの `LearningEvent` に、サーバー側が付与する情報を足したもの。 */
export interface StoredEventInput {
  event: LearningEvent;
  /** 送信元の端末。重複の急増を診断するときに送信元を辿るために持つ。 */
  clientId: string;
  /** サーバーが受理した時刻（epoch ミリ秒）。オフラインキューの遅延を測る。 */
  receivedAtMs: number;
}

/**
 * イベント1件の保存結果。
 *
 * `duplicate` は「**このユーザーが**同じ ID を既に送っていた」を意味する。
 * イベント ID はクライアント生成でグローバルには一意でないため、
 * 他ユーザーの同じ文字列と衝突して重複扱いになってはならない。
 * 実装はユーザー単位の主キーでこれを保証する。
 */
export interface AppendResult {
  id: string;
  duplicate: boolean;
  /**
   * 履歴の削除時刻（`learning_history_resets`）以前に受け取ったため、
   * 受理したが書かなかったイベントなら true。
   *
   * 「受理」には「保存した」と「削除に含まれた」の2通りがある。
   * クライアントはこの区別で、削除への追従後にそのイベントをローカルへ
   * 記録し直すかを決める（Issue #124）。区別が無いと、サーバーが境界の
   * 内側に倒したイベントがローカルにだけ復活する。
   */
  droppedByReset: boolean;
}

/**
 * ユーザーと端末の登録。
 *
 * `learning_events.user_id` は `users(id)` を参照しており、D1 は外部キーを
 * 実際に強制する（`PRAGMA foreign_keys` が 1）。そのため認証で userId が
 * 決まっただけでは書き込めず、イベントを追記する前に行の存在を保証する必要がある。
 * これが無いと同期は必ず FOREIGN KEY constraint failed で落ちる。
 */
export interface IdentityRepository {
  /** ユーザー行を用意する。既にあれば何もしない。 */
  ensureUser(params: { userId: string; nowMs: number }): Promise<void>;

  /**
   * ユーザーと端末の行を用意する。既にあれば何もしない。
   *
   * 端末の `lastSeenAtMs` だけは毎回更新する。最後に同期した時刻は
   * 端末ごとに変わり続ける値であり、初回登録時の値を残しても意味を持たないため。
   */
  ensureUserAndDevice(params: { userId: string; clientId: string; nowMs: number }): Promise<void>;

  /**
   * 退会中であることを永続化する。以後の書き込み経路はこの状態を見て拒否する。
   * マーカーは Auth0 側の削除が失敗しても再実行できるよう残し、
   * 発行済みアクセストークンの寿命を超えたら再登録を許可する。
   */
  startUserDeletion(userId: string, startedAtMs: number): Promise<void>;

  /**
   * ユーザーと、それにぶら下がる全データを消す（退会）。
   *
   * `learning_events` と `devices` は `users(id)` を `ON DELETE CASCADE` で
   * 参照しているため、`users` の1行を消せば両方が消える。
   *
   * 行が無くても成功とする。退会の再実行（Auth0 側の削除だけが失敗した場合）で
   * 呼ばれうるため、存在しないことを失敗にすると復旧の手順が塞がる。
   */
  deleteUser(userId: string): Promise<void>;
}

export interface LearningEventRepository {
  /**
   * イベントを冪等に追記する。
   *
   * 同じ ID が同一ユーザーに既に存在する場合、既存行を上書きせず
   * `duplicate: true` を返す。追記のみで、あとから書き換えないため
   * （docs/architecture.md）、後着の再送で内容が変わることは無い。
   *
   * `receivedAtMs` が履歴の削除時刻（`deleteByUser`）以前のイベントは書かず、
   * `duplicate: false`（受理）を返す。削除より前に受け取ったイベントであり、
   * 受理したうえで削除に含まれた、という扱いになる。
   *
   * @returns 入力と同じ順序の結果。
   */
  append(userId: string, inputs: readonly StoredEventInput[]): Promise<AppendResult[]>;

  /**
   * 1ユーザーの全イベントを発生時刻順で読む。
   *
   * 並び順は packages/domain の畳み込み順（発生時刻の昇順、同時刻は ID の昇順）と
   * 一致させる。`deriveMasteryFromEvents` は与えられた順に依存しないが、
   * SQL 側で同じ順序を保つことで、将来ページングを入れても導出結果が変わらない。
   */
  listByUser(userId: string): Promise<LearningEvent[]>;

  /** 1ユーザーのイベント総件数。Profile レスポンスの `eventCount` に使う。 */
  countByUser(userId: string): Promise<number>;

  /**
   * 1ユーザーの全イベントを消す（学習履歴の削除。退会ではない）。
   *
   * `users` / `devices` の行は残す。アカウントを保持したまま履歴だけを消す経路であり、
   * 行ごと消すのは退会（`IdentityRepository.deleteUser`）の責務である。
   * 習熟度は保存値を持たずイベントから導出するため、これだけで習熟度も消える。
   *
   * **並行する同期との競合を塞ぐため、削除した時刻も記録する。** 以後の `append` は
   * `receivedAtMs` がこの時刻以前のイベントを書かない。これが無いと、削除より前に
   * 受け取った同期リクエストの INSERT が DELETE の後に実行され、消したはずの履歴が残る。
   * 呼び出し前に `users` 行が存在している必要がある（D1 では外部キーで参照する）。
   *
   * @param resetAtMs 削除した時刻（epoch ミリ秒）。
   * @returns 消した件数。0件でも成功とする（再実行で失敗させない）。
   */
  deleteByUser(userId: string, resetAtMs: number): Promise<number>;

  /**
   * 最後に学習履歴を削除した時刻（epoch ミリ秒）。削除されていなければ `null`。
   *
   * 同期応答へ載せて、削除を呼んでいない他端末へ伝えるために使う（Issue #124）。
   */
  latestResetAtMs(userId: string): Promise<number | null>;
}

/**
 * 外部履歴から取り込んだ Evidence の永続化（Issue #157）。
 *
 * `LearningEventRepository` とは別の表にする。LearningEvent は「実際の
 * 学習行動」の正本であり、外部履歴の「触れた形跡」と同じ意味で混ぜると、
 * 習熟度の導出が外部履歴の量に引きずられる（docs/concepts.md）。
 */
export interface LearningEvidenceRepository {
  /** 1ユーザーの全 Evidence を読む。Familiarity の導出と出典表示に使う。 */
  listByUser(userId: string): Promise<LearningEvidence[]>;

  /** 1つの Import Session に属する Evidence を読む（詳細表示・Undo の確認）。 */
  listBySession(userId: string, sessionId: string): Promise<LearningEvidence[]>;

  /**
   * 指定した履歴ソース由来の Evidence を全件消す（ソース管理の削除）。
   *
   * 消した結果、Evidence が残らなくなった Session は `undone` に倒す。
   * @returns 消した件数と、undone に倒した Session の件数。
   */
  deleteByProvider(
    userId: string,
    provider: HistoryProviderId,
    updatedAt: string,
  ): Promise<{ deletedCount: number; sessionsMarkedUndone: number }>;

  /**
   * 1ユーザーの全 Evidence を消す（学習履歴の削除に追随）。
   * @returns 消した件数。0件でも成功とする。
   */
  deleteAllByUser(userId: string): Promise<number>;
}

/** `POST /v1/import-sessions` が保存する Session の入力。 */
export interface StoredImportSessionInput {
  id: string;
  importedBy: string;
  providers: readonly string[];
  conversationCount: number;
  ignoredCount: number;
  unmappedCandidates: readonly UnmappedCandidate[];
  evidenceCount: number;
  conceptCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Import Session の永続化（Issue #157）。
 *
 * Session と Evidence の作成を1つの操作にまとめる。別々にすると、
 * Session だけが残る「中身の無い Import」か、Session の無い Evidence が
 * 書ける中途半端な状態を作りうる。
 */
export interface ImportSessionRepository {
  /**
   * Session と Evidence を1トランザクションで作る。
   *
   * 同じ `id` の Session が既にある場合は何も書かず `alreadyExisted: true`
   * を返す（再送の正常系）。Evidence も `(user_id, id)` で冪等にする。
   */
  createWithEvidence(
    userId: string,
    session: StoredImportSessionInput,
    evidence: readonly LearningEvidence[],
  ): Promise<{ alreadyExisted: boolean }>;

  /** 1ユーザーの Session を新しい順に列挙する。 */
  listByUser(userId: string): Promise<ImportSessionView[]>;

  /** Session 1件と、その Evidence。無ければ `null`。 */
  getById(
    userId: string,
    id: string,
  ): Promise<{ session: ImportSessionView; unmappedCandidates: UnmappedCandidate[] } | null>;

  /**
   * `applied` の Session を `undone` にし、その Evidence を消す（Undo）。
   *
   * @returns 現在の状態。消した Evidence の件数は `deletedEvidenceCount`。
   *   既に undone なら `deletedEvidenceCount: 0` で `undone` を返す。
   *   undone へ遷移できない状態（scanning 等）でも現在の status を
   *   `deletedEvidenceCount: 0` とともに返し、呼び出し側が 409 を判断する。
   *   `null` は Session が無い場合に限る（呼び出し側が 404 にする）。
   */
  undo(
    userId: string,
    sessionId: string,
    updatedAt: string,
  ): Promise<{ status: string; deletedEvidenceCount: number } | null>;

  /** 1ユーザーの全 Session を消す（学習履歴の削除に追随）。消した件数を返す。 */
  deleteAllByUser(userId: string): Promise<number>;
}

export interface MasteryOverride {
  status: MasteryStatus;
  updatedAt: string;
}

export interface MasteryOverrideRepository {
  listByUser(userId: string): Promise<Record<string, MasteryOverride>>;
  put(
    userId: string,
    conceptId: string,
    status: MasteryStatus | null,
    updatedAt: string,
  ): Promise<Record<string, MasteryOverride>>;
}

/**
 * ユーザー設定の永続化。
 *
 * 1ユーザー1件の上書きなので、`append` ではなく `put` だけを持つ。
 * 未保存のユーザーに対して `get` は `null` を返す。既定値へ丸めるのは
 * ここではなく呼び出し側の責務にする。この境界で既定値を混ぜると、
 * 「まだ保存していない」と「既定値と同じ値を保存した」の区別が消える。
 */
export interface UserSettingsRepository {
  get(userId: string): Promise<UserSettings | null>;
  put(userId: string, input: UserSettingsInput, updatedAt: string): Promise<UserSettings>;
}

/**
 * Managed AI の利用量（Issue #89 / Auth/10）。
 *
 * 期間ごとの集計だけを持ち、リクエスト1件ごとの履歴は持たない。
 * `selection` や `question` はここへ入らない。AGENTS.md のとおり、
 * コード本文・質問本文・AI回答全文は明示的な同意なしに長期保存しない。
 */
export interface AiUsage {
  /** 当月（UTC 暦月）の累計リクエスト数。 */
  monthlyRequests: number;
  /** 今日（UTC）の累計リクエスト数。日が変わっていれば 0。 */
  dailyRequests: number;
  /** 当月（UTC 暦月）の累計トークン数（入力 + 出力）。利用者へは見せない安全弁。 */
  monthlyTokens: number;
}

export interface AiUsageRepository {
  /**
   * 指定した月・日の利用量を読む。記録が無ければ全て 0 を返す。
   *
   * 月が変われば `monthlyRequests` と `monthlyTokens` は 0 から、
   * 日が変われば `dailyRequests` だけが 0 から数え直される。
   * 期間の切り替わりを呼び出し側に判断させないため、キーは引数で受け取る。
   */
  get(params: { userId: string; monthKey: string; dayKey: string }): Promise<AiUsage>;

  /**
   * 上限に収まるときだけ回数を1つ増やす（枠の確保）。
   *
   * **回数はリクエストを上流へ流す前に増やす。** ストリームの完了を待って
   * から数えると、応答を読み切らずに切断する呼び出しを繰り返すだけで
   * 上限を素通りできる。トークン数は実消費が分かってから（`addTokens`）足す。
   *
   * **判定と加算を1つの操作にまとめる。** 読んでから別の文で足すと、同じ
   * 利用者の同時リクエストがその隙間に割り込み、**上限を超えて弾いた分まで
   * 枠を消費する**。15回の枠へ30回同時に来たとき、通るのは15回なのに
   * 月次からは30回引かれる、という取りこぼしが起きる。
   *
   * @returns 確保できたら `reserved: true` と加算後の値。上限に達していれば
   *   `reserved: false` と、**加算していない**現在値。どの上限で止まったかは
   *   呼び出し側がその値から決める。
   */
  reserve(params: {
    userId: string;
    monthKey: string;
    dayKey: string;
    updatedAt: string;
    limits: { dailyRequests: number; monthlyRequests: number };
  }): Promise<{ reserved: boolean; usage: AiUsage }>;

  /**
   * 実消費したトークン数を当月へ足す。
   *
   * 上流の `usageMetadata` は応答を読み切って初めて分かるため、
   * `increment` とは別の呼び出しになる。取れなかった場合に 0 を足して
   * 済ませない（RULE-004）。呼び出し側が見積もりを足すか、失敗を記録する。
   */
  addTokens(params: {
    userId: string;
    monthKey: string;
    dayKey: string;
    tokens: number;
    updatedAt: string;
  }): Promise<void>;
}

/**
 * 監査ログへ記録する操作（Issue #122）。
 *
 * 対象は利用者の不可逆な操作だけにする。学習イベント本体は `learning_events` が
 * 正本なので二重に持たない。対象の増減は docs/architecture.md の
 * 「監視・監査ログ・障害時の再送」と一緒に変える。
 */
export type AuditAction =
  | "learning_events.exported"
  | "learning_events.deleted"
  | "learning_evidence.exported"
  | "learning_evidence.deleted";

/** 監査ログの1件。 */
export interface AuditLogEntry {
  /** 誰が。認証済みの userId（Auth0 の sub）。 */
  userId: string;
  /** 何をしたか。 */
  action: AuditAction;
  /** いつ。サーバーが処理した時刻（epoch ミリ秒）。 */
  occurredAtMs: number;
  /** 操作の補足（消した件数など）。JSON 化して保存する。 */
  detail?: Record<string, unknown>;
}

/**
 * 監査ログの永続化（Issue #122）。
 *
 * 追記のみで、あとから書き換えない。読み出す経路は持たない。
 * 運用者が D1 を直接クエリして読む（`wrangler d1 execute`）。
 */
export interface AuditLogRepository {
  /**
   * 操作を1件記録する。
   *
   * `user_id` は users(id) を参照するため、呼び出し前にユーザー行が必要。
   * 退会すると users 行と一緒に消える（ON DELETE CASCADE）。
   */
  record(entry: AuditLogEntry): Promise<void>;
}
