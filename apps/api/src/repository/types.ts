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

import type {
  CheckLevel,
  ConceptCheck,
  ConsentRecord,
  Conversation,
  HistoryProviderId,
  LearningEvent,
  LearningEvidence,
  MasteryStatus,
  PersonalConceptCheck,
  UnmappedCandidate,
} from "@gakushu-sochi/domain";
import type { Plan } from "../contract/ai-usage.js";
import type { AreaCompletion } from "../contract/area-completions.js";
import type { ConversationSummary } from "../contract/conversations.js";
import type {
  LearningMapSummary,
  LearningMapVisibility,
  MapVersionMeta,
  MapVersionSummary,
  SharedMapSummary,
  ShareScope,
  LearningObjectiveSource,
} from "../contract/learning-maps.js";
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
 * 分野コンプリートの記録（migrations/0007_area_completions.sql）。
 *
 * 件数ではなく「どの分野をいつ達成したか」を持つ。件数は行数として数える。
 * 達成は追記だけで、取り消す操作は無い。
 */
export interface AreaCompletionRepository {
  /** 達成順（古い順）に返す。 */
  listByUser(userId: string): Promise<AreaCompletion[]>;

  /**
   * まだ記録の無い分野だけを追記する。既にある分野は**書き換えない**。
   * 再実行しても件数が増えず、最初の達成時刻が後の時刻で上書きされない。
   */
  record(userId: string, languages: readonly string[], completedAt: string): Promise<void>;
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
  /**
   * 設定を保存する。省略された項目は保存済みの値を維持する。
   *
   * 「省略=現状維持」の解決は呼び出し側（ルート）ではなくここで行う。
   * 読み取り→マージ→書き込みを分けると、その間に別端末が保存した値を
   * 古い値で上書きしてしまう。提供された項目だけを書く1文の upsert で
   * 実装し、項目ごとの更新を不可分にする。
   */
  put(userId: string, input: UserSettingsInput, updatedAt: string): Promise<UserSettings>;
}

/** `GET /v1/conversations` の一覧読み出し条件。 */
export interface ConversationListParams {
  /**
   * 読み取る件数。次頁の有無を判定するため、呼び出し側は
   * 表示したい件数 + 1 で要求する。
   */
  limit: number;
  /**
   * この行より後ろ（一覧では下）だけを読むカーソル。
   * 並び順は更新時刻の降順・同時刻は ID の昇順で固定する。
   */
  cursor?: { updatedAtMs: number; id: string };
}

/**
 * 会話履歴の永続化（Issue #204）。
 *
 * LearningEvent とは別の表にする。本文を持つデータであり、習熟度の
 * 導出には一切関与しない。設計の正本は docs/conversation-history.md。
 */
export interface ConversationRepository {
  /**
   * 会話を upsert する。
   *
   * 同じ `(userId, id)` の行があり、既存の `updatedAt` が届いた会話より
   * 新しい場合は書き換えず `{ saved: false }` を返す。遅延した再送や
   * 古いスナップショットで新しい履歴が巻き戻るのを防ぐ。
   * 呼び出し前に `users` 行が存在している必要がある（外部キー）。
   */
  upsert(
    userId: string,
    conversation: Conversation,
    receivedAtMs: number,
  ): Promise<{ saved: boolean }>;

  /**
   * 一覧用の要約を更新時刻の降順（同時刻は ID の昇順）で読む。
   * 本文（`messages`）は返さない。
   */
  listByUser(userId: string, params: ConversationListParams): Promise<ConversationSummary[]>;

  /** 会話1件。本文込み。無ければ `null`。 */
  getById(userId: string, id: string): Promise<Conversation | null>;

  /**
   * 会話1件を消す。
   * @returns 消した件数（0 か 1）。対象が無くても成功とする。
   */
  deleteById(userId: string, id: string): Promise<number>;

  /**
   * 1ユーザーの全会話を消す（履歴の全件削除・学習履歴の削除への追随）。
   * @returns 消した件数。0件でも成功とする。
   */
  deleteAllByUser(userId: string): Promise<number>;

  /** エクスポート用。全会話を本文込み・更新時刻の降順で返す。 */
  listAllByUser(userId: string): Promise<Conversation[]>;
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
   * `amount` は確保する回数（省略は 1）。マップの生成（#243）は内部の呼び出しの数に
   * かかわらず 5 回分をまとめて確保する。**全部が枠に収まるときだけ**足し、一部だけは足さない。
   *
   * @returns 確保できたら `reserved: true` と加算後の値。枠が足りなければ
   *   `reserved: false` と、**加算していない**現在値。どの上限で止まったかは
   *   呼び出し側がその値から決める。
   */
  reserve(params: {
    userId: string;
    monthKey: string;
    dayKey: string;
    updatedAt: string;
    limits: { dailyRequests: number; monthlyRequests: number };
    amount?: number;
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
 * 利用者のプラン（#289、migrations/0016_user_plans.sql）。
 *
 * **読むだけ。** プランは課金が無いあいだ手で入れる。変える口を作ると、利用者が自分を
 * plus にできてしまう。
 */
export interface UserPlanRepository {
  /** 行が無ければ free。 */
  get(userId: string): Promise<Plan>;
}

/**
 * 言語別マップの作成者（#245 の決定 N4、migrations/0018_fixed_map_creators.sql）。
 *
 * **読むだけ。** 作成者は手で SQL を流して入れる。変える口を作ると、誰でも自分を作成者にできてしまう。
 */
export interface FixedMapCreatorRepository {
  /** その言語のマップの作成者か。 */
  isCreator(language: string, userId: string): Promise<boolean>;
  /** 作成者になっている言語（昇順）。 */
  languagesOf(userId: string): Promise<string[]>;
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
  | "learning_evidence.deleted"
  | "conversations.exported"
  | "conversations.deleted"
  | "concept_checks.exported"
  /** 言語別マップの作成者が、固定の Concept の「理解すること」を置き換えた（#245）。全利用者に効く。 */
  | "fixed_objectives.replaced";

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

/**
 * 保存した確認問題1組（migrations/0009_concept_checks.sql、Issue #185）。
 *
 * **個人データではない。** 生成の入力は Concept の定義だけなので、全利用者で共有する。
 * そのため `userId` を持たず、退会・学習データの削除・エクスポートの対象に含めない。
 */
export interface StoredConceptCheck {
  check: ConceptCheck & { model: string; generatedAt: string };
  /** 受理側の規則の版。`checks/cache.ts` の `CHECK_FORMAT_VERSION` と突き合わせる。 */
  formatVersion: number;
  /** 生成に使ったプロンプトの SHA-256（16進）。Concept の定義が変われば変わる。 */
  promptSha256: string;
}

/**
 * 確認問題の保存（Issue #185）。1 Concept 1組で、同じ Concept への `put` は上書きする。
 *
 * #236 で生成の口は利用者ごとの保存（{@link PersonalCheckRepository}）へ切り替わり、
 * 今は使っていない。公開用の共通問題（#237）のために残している。
 *
 * 作り直すかどうかの判定はここでは行わない。読み出した版とハッシュを見て
 * 呼び出し側（`routes/checks.ts`）が決める。
 */
export interface ConceptCheckRepository {
  /** 保存済みの1組。無ければ `null`。保存内容が読めなければ例外にする（RULE-004）。 */
  get(conceptId: string): Promise<StoredConceptCheck | null>;
  put(stored: StoredConceptCheck): Promise<void>;
}

/**
 * 利用者ごとの確認問題（migrations/0012_user_concept_checks.sql、Issue #236）。
 *
 * 個人の学習データである。1人・1 Concept・1つの狙い（`checkTargetOf`）につき1組を持ち、
 * 同じ狙いへの `put` は上書きする（「作り直す」）。
 * 呼び出し前に `users` 行が存在している必要がある（外部キー）。
 */
/**
 * 確認問題の組をいつ作ったか（#247、migrations/0015_map_creation_checks.sql）。
 *
 * - `map_creation`: マップを AI で作るときに、マップの定義だけから作った。個人のデータを含まない。
 * - `on_demand`: 解くときに作った。本人の質問を材料にしうる。
 */
export type CheckOrigin = "on_demand" | "map_creation";

export interface PersonalCheckRepository {
  /** その Concept で保存済みの組。生成時刻の新しい順。無ければ空配列。 */
  listByConcept(userId: string, conceptId: string): Promise<PersonalConceptCheck[]>;
  /**
   * 1組を保存する（同じ狙いは上書き）。
   *
   * **生成を始めた時刻（`startedAtMs`）が学習データの削除時刻（`learning_history_resets`）
   * 以前なら書かず、`saved: false` を返す。** 生成は上流を待つ間に削除が終わりうる。
   * 削除前の履歴から作った問題を後から書くと、消したはずのデータが戻る。
   * 判定と書き込みは同じ文で行う（`LearningEventRepository.append` と同じ）。
   *
   * `mapId` を渡したとき（手で作ったマップのノードの問題、#242）は、自分のそのマップに
   * 参照ではないそのノードがあり、狙った項目もまだあるときだけ書く。無ければ
   * `reason: "target-removed"` を返す。生成の間にマップ・ノード・項目が消されたら、
   * 消したものの問題を後から書き戻さないため。
   * `mapId` を渡さずに項目を狙った組（固定の Concept の項目、#245）も、その項目が
   * 固定の項目（`map_id` が NULL）としてまだあるときだけ書く。作成者が確定で消した項目の問題を
   * 書き戻さないため。
   *
   * `origin` はその組をいつ作ったか（#247）。省略は `on_demand`。同じ狙いを作り直すと
   * 書いた側の値で上書きされる（作成時の組を解くときに作り直せば `on_demand` に戻る）。
   */
  put(
    userId: string,
    check: PersonalConceptCheck,
    startedAtMs: number,
    target?: { mapId: string; origin?: CheckOrigin },
  ): Promise<{ saved: true } | { saved: false; reason: "reset" | "target-removed" }>;
  /**
   * マップを作るときに作った組（`origin = map_creation`）だけ。Concept ID・狙いの順。
   * 共有の側へ上げられるのはこれだけ（#247。上げる処理は #244）。
   */
  listMapCreationChecks(userId: string): Promise<PersonalConceptCheck[]>;
  /** エクスポート用。全件を Concept ID・狙いの順で返す。 */
  listAllByUser(userId: string): Promise<PersonalConceptCheck[]>;
  /**
   * 1ユーザーの全件を消す（学習データの削除への追随）。
   * @returns 消した件数。0件でも成功とする。
   */
  deleteAllByUser(userId: string): Promise<number>;
}

/**
 * 確認問題の生成への同意のうち「今後表示しない」の記録（Issue #236）。
 *
 * 版の判定はここでは行わない。読み出した版を呼び出し側が
 * `CHECK_GENERATION_CONSENT_VERSION` と突き合わせる。
 */
export interface CheckGenerationConsentRepository {
  get(userId: string): Promise<ConsentRecord | null>;
  /** 呼び出し前に `users` 行が存在している必要がある（外部キー）。 */
  put(userId: string, record: ConsentRecord): Promise<void>;
  /** 記録を消す（取り消し）。無くても成功とする。 */
  delete(userId: string): Promise<void>;
}

/** 保存するマップのノード（migrations/0013_learning_maps.sql）。 */
export type StoredMapNode =
  | { kind: "own"; conceptId: string; label: string; summary: string }
  | { kind: "reference"; conceptId: string };

/** 保存するマップの中身。ノードは学習の順に並ぶ。線の両端は同じマップのノード。 */
export interface StoredMapContent {
  title: string;
  description: string;
  nodes: StoredMapNode[];
  edges: { from: string; to: string }[];
}

/** 保存した「理解すること」の1項目。 */
export interface StoredLearningObjective {
  id: string;
  conceptId: string;
  label: string;
  source: LearningObjectiveSource;
}

/** 保存したマップ1件。`objectives` はこのマップのノード（参照ではないもの）の項目。 */
export interface StoredLearningMap extends StoredMapContent {
  id: string;
  visibility: LearningMapVisibility;
  /** 共有の側のいちばん新しい版の番号（#244）。まだ一度も上げていなければ `null`。 */
  latestVersion: number | null;
  /**
   * 手元のマップの書き換えの回数（migrations/0019 の revision）。中身か項目を書き換えるたびに増える。
   * 共有へ上げる・復元するときに、読んだときから変わっていないことを確かめるのに使う。
   */
  revision: number;
  /** 「リンクだけ」の共有の鍵（0019、決定 U1）。範囲が `link` のときだけ持つ。 */
  shareKey: string | null;
  createdAt: string;
  updatedAt: string;
  /** Concept ID → 項目（保存した順）。項目の無いノードは含まない。 */
  objectives: Map<string, StoredLearningObjective[]>;
  /** 作成時の確認問題の状態（#247）。AI で作るときに頼まなかったマップは `null`。 */
  creationChecks: StoredCreationChecks | null;
}

/** 作成時の確認問題の状態（migrations/0015_map_creation_checks.sql）。 */
export interface StoredCreationChecks {
  /** マップを作るときに選んだ技術レベル。 */
  level: CheckLevel;
  /** 頼んだ回数。 */
  attempts: number;
  /** 1組でも保存できた時刻。まだなら `null`。 */
  doneAt: string | null;
  /** 作っている最中の印（頼んだ時刻）。無ければ `null`。 */
  startedAtMs: number | null;
}

/** 自分のマップのノード（参照ではないもの）1件と、その項目。参照の解決と VS Code 向けの一覧に使う。 */
export interface StoredOwnMapNode {
  conceptId: string;
  label: string;
  summary: string;
  mapId: string;
  mapTitle: string;
  /** 前提のノードの Concept ID（同じマップの線から引く）。 */
  prerequisites: string[];
  objectives: StoredLearningObjective[];
}

/** 共有の版1件（migrations/0019_learning_map_versions.sql、#244）。中身は JSON のまま返す。 */
export interface StoredMapVersion extends MapVersionMeta {
  /** maps/snapshot.ts の MapSnapshot の JSON。 */
  content: string;
  contentHash: string;
}

/** 共有の側から見たマップ（持ち主に限らず読む）。 */
export interface StoredSharedMap {
  id: string;
  ownerUserId: string;
  visibility: LearningMapVisibility;
  /** 範囲が `link` のときの鍵。 */
  shareKey: string | null;
  /** いちばん新しい版。まだ一度も上げていなければ `null`。 */
  latest: StoredMapVersion | null;
}

/**
 * 利用者が手で作る学習マップ（migrations/0013_learning_maps.sql、Issue #242）。
 *
 * どの操作も `ownerUserId` で絞る。他人のマップは「無い」として扱い、
 * ルートは 404 を返す（存在を隠す）。
 * 呼び出し前に `users` 行が存在している必要がある（外部キー）。
 */
export interface LearningMapRepository {
  /**
   * マップを作る。1人のマップ数が `maxMaps` に達していれば何も書かず `created: false` を返す。
   * 数えることと書くことを1つの操作にまとめる（同時に作られても上限を超えない）。
   *
   * `objectives` は、作るノード（参照ではないもの）の「理解すること」。AI の生成（#243）が
   * マップと一緒に入れる。並びはノードごとに渡した順。マップと同じ操作で書くので、
   * 途中で失敗しても項目の無いノードだけが残ることはない。このマップに無いノードを指す項目は例外。
   */
  create(
    ownerUserId: string,
    params: {
      id: string;
      content: StoredMapContent;
      objectives?: readonly StoredLearningObjective[];
      /** AI で作るときに「確認問題も作る」を選んだら、そのときの技術レベル（#247）。 */
      creationChecksLevel?: CheckLevel;
      nowIso: string;
      nowMs: number;
      maxMaps: number;
    },
  ): Promise<{ created: boolean }>;

  /**
   * 作成時の確認問題を頼む権利を取る（#247）。まだ作成済みでなく、頼んだ回数が
   * `maxAttempts` 未満で、**作っている最中でない**ときだけ、回数を1つ増やして作っている最中の印を付け、
   * 技術レベルを返す。判定と書き込みは1つの操作で行う（同時に2回頼まれても、両方は通さない）。
   * `leaseMs` より古い印は、途中で止まった要求の残りとして無視する。取れなければ `null`。
   */
  claimCreationChecks(
    ownerUserId: string,
    mapId: string,
    params: { maxAttempts: number; nowMs: number; leaseMs: number },
  ): Promise<CheckLevel | null>;

  /**
   * 作っている最中の印を外す（作れなかったとき）。`refundAttempt` なら頼んだ回数も1つ戻す
   * （上流へ送る前に止まった、回数の枠が足りなかったときなど）。
   */
  releaseCreationChecks(
    ownerUserId: string,
    mapId: string,
    params: { refundAttempt: boolean },
  ): Promise<void>;

  /** 作成時の確認問題を作成済みにし、作っている最中の印を外す。@returns 自分のマップが無ければ `false`。 */
  completeCreationChecks(ownerUserId: string, mapId: string, nowIso: string): Promise<boolean>;

  /** 自分のマップの一覧。更新の新しい順（同時刻は ID の昇順）。 */
  listByOwner(ownerUserId: string): Promise<LearningMapSummary[]>;

  /** マップ1件。自分のものでなければ `null`。 */
  get(ownerUserId: string, mapId: string): Promise<StoredLearningMap | null>;

  /**
   * 題名・説明・ノード・線をまとめて置き換える。途中で壊れた状態を残さない（1つの batch）。
   *
   * 残したノードの「理解すること」は消さない。送られなかったノードは、その項目と線ごと消える。
   * @returns 自分のマップが無ければ `false`。
   */
  replace(
    ownerUserId: string,
    mapId: string,
    content: StoredMapContent,
    now: { nowIso: string; nowMs: number },
  ): Promise<boolean>;

  /**
   * 共有の新しい版を足し、共有の範囲を `scope` にする（#244 の T1-a）。
   *
   * いちばん新しい版が `expectedLatest`（まだ版が無ければ `null`）で、手元のマップの
   * 書き換えの回数が `expectedRevision` のときだけ書く。中身を読んだあとに別の端末で
   * 上げられた・手元が直されたら、何も書かず `false` を返す。
   * 版の番号は `expectedLatest + 1`（無ければ 1）。判定と書き込みは1つのトランザクションで行う。
   * 自分のマップでなければ `false`。
   */
  publishVersion(
    ownerUserId: string,
    mapId: string,
    params: {
      expectedLatest: number | null;
      expectedRevision: number;
      scope: ShareScope;
      /** 範囲が `link` なら鍵、それ以外は `null`。 */
      shareKey: string | null;
      content: string;
      contentHash: string;
      checksIncluded: boolean;
      summary: MapVersionSummary;
      nowIso: string;
      nowMs: number;
    },
  ): Promise<boolean>;

  /**
   * 共有の範囲だけを変える。版は作らない。`null` で非公開に戻す（版は残す）。
   * 共有へ切り替える（`null` 以外）のは、版が1つ以上あるときだけ。
   * @returns 自分のマップが無いか、版が無いのに共有へ切り替えようとしたら `false`。
   */
  setShareScope(
    ownerUserId: string,
    mapId: string,
    scope: ShareScope | null,
    /** 範囲が `link` なら鍵、それ以外は `null`。 */
    shareKey: string | null,
  ): Promise<boolean>;

  /** 自分のマップの版の一覧（新しい版から、中身は含めない）。自分のマップでなければ `null`。 */
  listVersions(ownerUserId: string, mapId: string): Promise<MapVersionMeta[] | null>;

  /** 自分のマップの版1つ。自分のマップでないか、その版が無ければ `null`。 */
  getVersion(ownerUserId: string, mapId: string, version: number): Promise<StoredMapVersion | null>;

  /**
   * 過去の版 `fromVersion` の中身で新しい版を作り、手元のマップもその中身に戻す（#244 の T2）。
   * 履歴は書き換えない。新しい版の中身・ハッシュ・確認問題を含めたかは元の版のまま写す。
   *
   * 手元は `content`（題名・説明・ノード・線）と `objectives`（参照ではないノードの項目の全部）で
   * 置き換える。残すノードの項目のうち `objectives` に無いものは消え、それを狙った自分の
   * 確認問題も消える（{@link replaceObjectives} と同じ扱い）。消えるノードの確認問題も消える
   * （{@link replace} と同じ）。
   *
   * いちばん新しい版が `expectedLatest` で、手元のマップの書き換えの回数が `expectedRevision` の
   * ときだけ書く。違えば何も書かず `false`（読んだあとに手元で直した分を黙って消さない）。
   */
  restoreVersion(
    ownerUserId: string,
    mapId: string,
    params: {
      fromVersion: number;
      expectedLatest: number;
      expectedRevision: number;
      content: StoredMapContent;
      objectives: readonly StoredLearningObjective[];
      summary: MapVersionSummary;
      nowIso: string;
      nowMs: number;
    },
  ): Promise<boolean>;

  /** 持ち主に限らずマップを読む（共有の側の表示、#244）。マップが無ければ `null`。 */
  getShared(mapId: string): Promise<StoredSharedMap | null>;

  /** 範囲が「全員」の共有マップ。新しく上げた順（同時刻は ID の昇順）に `limit` 件まで。 */
  listPublic(limit: number): Promise<SharedMapSummary[]>;

  /** マップを消す。ノード・線・項目も消える。@returns 消したら `true`。 */
  delete(ownerUserId: string, mapId: string): Promise<boolean>;

  /**
   * 1つのノードの「理解すること」をまとめて置き換える。並びは渡した順。
   *
   * ノードが自分のマップの参照ではないノードであることを、書き込みと同じ操作の中で確かめる。
   * 呼び出し側が読んでから書くまでの間に、別の端末でマップやノードが消されうるため。
   * @returns そのノードが無ければ何も書かず `false`。
   */
  replaceObjectives(
    ownerUserId: string,
    params: {
      mapId: string;
      conceptId: string;
      objectives: readonly { id: string; label: string; source: LearningObjectiveSource }[];
      nowIso: string;
      nowMs: number;
    },
  ): Promise<boolean>;

  /** 自分のマップのノード（参照ではないもの）のうち、指定した Concept ID のもの。 */
  findOwnNodes(ownerUserId: string, conceptIds: readonly string[]): Promise<StoredOwnMapNode[]>;

  /**
   * 自分のマップのノード（参照ではないもの）を、更新の新しいマップから順に `limit` 件まで。
   * マップの中ではノードの並び（学習の順）に従う。
   */
  listOwnNodes(ownerUserId: string, limit: number): Promise<StoredOwnMapNode[]>;

  /**
   * 固定の Concept（言語別マップ）の「理解すること」の全件（migrations/0017_fixed_objectives.sql、#245）。
   * どの利用者にも属さない。並びは Concept ID の順、Concept の中は保存した順。
   */
  listFixedObjectives(): Promise<StoredLearningObjective[]>;

  /**
   * 固定の Concept 1つの「理解すること」をまとめて置き換える（#245 の決定 M6）。並びは渡した順。
   *
   * 渡さなかった項目は消え、それを狙った確認問題も**全利用者の分**を消す（マップのノードの
   * {@link replaceObjectives} と同じ扱い）。学習イベントの `objective_ids` は消さない
   * （学習の記録は残し、理解度は補填しない：#223）。
   * 作成者かどうかは呼び出し側が確かめる。
   *
   * 呼び出し側は {@link getFixedObjectives} で読んだ版を `expectedRevision` に渡す。読んでから書くまでの
   * 間に別の置き換えが入って版が変わっていたら、何も書かずに `false` を返す（PR #293 のレビュー。
   * 読んだ一覧で ID を確かめたのに、別の置き換えで消えた項目を書き戻さないため）。
   * 判定と書き込みは1つのトランザクションで行う。書けたら版を `revision` にする。
   */
  replaceFixedObjectives(params: {
    conceptId: string;
    expectedRevision: string | null;
    revision: string;
    objectives: readonly { id: string; label: string; source: LearningObjectiveSource }[];
    nowIso: string;
  }): Promise<boolean>;

  /**
   * 固定の Concept 1つの「理解すること」（保存した順）と、その版（migrations/0018 の
   * fixed_objective_revisions）。一度も置き換えていなければ版は `null`。
   */
  getFixedObjectives(
    conceptId: string,
  ): Promise<{ objectives: StoredLearningObjective[]; revision: string | null }>;
}
