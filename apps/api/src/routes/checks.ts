/**
 * 確認問題（#184 / #236）。利用者ごとに生成して保存し、本人だけが読む。
 *
 * - `GET /v1/checks?conceptId=`: その Concept で保存済みの組。**AI を呼ばない。**
 * - `POST /v1/checks:generate`: 1組を生成して保存する（同じ狙いがあれば上書き＝作り直し）。
 * - `GET /v1/checks:export`: 保存済みの全件（学習データのエクスポート）。
 * - `GET` / `PUT` / `DELETE /v1/check-generation-consent`: 生成への同意の「今後表示しない」。
 *
 * ## 生成は利用者が選んだときだけ走る
 *
 * 画面を開いただけでは生成しない。保存済みを `GET` で表示し、利用者が技術レベルと範囲を選んで
 * 「作る」「作り直す」を押したときだけ `POST` が来る（#236 の決定 6）。
 *
 * ## 回数は `ai_usage` に1組1回で数える
 *
 * 問題は全員で使い回さないので、生成量は利用者数に比例する。`POST /v1/ai/responses` と
 * 同じ利用者ごとの枠（日 15 回 / 月 150 回）から、**1組の生成につき1回**引く。
 * 保存済みを読むだけなら数えない（#236 の決定）。
 *
 * ## 本人の質問を送るのは同意があるときだけ
 *
 * 「理解すること」を狙う組では、その項目で本人が自力解決した質問の本文を材料に渡す。
 * 送信の同意（Web Worker の KV、`CONSENT_NOTICE_VERSION`）とは別に、生成のその場で
 * 同意を取る（`CHECK_GENERATION_NOTICE`）。要求に今の版の `consentVersion` が載っているか、
 * 「今後表示しない」の記録が今の版であるときだけ生成する。**材料が無い組でも同じ**にする。
 * 送るかどうかが材料の有無で変わると、同意を求める画面が出たり出なかったりする。
 */

import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import * as v from "valibot";
import {
  CHECK_GENERATION_CONSENT_VERSION,
  type ConsentRecord,
  type PersonalConceptCheck,
} from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { rateLimit } from "../auth/rate-limit.js";
import type { ChecksDeps } from "../checks/deps.js";
import { conceptIdSchema, generateCheck, generateSchema } from "../checks/generate.js";

export type { ChecksDeps } from "../checks/deps.js";

const listQuerySchema = v.object({ conceptId: conceptIdSchema });

const consentSchema = v.object({ version: v.pipe(v.number(), v.integer()) });

export type ChecksDepsResolver = (env: CloudflareBindings) => ChecksDeps;

/** カンマ区切りのモデル名（`vars.CHECK_MODELS`）を並びにする。空の要素は捨てる。 */
export function parseModelList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** `GET /v1/check-generation-consent` の応答。 */
export interface CheckGenerationConsentBody {
  /** 今の文面の版。クライアントは同意したときにこの値を送る。 */
  version: number;
  /** 今の版で「今後表示しない」を選んでいるか。古い版の記録は false。 */
  granted: boolean;
  grantedAt?: string;
}

/** `GET /v1/checks:export` の応答。 */
export interface CheckExportBody {
  version: 1;
  exportedAt: string;
  checks: PersonalConceptCheck[];
}

function consentBody(record: ConsentRecord | null): CheckGenerationConsentBody {
  const granted = record !== null && record.version === CHECK_GENERATION_CONSENT_VERSION;
  return {
    version: CHECK_GENERATION_CONSENT_VERSION,
    granted,
    ...(granted ? { grantedAt: record.grantedAt } : {}),
  };
}

export function createChecksRoute(resolve: ChecksDepsResolver) {
  const route = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  // 認証（`app.ts` の `/v1/*`）の後に走るので userId で数えられる。
  // 保存済みを読むだけの要求にも同じ上限を効かせる。
  route.use(
    "/checks*",
    rateLimit((env) => env.PROFILE_RATE_LIMITER),
  );
  route.use(
    "/check-generation-consent",
    rateLimit((env) => env.PROFILE_RATE_LIMITER),
  );

  route.get("/checks", vValidator("query", listQuerySchema), async (c) => {
    const { conceptId } = c.req.valid("query");
    const deps = resolve(c.env);
    const checks = await deps.checks.listByConcept(c.get("user").userId, conceptId);
    return c.json({ checks }, 200, { "cache-control": "no-store" });
  });

  route.get("/checks:export", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    // 監査ログは users(id) を参照する。一度も同期していない利用者でも記録できるようにする。
    await deps.identity.ensureUser({ userId, nowMs: deps.now().getTime() });
    const checks = await deps.checks.listAllByUser(userId);
    await deps.audit.record({
      userId,
      action: "concept_checks.exported",
      occurredAtMs: deps.now().getTime(),
      detail: { checkCount: checks.length },
    });
    const body: CheckExportBody = {
      version: 1,
      exportedAt: deps.now().toISOString(),
      checks,
    };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  route.get("/check-generation-consent", async (c) => {
    const deps = resolve(c.env);
    const record = await deps.consents.get(c.get("user").userId);
    return c.json(consentBody(record), 200, { "cache-control": "no-store" });
  });

  route.put("/check-generation-consent", vValidator("json", consentSchema), async (c) => {
    const { version } = c.req.valid("json");
    if (version !== CHECK_GENERATION_CONSENT_VERSION) {
      // 古い文面を見て押した同意を、今の文面への同意として記録しない。
      return c.json(
        {
          error: "consent_outdated",
          message:
            "確認の文面が更新されました。ページを再読み込みして、最新の内容を確認してください。",
        },
        409,
      );
    }
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const now = deps.now();
    await deps.identity.ensureUser({ userId, nowMs: now.getTime() });
    const record: ConsentRecord = {
      version: CHECK_GENERATION_CONSENT_VERSION,
      grantedAt: now.toISOString(),
    };
    await deps.consents.put(userId, record);
    return c.json(consentBody(record), 200, { "cache-control": "no-store" });
  });

  route.delete("/check-generation-consent", async (c) => {
    const deps = resolve(c.env);
    await deps.consents.delete(c.get("user").userId);
    return c.json(consentBody(null), 200, { "cache-control": "no-store" });
  });

  route.post("/checks:generate", vValidator("json", generateSchema), async (c) => {
    const outcome = await generateCheck(
      resolve(c.env),
      c.get("user").userId,
      c.req.valid("json"),
      c.req.path,
    );
    if (outcome.status === 200) {
      return c.json(outcome.body, 200, { "cache-control": "no-store" });
    }
    return c.json(outcome.body, outcome.status);
  });

  return route;
}
