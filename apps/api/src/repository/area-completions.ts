import type { AreaCompletion } from "../contract/area-completions.js";
import type { AreaCompletionRepository } from "./types.js";

export class InMemoryAreaCompletionRepository implements AreaCompletionRepository {
  private readonly byUser = new Map<string, Map<string, AreaCompletion>>();

  listByUser(userId: string): Promise<AreaCompletion[]> {
    return Promise.resolve([...(this.byUser.get(userId)?.values() ?? [])]);
  }

  record(userId: string, languages: readonly string[], completedAt: string): Promise<void> {
    let completions = this.byUser.get(userId);
    if (completions === undefined) {
      completions = new Map();
      this.byUser.set(userId, completions);
    }
    for (const language of languages) {
      // 既にあるものは書き換えない。最初の達成時刻を残す（D1 の INSERT OR IGNORE と同じ）。
      if (!completions.has(language)) completions.set(language, { language, completedAt });
    }
    return Promise.resolve();
  }
}
