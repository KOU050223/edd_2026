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
    const settings: UserSettings = { version: USER_SETTINGS_VERSION, ...input, updatedAt };
    this.byUser.set(userId, settings);
    return Promise.resolve(settings);
  }
}
