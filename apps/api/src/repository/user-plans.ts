import type { Plan } from "../contract/ai-usage.js";
import type { UserPlanRepository } from "./types.js";

/** `UserPlanRepository` のインメモリ実装。テスト用。 */
export class InMemoryUserPlanRepository implements UserPlanRepository {
  private readonly byUser = new Map<string, Plan>();

  get(userId: string): Promise<Plan> {
    return Promise.resolve(this.byUser.get(userId) ?? "free");
  }

  /** テストでプランを入れる。本番には変える口が無い（migrations/0016_user_plans.sql）。 */
  set(userId: string, plan: Plan): void {
    this.byUser.set(userId, plan);
  }
}
