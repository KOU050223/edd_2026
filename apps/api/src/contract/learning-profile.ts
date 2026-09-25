/**
 * `GET /v1/learning-profile` の外部契約。
 *
 * packages/domain の `LearnerProfile` をそのまま返さない。`LearnerProfile` は
 * VS Code の globalState に保存するための形であり、`events: LearningEvent[]` を
 * 抱えている。docs/architecture.md は「イベントの生ログではなく、画面表示に必要な
 * 導出済みの読み取りモデルを返す」と定めているため、別の型として定義する。
 *
 * 生ログを返さないのはプライバシー上の要請でもある。履歴の全件送出は
 * 「必要以上に保存・送信しない」方針と噛み合わない。
 */

import type { ConceptFamiliarity, ConceptMastery, MasteryStatus } from "@gakushu-sochi/domain";

/** 読み取りモデルのスキーマバージョン。破壊的変更のときに上げる。 */
export const LEARNING_PROFILE_RESPONSE_VERSION = 1;

/**
 * 1つの Concept についての読み取りモデル。
 *
 * `ConceptMastery` に表示用の `label` を足したもの。クライアントが Concept 一覧を
 * 別途持たなくても表示できるようにする。`evidence` を含めるのは、
 * docs/architecture.md が Learning Query の責務を「導出済みの Learning Map と根拠を返す」
 * と定めているためである。
 *
 * ただし `extends` である以上、domain の `ConceptMastery` にフィールドを足すと
 * 自動的に公開 HTTP 契約へ載る。domain 側に外へ出したくない値を追加するときは、
 * ここで明示的に列挙する形へ切り替える。
 */
export interface ConceptMasteryView extends ConceptMastery {
  /** 表示名。Concept 一覧に無い ID の場合は `undefined`。 */
  label?: string;
}

/**
 * 外部履歴由来の「触れた形跡」の読み取りモデル（Issue #157）。
 *
 * `ConceptFamiliarity` に表示用の `label` を足したもの。Mastery とは
 * 別の軸であり、`concepts` へ混ぜない。「過去に触れた」ことと
 * 「現在理解している」ことを区別するためである。
 */
export interface ConceptFamiliarityView extends ConceptFamiliarity {
  /** 表示名。Concept 一覧に無い ID の場合は `undefined`。 */
  label?: string;
}

export interface LearningProfileResponse {
  version: number;
  /** サーバーが導出した時刻。ISO 8601。 */
  derivedAt: string;
  /**
   * 観測のある Concept の習熟度だけを並べる。
   *
   * **既知の Concept 全件を 0 で埋めてはならない。** docs/concepts.md の通り、
   * `unobserved` は「習熟度が低い」ではなく「判断材料がない」を意味する。
   * 全件を 0 で返すと、クライアントはこの2つを区別できず 0% と表示してしまう。
   * 未観測は「この配列に現れないこと」で表現する。
   */
  concepts: ConceptMasteryView[];
  /** 導出の根拠になったイベントの総件数。イベント本体は返さない。 */
  eventCount: number;
  /**
   * 外部履歴由来の Familiarity（Issue #157）。
   * `concepts` と同じく、観測のある Concept だけを並べる。
   */
  familiarity: ConceptFamiliarityView[];
}

/**
 * `concepts` の並び順を安定させるための比較関数。
 *
 * 同じデータに対して常に同じ順序を返さないと、クライアントの差分描画が
 * 無駄に走り、レスポンスのキャッシュ比較もできない。
 * status（confirmed → learning）、score の降順、ID の昇順で決める。
 */
const STATUS_ORDER: Record<MasteryStatus, number> = {
  confirmed: 0,
  learning: 1,
  unobserved: 2,
};

export function compareConceptView(a: ConceptMasteryView, b: ConceptMasteryView): number {
  const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (statusDiff !== 0) {
    return statusDiff;
  }
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  return a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0;
}
