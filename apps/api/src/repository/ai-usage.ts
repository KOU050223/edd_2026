/**
 * `AiUsageRepository` のインメモリ実装。テスト用。
 *
 * D1 実装との差異が出ないよう、期間の切り替わりの扱いを SQL 側と一致させてある。
 * 月が変われば回数とトークンの両方が 0 から、日が変われば日次の回数だけが
 * 0 から数え直される。
 */

import type { AiUsage, AiUsageRepository } from "./types.js";

interface Row {
  monthKey: string;
  dayKey: string;
  monthlyRequests: number;
  dailyRequests: number;
  monthlyTokens: number;
}

export class InMemoryAiUsageRepository implements AiUsageRepository {
  /** userId -> (monthKey -> 集計)。主キーを D1 と揃える。 */
  private readonly byUser = new Map<string, Map<string, Row>>();

  get(params: { userId: string; monthKey: string; dayKey: string }): Promise<AiUsage> {
    return Promise.resolve(this.read(params));
  }

  reserve(params: {
    userId: string;
    monthKey: string;
    dayKey: string;
    updatedAt: string;
    limits: { dailyRequests: number; monthlyRequests: number };
  }): Promise<{ reserved: boolean; usage: AiUsage }> {
    const { userId, monthKey, dayKey, limits } = params;
    const current = this.read(params);
    // 上限に達していたら加算しない。D1 側は `DO UPDATE ... WHERE` で同じことを
    // 1文でやる。弾いた分まで枠を消費しないという性質を、両実装で揃える。
    if (
      current.monthlyRequests >= limits.monthlyRequests ||
      current.dailyRequests >= limits.dailyRequests
    ) {
      return Promise.resolve({ reserved: false, usage: current });
    }
    const next: Row = {
      monthKey,
      dayKey,
      monthlyRequests: current.monthlyRequests + 1,
      dailyRequests: current.dailyRequests + 1,
      monthlyTokens: current.monthlyTokens,
    };
    this.write(userId, monthKey, next);
    return Promise.resolve({
      reserved: true,
      usage: {
        monthlyRequests: next.monthlyRequests,
        dailyRequests: next.dailyRequests,
        monthlyTokens: next.monthlyTokens,
      },
    });
  }

  addTokens(params: {
    userId: string;
    monthKey: string;
    dayKey: string;
    tokens: number;
    updatedAt: string;
  }): Promise<void> {
    const { userId, monthKey, dayKey, tokens } = params;
    const current = this.read(params);
    this.write(userId, monthKey, {
      monthKey,
      dayKey,
      monthlyRequests: current.monthlyRequests,
      dailyRequests: current.dailyRequests,
      monthlyTokens: current.monthlyTokens + tokens,
    });
    return Promise.resolve();
  }

  /** 期間の切り替わりを反映した現在値。記録が無ければ全て 0。 */
  private read(params: { userId: string; monthKey: string; dayKey: string }): AiUsage {
    const row = this.byUser.get(params.userId)?.get(params.monthKey);
    if (row === undefined) return { monthlyRequests: 0, dailyRequests: 0, monthlyTokens: 0 };
    return {
      monthlyRequests: row.monthlyRequests,
      // 行が持つ日次は `day_key` の日のものである。日が変わっていれば数え直す。
      dailyRequests: row.dayKey === params.dayKey ? row.dailyRequests : 0,
      monthlyTokens: row.monthlyTokens,
    };
  }

  private write(userId: string, monthKey: string, row: Row): void {
    let months = this.byUser.get(userId);
    if (months === undefined) {
      months = new Map();
      this.byUser.set(userId, months);
    }
    months.set(monthKey, row);
  }
}
