/**
 * `GET /v1/learning-profile`。
 *
 * イベントの生ログではなく、導出済みの読み取りモデルを返す（docs/architecture.md）。
 */

import { Hono } from "hono";
import {
  CONCEPT_BY_ID,
  deriveFamiliarityFromEvidence,
  deriveMasteryFromEvents,
} from "@gakushu-sochi/domain";
import {
  compareConceptView,
  LEARNING_PROFILE_RESPONSE_VERSION,
  type ConceptMasteryView,
  type LearningProfileResponse,
} from "../contract/learning-profile.js";
import type { AuthVariables } from "../auth/middleware.js";
import type { LearningEventRepository, LearningEvidenceRepository } from "../repository/types.js";

export interface ProfileDeps {
  events: LearningEventRepository;
  /**
   * 外部履歴から取り込んだ Evidence（Issue #157）。Familiarity の導出に使う。
   * LearningEvent とは別の根拠であり、習熟度の計算には混ぜない。
   */
  evidence: LearningEvidenceRepository;
  /** 現在時刻を ISO 8601 で返す。テストで固定できるよう注入する。 */
  nowIso: () => string;
}

/** {@link SyncDepsResolver} と同じ理由で、依存はリクエスト時に解決する。 */
export type ProfileDepsResolver = (env: CloudflareBindings) => ProfileDeps;

export function createLearningProfileRoute(resolve: ProfileDepsResolver) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  app.get("/learning-profile", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const events = await deps.events.listByUser(userId);

    // 習熟度は保存値ではなくログから導出する。docs/concepts.md「サーバー側の導出」。
    const mastery = deriveMasteryFromEvents(events);

    const concepts: ConceptMasteryView[] = Object.values(mastery)
      // 観測のある Concept だけが値を持つ。既知の Concept 全件を 0 で埋めない。
      // 埋めると「判断材料がない」と「習熟度が低い」をクライアントが区別できない。
      .filter((item) => item !== undefined)
      .map((item) => {
        const label = CONCEPT_BY_ID.get(item.conceptId)?.label;
        return label === undefined ? item : { ...item, label };
      })
      .sort(compareConceptView);

    // 外部履歴由来の「触れた形跡」。Mastery とは別の軸であり、
    // concepts へ混ぜず familiarity として別に返す（Issue #157）。
    const evidence = await deps.evidence.listByUser(userId);
    const familiarity = Object.values(deriveFamiliarityFromEvidence(evidence))
      .filter((item) => item !== undefined)
      .map((item) => {
        const label = CONCEPT_BY_ID.get(item.conceptId)?.label;
        return label === undefined ? item : { ...item, label };
      })
      .sort((a, b) => (a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0));

    const body: LearningProfileResponse = {
      version: LEARNING_PROFILE_RESPONSE_VERSION,
      derivedAt: deps.nowIso(),
      concepts,
      eventCount: events.length,
      familiarity,
    };
    return c.json(body);
  });

  return app;
}
