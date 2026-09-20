import type { CodeContext } from "@gakushu-sochi/domain";

/** Chat を開いた時点で固定する、AIリクエスト用の入力。 */
export interface PendingAIRequest {
  context: CodeContext;
  diagnostics: string[];
}

export interface PendingChatContextOptions {
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000;

interface PendingEntry {
  request: PendingAIRequest;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Chat を開く操作時に収集した文脈。
 *
 * Chat Participant のリクエストには、元のエディタ選択や LSP の結果が自動では
 * 含まれない。そのため送信直前ではなく、ショートカットを押した時点の結果を
 * 保持する。Participant 実装時は `take()` の値を AIRequest に載せる。
 */
export class PendingChatContext {
  private readonly values = new Map<string, PendingEntry>();
  private nextId = 1;

  private readonly ttlMs: number;

  constructor(options: PendingChatContextOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("PendingChatContext の ttlMs は正の有限数で指定してください");
    }
  }

  set(context: CodeContext, diagnostics: string[] = []): string {
    const id = `context-${this.nextId}`;
    this.nextId += 1;
    const timeout = setTimeout(() => {
      this.values.delete(id);
    }, this.ttlMs);
    this.values.set(id, { request: { context, diagnostics }, timeout });
    return id;
  }

  /** 最初の質問にだけ文脈を渡し、別の会話への混入を防ぐ。 */
  take(id: string): PendingAIRequest | undefined {
    const entry = this.values.get(id);
    if (!entry) {
      return undefined;
    }

    clearTimeout(entry.timeout);
    this.values.delete(id);
    return entry.request;
  }

  /**
   * 使われないと確定した文脈を捨てる。
   *
   * set() した直後に Chat を開けなかった場合、Participant は呼ばれず take() も走らない。
   * 放置すると、送信されなかった内容（ターミナルやクリップボードの中身）が
   * セッション終了まで残る。取り出す値が無いので take() ではなくこちらを使う。
   *
   * これは「開けなかった」と確定した経路の後始末に限る。ユーザーが Chat を
   * 開いたまま送らずに閉じた場合はここへ来ない。その場合も TTL で回収される。
   */
  discard(id: string): void {
    const entry = this.values.get(id);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timeout);
    this.values.delete(id);
  }
}
