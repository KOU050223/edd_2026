import type { MasteryStatus } from "@gakushu-sochi/domain";
import type { MasteryOverride, MasteryOverrideRepository } from "./types.js";

export class InMemoryMasteryOverrideRepository implements MasteryOverrideRepository {
  private readonly byUser = new Map<string, Map<string, MasteryOverride>>();

  listByUser(userId: string): Promise<Record<string, MasteryOverride>> {
    return Promise.resolve(Object.fromEntries(this.byUser.get(userId) ?? []));
  }

  put(
    userId: string,
    conceptId: string,
    status: MasteryStatus | null,
    updatedAt: string,
  ): Promise<Record<string, MasteryOverride>> {
    let overrides = this.byUser.get(userId);
    if (overrides === undefined) {
      overrides = new Map();
      this.byUser.set(userId, overrides);
    }
    if (status === null) overrides.delete(conceptId);
    else overrides.set(conceptId, { status, updatedAt });
    return Promise.resolve(Object.fromEntries(overrides));
  }
}
