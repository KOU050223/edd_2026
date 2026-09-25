import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createAuth, type AuthVariables } from "../auth/middleware.js";
import type { AuthVerifier } from "../auth/verifier.js";
import { AI_USAGE_LIMITS } from "../contract/ai-usage.js";
import { InMemoryAiUsageRepository } from "../repository/ai-usage.js";
import { InMemoryIdentityRepository } from "../repository/memory.js";
import type { AiUsageRepository } from "../repository/types.js";
import { createAiRoute } from "./ai.js";
import { createChecksRoute } from "./checks.js";

const CONCEPT_ID = "go.pointer_receiver";
const NOW = new Date("2026-09-26T09:00:00.000Z");

const PASSING_LIMITER = {
  limit: () => Promise.resolve({ success: true }),
} as unknown as RateLimit;

const BLOCKING_LIMITER = {
  limit: () => Promise.resolve({ success: false }),
} as unknown as RateLimit;

/** 認証を通ったものとして固定の sub を返す検証器（`ai.test.ts` と同じ継ぎ目）。 */
function verifierFor(sub: string): AuthVerifier {
  return {
    verify: (token) =>
      token === "valid-token"
        ? Promise.resolve({ sub })
        : Promise.reject(new Error("unexpected token in test")),
  };
}

interface Harness {
  app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;
  usage: AiUsageRepository;
}

/**
 * `app.ts` が #185 で行う予定の組み立てを、生成ルートの分だけ先に作る。
 *
 * AI ルートも同じ `AiUsageRepository` へ載せる。生成が回数を消費していないことを、
 * 利用者向けの読み取り（`GET /v1/ai/usage`）から確かめられるようにするため。
 */
function buildApp(): Harness {
  const usage = new InMemoryAiUsageRepository();
  const identity = new InMemoryIdentityRepository();
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use(
    "/v1/*",
    createAuth(() => verifierFor("auth0|user-a")),
  );
  app.route(
    "/v1",
    createChecksRoute((env) => ({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      fetch: (input, init) => globalThis.fetch(input, init),
      now: () => NOW,
    })),
  );
  app.route(
    "/v1",
    createAiRoute((env) => ({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      fetch: (input, init) => globalThis.fetch(input, init),
      usage,
      identity,
      now: () => NOW,
    })),
  );
  return { app, usage };
}

const ENV = {
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-3.6-flash",
  PROFILE_RATE_LIMITER: PASSING_LIMITER,
} as unknown as CloudflareBindings;

function question(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "値レシーバのメソッドで状態を変えたとき、呼び出し元の値はどうなるか。",
    choices: ["変わらない", "変わる", "コンパイルできない", "実行時に落ちる"],
    answerIndex: 0,
    explanation: "値レシーバには複製が渡るため、呼び出し元の値は変わらない。",
    ...overrides,
  };
}

function generatedCheck(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    conceptId: CONCEPT_ID,
    overview: question(),
    practice: question({ code: "func (c Counter) Add() { c.n++ }" }),
    ...overrides,
  });
}

/** 上流の `generateContent` の応答を差し替える。 */
function stubUpstream(text: string, totalTokenCount = 900) {
  const body = JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { totalTokenCount },
    modelVersion: "gemini-3.6-flash",
  });
  const fetchMock = vi
    .fn()
    .mockImplementation(
      () =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
        ) as Promise<Response>,
    );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function generate(
  harness: Harness,
  body: Record<string, unknown> = { conceptId: CONCEPT_ID },
  env: CloudflareBindings = ENV,
) {
  return harness.app.request(
    "https://api.example.test/v1/checks:generate",
    {
      method: "POST",
      headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

/** 生成のコストが載る唯一の記録なので、テスト中は黙らせた上で内容を確かめる。 */
function silenceInfo() {
  return vi.spyOn(console, "info").mockImplementation(() => undefined);
}

function silenceError() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /v1/checks:generate", () => {
  it("概要問題と実践問題の2問を返す", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();

    const response = await generate(buildApp());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      conceptId: CONCEPT_ID,
      overview: question(),
      practice: question({ code: "func (c Counter) Add() { c.n++ }" }),
      model: "gemini-3.6-flash",
      generatedAt: NOW.toISOString(),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("上流へはタイムアウトと出力上限を付けて送る", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();

    await generate(buildApp());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    );
    // 単発の外向き fetch なので壁時計で切る（RULE-001）。
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // 資格情報を載せるのでリダイレクトを追跡しない（RULE-002）。
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toMatchObject({
      generationConfig: {
        maxOutputTokens: AI_USAGE_LIMITS.outputTokensPerRequest,
        responseMimeType: "application/json",
      },
    });
  });

  it("プロンプトに Concept の定義だけを載せ、個人の情報を送らない", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    silenceInfo();

    await generate(buildApp());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = String(init.body);
    expect(sent).toContain(CONCEPT_ID);
    // コード本文・質問文・AI の回答文も、習熟度も渡さない（#184 の完了条件）。
    for (const forbidden of ["score", "status", "evidence", "diagnosticCode", "selection"]) {
      expect(sent).not.toContain(forbidden);
    }
  });

  it("ai_usage の回数を加算しない", async () => {
    // 生成は全利用者で使い回す問題を作る。最初に開いた利用者の枠から引かない（#184）。
    stubUpstream(generatedCheck());
    silenceInfo();
    const harness = buildApp();

    await generate(harness);

    const usage = await harness.app.request(
      "https://api.example.test/v1/ai/usage",
      { headers: { Authorization: "Bearer valid-token" } },
      ENV,
    );
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({
      managedAi: {
        daily: { used: 0, limit: AI_USAGE_LIMITS.dailyRequests },
        monthly: { used: 0, limit: AI_USAGE_LIMITS.monthlyRequests },
      },
    });
  });

  it("生成にかかったトークンをログへ残す", async () => {
    // `ai_usage` に載らないため、これが生成のコストを追える唯一の記録である。
    stubUpstream(generatedCheck(), 1500);
    const info = silenceInfo();

    await generate(buildApp());

    expect(info).toHaveBeenCalledWith(
      "check generation completed",
      expect.objectContaining({ conceptId: CONCEPT_ID, totalTokens: 1500 }),
    );
  });

  it("一覧に無い conceptId は弾く", async () => {
    const fetchMock = stubUpstream(generatedCheck());

    const response = await generate(buildApp(), { conceptId: "go.not_defined" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "unknown concept" });
    // 上流を叩く前に弾く。ここが生成回数の上界になっている。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Concept ID の形式を満たさない要求を弾く", async () => {
    const response = await generate(buildApp(), { conceptId: "Go.PointerReceiver" });

    expect(response.status).toBe(400);
  });

  it("認証が無ければ生成しない", async () => {
    const response = await buildApp().app.request(
      "https://api.example.test/v1/checks:generate",
      { method: "POST", body: JSON.stringify({ conceptId: CONCEPT_ID }) },
      ENV,
    );

    expect(response.status).toBe(401);
  });

  it("レート制限は維持する", async () => {
    // `ai_usage` の回数は数えないが、頻度の歯止めは残す（#184 の決定表）。
    const fetchMock = stubUpstream(generatedCheck());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await generate(buildApp(), { conceptId: CONCEPT_ID }, {
      ...ENV,
      PROFILE_RATE_LIMITER: BLOCKING_LIMITER,
    } as unknown as CloudflareBindings);

    expect(response.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("許可していないモデルの設定では生成しない", async () => {
    const fetchMock = stubUpstream(generatedCheck());
    const error = silenceError();

    const response = await generate(buildApp(), { conceptId: CONCEPT_ID }, {
      ...ENV,
      GEMINI_MODEL: "gemini-3.5-pro-expensive",
    } as unknown as CloudflareBindings);

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("API キー未設定は運営側の障害として記録する", async () => {
    const error = silenceError();

    const response = await generate(buildApp(), { conceptId: CONCEPT_ID }, {
      PROFILE_RATE_LIMITER: PASSING_LIMITER,
    } as unknown as CloudflareBindings);

    expect(response.status).toBe(503);
    expect(error).toHaveBeenCalled();
  });

  it("上流の失敗は 502 として返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(new Response("nope", { status: 500 }))),
    );
    const error = silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    expect(error).toHaveBeenCalled();
  });

  it("上流へ届かなかった場合も 502 として返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.reject(new Error("timed out"))),
    );
    const error = silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    expect(error).toHaveBeenCalled();
  });

  it("2問揃わない応答を受理せず、理由を利用者へ伝える", async () => {
    stubUpstream(JSON.stringify({ conceptId: CONCEPT_ID, overview: question() }));
    silenceInfo();
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    const body = (await response.json()) as { reason: string; message: string };
    expect(body.reason).toBe("shape");
    expect(body.message).toContain("2問1組");
    // 検証の詳細（モデルの応答の断片）は利用者へ返さない。
    expect(Object.keys(body).sort()).toEqual(["error", "message", "reason"]);
  });

  it("正解が選択肢に無い応答を受理せず、理由を利用者へ伝える", async () => {
    stubUpstream(generatedCheck({ overview: question({ answerIndex: 9 }) }));
    silenceInfo();
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      reason: "answer-out-of-range",
      message: expect.stringContaining("正解が選択肢"),
    });
  });

  it("別の Concept の問題を受理しない", async () => {
    stubUpstream(generatedCheck({ conceptId: "go.slice_append" }));
    silenceInfo();
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ reason: "concept-mismatch" });
  });

  it("問題として読めない応答を受理しない", async () => {
    stubUpstream("ごめんなさい、問題を作れませんでした。");
    silenceInfo();
    silenceError();

    const response = await generate(buildApp());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ reason: "not-json" });
  });
});
