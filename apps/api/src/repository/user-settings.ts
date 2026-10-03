import {
  USER_SETTINGS_VERSION,
  type UserSettings,
  type UserSettingsInput,
} from "../contract/user-settings.js";
import type { UserSettingsRepository } from "./types.js";

/** `UserSettingsRepository` のインメモリ実装。テスト用。 */
export class InMemoryUserSettingsRepository implements UserSettingsRepository {
  private readonly byUser = new Map<string, UserSettings>();

  get(userId: string): Promise<UserSettings | null> {
    return Promise.resolve(this.byUser.get(userId) ?? null);
  }

  put(userId: string, input: UserSettingsInput, updatedAt: string): Promise<UserSettings> {
    // 省略された項目は保存済みの値を維持する（D1 実装と同じマージ規則）。
    const current = this.byUser.get(userId);
    const settings: UserSettings = {
      version: USER_SETTINGS_VERSION,
      displayName:
        input.displayName === undefined ? (current?.displayName ?? null) : input.displayName,
      activityPeriodDays: input.activityPeriodDays ?? current?.activityPeriodDays ?? 30,
      saveConversationHistory:
        input.saveConversationHistory ?? current?.saveConversationHistory ?? false,
      updatedAt,
    };
    this.byUser.set(userId, settings);
    return Promise.resolve(settings);
  }
}
