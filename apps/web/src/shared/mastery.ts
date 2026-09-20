/**
 * 理解度の語彙。client と worker の両方から使う。
 *
 * 片方だけに置くと、保存時に受け付ける値と画面で選べる値が別々に育ち、
 * 「選べるのに保存できない理解度」が生まれる。増やすときはここだけを直す。
 */
export const MASTERY_STATUSES = ["unobserved", "learning", "confirmed"] as const;
export type MasteryStatus = (typeof MASTERY_STATUSES)[number];

export function isMasteryStatus(value: unknown): value is MasteryStatus {
  return MASTERY_STATUSES.includes(value as MasteryStatus);
}

/** ある Concept に対する手動の上書き。自動算出の evidence は含めない。 */
export interface MasteryOverride {
  status: MasteryStatus;
  /** 上書きした時刻。ISO 8601 形式。 */
  updatedAt: string;
}

export type MasteryOverrides = Record<string, MasteryOverride>;
