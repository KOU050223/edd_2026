/**
 * `POST /v1/area-completions:check`。
 *
 * 分野（Concept ID のプレフィックス）を全件 確認済みにしたかを判定し、
 * 初めて満たした分野だけを記録して、記録の全件を返す。
 *
 * **判定はサーバーで行う。** クライアントから「達成した」を受け取る形にすると、
 * 記録が利用者の手で作れる。習熟度はイベントから導出するのがこの API の役目
 * （docs/concepts.md「サーバー側の導出」）なので、その延長として判定もここへ置く。
 *
 * **GET ではなく POST にしている。** 記録を書きうるためである。ただし新しく満たした
 * 分野が無ければ書き込みは 1 回も走らない（下の `newly.length === 0`）。
 * 地図を開くたびに叩かれる経路なので、何も起きないときに D1 を書かないことを守る。
 */

import { Hono } from "hono";
import { deriveMasteryFromEvents, type Concept, type MasteryStatus } from "@gakushu-sochi/domain";
import {
  AREA_COMPLETIONS_RESPONSE_VERSION,
  type AreaCompletionsResponse,
} from "../contract/area-completions.js";
import type { AuthVariables } from "../auth/middleware.js";
import type {
  AreaCompletionRepository,
  IdentityRepository,
  LearningEventRepository,
  MasteryOverrideRepository,
} from "../repository/types.js";

export interface AreaCompletionDeps {
  identity: IdentityRepository;
  events: LearningEventRepository;
  /** 手動上書きも判定に含める。利用者が手で確認済みにした分野も達成として扱う。 */
  overrides: MasteryOverrideRepository;
  completions: AreaCompletionRepository;
  /** Concept の定義。テストで小さな一覧へ差し替えられるよう注入する。 */
  definitions: readonly Concept[];
  nowIso: () => string;
  nowMs: () => number;
}

export type AreaCompletionDepsResolver = (env: CloudflareBindings) => AreaCompletionDeps;

/**
 * 全件 確認済みになっている分野を、定義順に返す。
 *
 * Concept を 1 件も持たない分野は作れない（定義から組み立てるため）。
 * 「観測が無い」は `confirmed` ではないので、未観測が 1 件でも残っていれば達成しない。
 */
export function completedAreas(
  statusOf: ReadonlyMap<string, MasteryStatus>,
  definitions: readonly Concept[],
): string[] {
  const byLanguage = new Map<string, Concept[]>();
  for (const definition of definitions) {
    const list = byLanguage.get(definition.language);
    if (list === undefined) byLanguage.set(definition.language, [definition]);
    else list.push(definition);
  }
  const completed: string[] = [];
  for (const [language, list] of byLanguage) {
    if (list.every((definition) => statusOf.get(definition.id) === "confirmed")) {
      completed.push(language);
    }
  }
  return completed;
}

export function createAreaCompletionsRoute(resolve: AreaCompletionDepsResolver) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  app.post("/area-completions:check", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const [events, overrides, recorded] = await Promise.all([
      deps.events.listByUser(userId),
      deps.overrides.listByUser(userId),
      deps.completions.listByUser(userId),
    ]);

    // 習熟度は保存値ではなくイベントから導出し、その上へ手動上書きを重ねる。
    // 画面（apps/web の applyOverrides）と同じ重ね順にしないと、判定が食い違う。
    const statusOf = new Map<string, MasteryStatus>();
    for (const mastery of Object.values(deriveMasteryFromEvents(events))) {
      if (mastery !== undefined) statusOf.set(mastery.conceptId, mastery.status);
    }
    for (const [conceptId, override] of Object.entries(overrides)) {
      statusOf.set(conceptId, override.status);
    }

    const known = new Set(recorded.map((completion) => completion.language));
    const newly = completedAreas(statusOf, deps.definitions).filter(
      (language) => !known.has(language),
    );

    if (newly.length > 0) {
      await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });
      await deps.completions.record(userId, newly, deps.nowIso());
    }

    const body: AreaCompletionsResponse = {
      version: AREA_COMPLETIONS_RESPONSE_VERSION,
      // 追記した直後の一覧を返す。書いた内容を手元で組み立てて返すと、
      // 保存に失敗しても達成したように見える。
      completions: newly.length > 0 ? await deps.completions.listByUser(userId) : recorded,
      newlyCompleted: newly,
    };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  return app;
}
