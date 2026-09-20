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
import type { MasteryStatus } from "@gakushu-sochi/domain";

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
   * マーカーは Auth0 側の削除が失敗しても再実行できるよう残す。
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
