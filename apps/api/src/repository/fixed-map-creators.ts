import type { FixedMapCreatorRepository } from "./types.js";

/** `FixedMapCreatorRepository` のインメモリ実装。テスト用。 */
export class InMemoryFixedMapCreatorRepository implements FixedMapCreatorRepository {
  private readonly creators = new Set<string>();

  isCreator(language: string, userId: string): Promise<boolean> {
    return Promise.resolve(this.creators.has(JSON.stringify([language, userId])));
  }

  /** テストで作成者を入れる。本番には変える口が無い（migrations/0018_fixed_map_creators.sql）。 */
  add(language: string, userId: string): void {
    this.creators.add(JSON.stringify([language, userId]));
  }
}
