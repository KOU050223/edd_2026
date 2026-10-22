// 分析済み・未適用のインポート結果（会話本文を含む）の保持期限を管理する。
// Electron や fs に触れないので単体テストできる（Issue #279 ステップ 6）。
import type { HistoryProviderId, RawConversation } from "@gakushu-sochi/domain";

import type { ImportPreview } from "../../shared/types.js";

/** 分析から破棄までの猶予。本文を長く持たないための上限。 */
export const PENDING_IMPORT_TTL_MS = 30 * 60 * 1000;

const EXPIRED_MESSAGE =
  "分析結果は 30 分の期限を過ぎたため破棄されました。もう一度履歴の分析を実行してください。";

export interface PendingImport {
  preview: ImportPreview;
  pending: Map<HistoryProviderId, RawConversation[]>;
  /** この時刻（Date.now のミリ秒）を過ぎたら使えない。 */
  expiresAt: number;
}

/** 期限切れ判定。時計を渡せるのでテストできる。 */
export function isPendingImportExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}

type DiscardCause = "expired" | undefined;

export class PendingImportStore {
  private entry: PendingImport | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  // 破棄理由が期限切れだったかだけを残す（本文は残さない）。
  // 「まだ分析していない」と「期限切れで消えた」を呼び出し側の文言で分けるため。
  private lastCause: DiscardCause;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly schedule: (
      fn: () => void,
      ms: number,
    ) => ReturnType<typeof setTimeout> = setTimeout,
  ) {}

  /**
   * 新しい分析結果を入れる。既存の内容とタイマーは破棄する。
   * expiresAt を渡すと期限を引き継ぐ（貼り戻しマージで期限だけ延びないようにする）。
   */
  set(value: Omit<PendingImport, "expiresAt">, expiresAt?: number): void {
    this.clearTimer();
    this.entry = { ...value, expiresAt: expiresAt ?? this.now() + PENDING_IMPORT_TTL_MS };
    this.lastCause = undefined;
    const timer = this.schedule(() => this.discardExpired(), PENDING_IMPORT_TTL_MS);
    // アプリの終了をこのタイマーで引き延ばさない。
    timer.unref?.();
    this.timer = timer;
  }

  /** 期限切れなら破棄して undefined、有効なら中身を返す。 */
  get(): PendingImport | undefined {
    if (this.entry === undefined) return undefined;
    if (isPendingImportExpired(this.entry.expiresAt, this.now())) {
      this.discardExpired();
      return undefined;
    }
    return this.entry;
  }

  /**
   * 中身を要求する。無ければ `notFoundMessage`、期限切れで捨てた直後なら
   * 期限切れと分かる文言で失敗させる。
   */
  require(notFoundMessage: string): PendingImport {
    const entry = this.get();
    if (entry !== undefined) return entry;
    if (this.lastCause === "expired") throw new Error(EXPIRED_MESSAGE);
    throw new Error(notFoundMessage);
  }

  /**
   * 内容を破棄する。適用完了・ログアウト・認証状態の変化・新しい分析の開始で
   * 呼ぶ。別アカウントの会話本文が残らないようにするのが目的。
   */
  discard(): void {
    this.clearTimer();
    this.entry = undefined;
    this.lastCause = undefined;
  }

  private discardExpired(): void {
    this.clearTimer();
    this.entry = undefined;
    this.lastCause = "expired";
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * 分析済みだが未適用の Import。renderer には本文を渡さないため、
 * prompt-copy fallback と apply の素材を main 側だけに保持する。
 * このモジュールは実行時依存を持たない葉なので、auth/ から
 * 循環参照なしで破棄を呼べる。
 */
export const pendingImportStore = new PendingImportStore();

/**
 * 未適用の分析結果を破棄する。ログアウトや別アカウントへのログイン開始など、
 * 認証の境界が変わるときに呼ぶ。前のアカウントの会話本文を残さないため。
 */
export function discardPendingImport(): void {
  pendingImportStore.discard();
}
