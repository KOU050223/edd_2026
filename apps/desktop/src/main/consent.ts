/**
 * 送信同意の記録（#174）。
 *
 * このアプリが外部へ送る経路（Managed AI への選択テキスト・質問文の送信）は、
 * すべてここを通してから送る。文面と版は `@gakushu-sochi/domain` の
 * consent.ts が正本で、VS Code 拡張・Web と同じ内容を提示する。
 *
 * 記録は `userData` 直下の専用ファイル（consent.json）に置く。settings.json に
 * 混ぜないのは、設定の書き換え経路（IPC の `settings:save`）から同意を
 * 偽装できないようにするためである（RULE-006）。`userData` は利用者の端末に
 * しか無く、開いたファイルや Web コンテンツからは触れない。
 */

import { createConsentRecord, isConsentGranted, type ConsentRecord } from "@gakushu-sochi/domain";

/** consent.json の読み書き。ファイルの在り方は呼び出し側が決める。 */
export interface ConsentStorage {
  /** 未作成・取り消し済みは空文字を返す。 */
  read(): string;
  write(value: string): void;
}

export function createConsentStore(
  storage: ConsentStorage,
  onUnreadable: (raw: string) => void = (raw) =>
    console.error("consent record is not valid JSON; treating as not granted", { raw }),
) {
  /** 毎回読み直す。取り消しが次回起動まで効かない状態を作らないため。 */
  const read = (): ConsentRecord | undefined => {
    const raw = storage.read();
    if (!raw) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      // 壊れた記録は同意なしとして扱うが、黙って捨てない（RULE-004）。
      onUnreadable(raw);
      return undefined;
    }
    // 版が古い・形が違う記録も同意なし。isConsentGranted 側が判定を持つ。
    return isConsentGranted(value) ? value : undefined;
  };

  return {
    has(): boolean {
      return read() !== undefined;
    },
    grantedAt(): string | undefined {
      return read()?.grantedAt;
    },
    /**
     * 同意の記録を保存する。
     *
     * **保存に失敗したら同意が成立していない。** 成功として扱うと記録の無い
     * まま送信が続く。失敗はそのまま投げて呼び出し側の送信を止める（RULE-004）。
     */
    grant(grantedAt: string): void {
      storage.write(JSON.stringify(createConsentRecord(grantedAt)));
    },
    /** 取り消す。以降 `has` は false になり、送信は止まる。 */
    revoke(): void {
      storage.write("");
    },
  };
}
