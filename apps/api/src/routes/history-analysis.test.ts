import { beforeEach, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { createAuth, type AuthVariables } from "../auth/middleware.js";
import { AuthVerificationError, type AuthVerifier } from "../auth/verifier.js";
import { AI_USAGE_LIMITS } from "../contract/ai-usage.js";
import { InMemoryAiUsageRepository } from "../repository/ai-usage.js";
import { InMemoryIdentityRepository } from "../repository/memory.js";
import { createAiRoute } from "./ai.js";
import type { HistoryAnalysisResponse } from "../contract/history-import.js";

/**
 * `POST /v1/ai/history-analysis`（Issue #157）の検証。
 *
 * Managed AI の fallback 経路であり、/v1/ai/responses と同じ利用枠を
 * 消費すること、上流の応答が構造を外れたときに握りつぶさないことを固定する。
 * 実際の AI は呼ばず、上流はフェッチのスタブで再現する。
 */

const ENV = {
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-3.6-flash",
} as unknown as CloudflareBindings;

function verifierFor(sub: string): AuthVerifier {
  return {
    verify: (token) =>
      token === "valid-token"
        ? Promise.resolve({ sub })
        : Promise.reject(new AuthVerificationError("invalid_token", "unexpected token in test")),
  };
}

let usage: InMemoryAiUsageRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

beforeEach(() => {
  usage = new InMemoryAiUsageRepository();
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use(
    "/v1/*",
    createAuth(() => verifierFor("auth0|user-a")),
  );
  app.route(
    "/v1",
    createAiRoute((env) => ({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      fetch: (input, init) => globalThis.fetch(input, init),
      usage,
      identity: new InMemoryIdentityRepository(),
      now: () => new Date("2026-09-22T10:00:00.000Z"),
    })),
  );
});

function analyze(body: unknown, token = "valid-token", env = ENV) {
  return app.request(
    "/v1/ai/history-analysis",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

const REQUEST = {
  conversations: [{ sourceId: "s1", title: "Go のポインタ", body: "pointer receiver とは？" }],
  knownConceptIds: ["go.pointer_receiver"],
};

/** generateContent 応答のスタブ。本文は JSON 文字列を text に入れる。 */
function stubUpstream(payload: unknown, init: { status?: number } = {}) {
  const body =
    typeof payload === "string"
      ? payload
      : JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
          usageMetadata: { totalTokenCount: 120 },
        });
  const fetchMock = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response(body, { status: init.status ?? 200 })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("会話を分析して構造化した観測を返す", async () => {
  stubUpstream({
    observations: [
      {
        sourceId: "s1",
        conceptCandidates: ["go.pointer_receiver"],
        kind: "question",
        confidence: 0.9,
        observedAt: "2025-01-01T00:00:00Z",
      },
    ],
  });

  const res = await analyze(REQUEST);

  expect(res.status).toBe(200);
  const body = (await res.json()) as HistoryAnalysisResponse;
  expect(body.observations).toHaveLength(1);
  expect(body.observations[0]?.sourceId).toBe("s1");
  expect(body.droppedObservations).toBe(0);
});

test("上流への送信に API キーを載せ、リダイレクトを追わない", async () => {
  const fetchMock = stubUpstream({ observations: [] });

  await analyze(REQUEST);

  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  // 資格情報を転送先へ流さない（RULE-002）。
  expect(init.redirect).toBe("error");
});

test("構造の合わない観測は落とし、件数を応答へ載せる", async () => {
  // 壊れた観測を黙って捨てると、利用者は「分析が一部欠けた」ことを
  // 知れない。droppedObservations で可視化する（RULE-004）。
  stubUpstream({
    observations: [
      { sourceId: "s1", conceptCandidates: ["go.x"], kind: "question", confidence: 0.5 },
      { sourceId: "s2", conceptCandidates: "not-an-array", kind: "question", confidence: 0.5 },
      { sourceId: "s3", conceptCandidates: [], kind: "unknown-kind", confidence: 2 },
    ],
  });

  const res = await analyze(REQUEST);

  expect(res.status).toBe(200);
  const body = (await res.json()) as HistoryAnalysisResponse;
  expect(body.observations).toHaveLength(1);
  expect(body.droppedObservations).toBe(2);
});

test("上流が非 JSON を返したら 502 にし、空の成功を装わない", async () => {
  stubUpstream("not json at all");

  const res = await analyze(REQUEST);

  expect(res.status).toBe(502);
});

test("上流が壊れた JSON 本文を返したら 502 にする", async () => {
  // generateContent 自体は 200 でも、生成物が JSON でない場合。
  const fetchMock = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "すみません" }] } }] }),
          { status: 200 },
        ),
      ),
    );
  vi.stubGlobal("fetch", fetchMock);

  const res = await analyze(REQUEST);

  expect(res.status).toBe(502);
});

test("上流の HTTP エラーは 502 にする", async () => {
  stubUpstream({}, { status: 500 });

  const res = await analyze(REQUEST);

  expect(res.status).toBe(502);
});

test("利用枠は /v1/ai/responses と同じ枠を消費する", async () => {
  stubUpstream({ observations: [] });

  await analyze(REQUEST);

  const usageNow = await usage.get({
    userId: "auth0|user-a",
    monthKey: "2026-09",
    dayKey: "2026-09-22",
  });
  expect(usageNow.monthlyRequests).toBe(1);
  // トークンは usageMetadata の実測値が積まれる。
  expect(usageNow.monthlyTokens).toBe(120);
});

test("上限に達していると上流を呼ばず 429 を返す", async () => {
  const fetchMock = stubUpstream({ observations: [] });
  // 枠を使い切った状態を先に作る。
  const now = "2026-09-22T10:00:00.000Z";
  for (let i = 0; i < AI_USAGE_LIMITS.dailyRequests; i++) {
    await usage.reserve({
      userId: "auth0|user-a",
      monthKey: "2026-09",
      dayKey: "2026-09-22",
      updatedAt: now,
      limits: {
        dailyRequests: AI_USAGE_LIMITS.dailyRequests,
        monthlyRequests: AI_USAGE_LIMITS.monthlyRequests,
      },
    });
  }

  const res = await analyze(REQUEST);

  expect(res.status).toBe(429);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("API キーが未設定なら 503", async () => {
  const env = {
    GEMINI_API_KEY: "",
    GEMINI_MODEL: "gemini-3.6-flash",
  } as unknown as CloudflareBindings;

  const res = await analyze(REQUEST, "valid-token", env);

  expect(res.status).toBe(503);
});

test("会話が0件のリクエストは 400", async () => {
  const res = await analyze({ conversations: [], knownConceptIds: [] });

  expect(res.status).toBe(400);
});

test("会話本文の上限を超えるリクエストは 400", async () => {
  const res = await analyze({
    conversations: [{ sourceId: "s1", body: "x".repeat(8_001) }],
    knownConceptIds: [],
  });

  expect(res.status).toBe(400);
});

test("認証が無ければ 401", async () => {
  const res = await analyze(REQUEST, "wrong-token");

  expect(res.status).toBe(401);
});
