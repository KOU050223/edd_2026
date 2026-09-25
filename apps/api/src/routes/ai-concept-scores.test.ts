import { expect, test, vi } from "vitest";
import { Hono } from "hono";
import type { AuthVariables } from "../auth/middleware.js";
import { AUTHORIZED_HEADERS, stubAuth } from "../auth/test-auth.js";
import { AI_USAGE_LIMITS } from "../contract/ai-usage.js";
import { InMemoryAiUsageRepository } from "../repository/ai-usage.js";
import { InMemoryIdentityRepository } from "../repository/memory.js";
import type { AiUsageRepository, IdentityRepository } from "../repository/types.js";
import {
  DEFAULT_CONCEPT_THRESHOLD,
  JEV_MODEL,
  JEV_STATE_TOKEN_LIMIT,
  createAiConceptScoresRoute,
  type ConceptScoresBody,
} from "./ai-concept-scores.js";

/** テストで固定する時刻源の既定値。月・日のキーは "2026-01" / "2026-01-01" になる。 */
const NOW = new Date("2026-01-01T00:00:00.000Z");

/**
 * Jev の偽物。実物は問い合わせたすべての質問へ `answers` で応えるため、
 * ここでも `questions` のキーを全部拾って `noul` を返す。
 * `scores` に無いキーは 0（不採用側）を返す。
 */
function stubJev(scores: Record<string, number>) {
  return vi.fn(async (_model: string, inputs: Record<string, unknown>) => {
    const questions = (inputs as { questions: Record<string, unknown> }).questions;
    return {
      model: "jev-1.13.0",
      answers: Object.fromEntries(
        Object.keys(questions).map((key) => [key, { type: "noul", noul: scores[key] ?? 0 }]),
      ),
      usage: { input_tokens: 500, output_tokens: 60 },
    };
  });
}

/**
 * ルートをテスト用の Hono app へ載せる。実際と同じ認証 middleware と
 * 依存の差し替え方（resolver へ偽物を渡す）で組み立てる。
 */
function buildApp(
  options: {
    ai?: Ai;
    usage?: AiUsageRepository;
    identity?: IdentityRepository;
    now?: () => Date;
  } = {},
) {
  const run = stubJev({});
  const ai = options.ai ?? ({ run } as unknown as Ai);
  const usage = options.usage ?? new InMemoryAiUsageRepository();
  const identity = options.identity ?? new InMemoryIdentityRepository();
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  app.route(
    "/v1",
    createAiConceptScoresRoute(() => ({
      ai,
      usage,
      identity,
      now: options.now ?? (() => NOW),
    })),
  );
  return { app, run, usage };
}

/** `POST /v1/ai/concept-scores` へ JSON を投げる。既定は認証済みのリクエスト。 */
function ask(
  app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>,
  body: Record<string, unknown>,
  headers: Record<string, string> = AUTHORIZED_HEADERS,
) {
  return app.request("https://api.example.test/v1/ai/concept-scores", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("Concept ごとの score と、閾値を超えた Concept ID を返す", async () => {
  const run = stubJev({ "go.defer": 0.9, "go.channel": 0.1 });
  const { app } = buildApp({ ai: { run } as unknown as Ai });

  const response = await ask(app, { selection: "defer f()", languageId: "go" });
  const body = (await response.json()) as ConceptScoresBody;

  expect(response.status).toBe(200);
  expect(run).toHaveBeenCalledWith(
    JEV_MODEL,
    expect.objectContaining({ state: { code: "defer f()", language: "go" } }),
  );
  expect(body.conceptIds).toEqual(["go.defer"]);
  // scores は score の降順。採用されなかった Concept の値も比較材料として残す。
  expect(body.scores.slice(0, 2)).toEqual([
    { conceptId: "go.defer", score: 0.9 },
    { conceptId: "go.channel", score: 0.1 },
  ]);
  expect(body.scores.slice(2).every((s: { score: number }) => s.score === 0)).toBe(true);
  expect(body.threshold).toBe(DEFAULT_CONCEPT_THRESHOLD);
  expect(body.model).toBe("jev-1.13.0");
  expect(body.usage).toEqual({ inputTokens: 500, outputTokens: 60 });
  expect(typeof body.latencyMs).toBe("number");
});

test("判定結果を Workers Logs から追えるよう、採用結果と計測値をログに残す", async () => {
  const run = stubJev({ "go.defer": 0.9, "go.channel": 0.1 });
  const { app } = buildApp({ ai: { run } as unknown as Ai });
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  const response = await ask(app, { selection: "defer f()", languageId: "go" });

  expect(response.status).toBe(200);
  // 比較材料として全 Concept の score を残す。コード本文・質問文は
  // プライバシー方針上ログへ出さない（docs/architecture.md「データとプライバシー」）。
  expect(log).toHaveBeenCalledWith(
    "ai concept scoring completed",
    expect.objectContaining({
      userId: "user-a",
      model: "jev-1.13.0",
      languageId: "go",
      threshold: DEFAULT_CONCEPT_THRESHOLD,
      conceptIds: ["go.defer"],
      usage: { inputTokens: 500, outputTokens: 60 },
      latencyMs: 0,
    }),
  );
  const scores = (log.mock.calls[0]?.[1] as ConceptScoresBody).scores;
  expect(scores).toContainEqual({ conceptId: "go.defer", score: 0.9 });
  expect(JSON.stringify(log.mock.calls[0]?.[1])).not.toContain("defer f()");
  log.mockRestore();
});

test("Concept ごとに noul の質問を組み立て、languageId に対応する Concept だけを問い合わせる", async () => {
  const run = stubJev({});
  const { app } = buildApp({ ai: { run } as unknown as Ai });

  await ask(app, { selection: "go func() {}", languageId: "go" });

  const [, inputs] = run.mock.calls[0] ?? [];
  const questions = (inputs as { questions: Record<string, unknown> }).questions;
  // 対象は「既知の概念一覧」と同じ集合。go の質問なら go.* と領域横断だけ。
  expect(Object.keys(questions)).toContain("go.defer");
  expect(Object.keys(questions)).toContain("git.commit");
  expect(Object.keys(questions)).not.toContain("ts.async_await");
  expect(questions["go.defer"]).toMatchObject({
    type: "noul",
    criteria: { true: expect.any(String), false: expect.any(String) },
  });
  expect(String((questions["go.defer"] as { instructions: string }).instructions)).toContain(
    "go.defer",
  );
});

test("閾値ちょうどは採用し、直下は採用しない", async () => {
  const run = stubJev({
    "go.defer": DEFAULT_CONCEPT_THRESHOLD,
    "go.channel": DEFAULT_CONCEPT_THRESHOLD - 0.01,
  });
  const { app } = buildApp({ ai: { run } as unknown as Ai });

  const response = await ask(app, { selection: "code", languageId: "go" });
  const body = (await response.json()) as ConceptScoresBody;

  expect(body.conceptIds).toEqual(["go.defer"]);
});

test("閾値はリクエストで変えられる", async () => {
  const run = stubJev({ "go.defer": 0.5 });
  const { app } = buildApp({ ai: { run } as unknown as Ai });

  const response = await ask(app, { selection: "code", languageId: "go", threshold: 0.4 });
  const body = (await response.json()) as ConceptScoresBody;

  expect(response.status).toBe(200);
  expect(body.threshold).toBe(0.4);
  expect(body.conceptIds).toEqual(["go.defer"]);
});

test("呼び出しは ai_usage の回数枠に数える", async () => {
  const usage = new InMemoryAiUsageRepository();
  const { app } = buildApp({ usage });

  const response = await ask(app, { selection: "code", languageId: "go" });

  expect(response.status).toBe(200);
  // PoC の間は Managed AI（/v1/ai/responses）と同じ日次・月次の枠を共有する。
  // Workers AI 側に累積上限が無いと、認証済みならコストを積み上げ放題になる。
  const after = await usage.get({ userId: "user-a", monthKey: "2026-01", dayKey: "2026-01-01" });
  expect(after.monthlyRequests).toBe(1);
  expect(after.dailyRequests).toBe(1);
});

test("ai_usage の上限に達していれば上流を呼ばず 429 を返す", async () => {
  const usage = new InMemoryAiUsageRepository();
  for (let i = 0; i < AI_USAGE_LIMITS.dailyRequests; i++) {
    await usage.reserve({
      userId: "user-a",
      monthKey: "2026-01",
      dayKey: "2026-01-01",
      updatedAt: NOW.toISOString(),
      limits: {
        dailyRequests: AI_USAGE_LIMITS.dailyRequests,
        monthlyRequests: AI_USAGE_LIMITS.monthlyRequests,
      },
    });
  }
  const run = stubJev({});
  const { app } = buildApp({ usage, ai: { run } as unknown as Ai });

  const response = await ask(app, { selection: "code", languageId: "go" });

  expect(response.status).toBe(429);
  await expect(response.json()).resolves.toMatchObject({
    error: "ai usage limit reached",
    limit: "daily",
  });
  expect(run).not.toHaveBeenCalled();
});

test("AI のバインドが無ければ 503 を返し、運営側の障害としてログに残す", async () => {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  app.route(
    "/v1",
    createAiConceptScoresRoute(() => ({
      usage: new InMemoryAiUsageRepository(),
      identity: new InMemoryIdentityRepository(),
      now: () => NOW,
    })),
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const response = await ask(app, { selection: "code", languageId: "go" });

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({ error: "AI service is not configured" });
  expect(error).toHaveBeenCalledWith("ai service is not configured", {
    path: "/v1/ai/concept-scores",
  });
  error.mockRestore();
});

test("評価そのものが失敗したら 502 を返し、AI 経路のエラーとしてログに残す", async () => {
  const cause = new Error("jev is unavailable");
  const { app } = buildApp({
    ai: { run: vi.fn(async () => Promise.reject(cause)) } as unknown as Ai,
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const response = await ask(app, { selection: "code", languageId: "go" });

  expect(response.status).toBe(502);
  await expect(response.json()).resolves.toEqual({ error: "AI upstream request failed" });
  expect(error).toHaveBeenCalledWith(
    "ai concept scoring failed",
    expect.objectContaining({ userId: "user-a" }),
  );
  error.mockRestore();
});

test("問い合わせた Concept の答えが応答に無ければ、黙って落とさず 502 にする", async () => {
  // go.defer を問い合わせたのに answers に無い、という形を再現する。
  // 落とした Concept をスコア 0 として扱うと false negative を埋めてしまう（RULE-004）。
  const run = vi.fn(async () => ({
    answers: { "go.defer": { type: "noul", noul: 0.9 } },
  }));
  const { app } = buildApp({ ai: { run } as unknown as Ai });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const response = await ask(app, { selection: "code", languageId: "go" });

  expect(response.status).toBe(502);
  expect(error).toHaveBeenCalledWith(
    "ai concept scoring returned an unexpected response",
    expect.objectContaining({ userId: "user-a" }),
  );
  error.mockRestore();
});

test("答えの形が壊れていても 502 を返す", async () => {
  const run = vi.fn(async () => ({
    answers: { "go.defer": { type: "noul", noul: "high" } },
  }));
  const { app } = buildApp({ ai: { run } as unknown as Ai });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const response = await ask(app, { selection: "code", languageId: "go" });

  expect(response.status).toBe(502);
  error.mockRestore();
});

test("分類対象が空なら上流を呼ばずに拒否する", async () => {
  const run = stubJev({});
  const { app } = buildApp({ ai: { run } as unknown as Ai });

  const response = await ask(app, { selection: "", languageId: "go" });

  expect(response.status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});

test("state が Jev の入力上限を超える見積もりなら、切り捨てずに拒否する", async () => {
  const run = stubJev({});
  const { app } = buildApp({ ai: { run } as unknown as Ai });
  // スキーマの文字数上限（20,000）を超えない範囲でバイト数の見積もりを超える
  // 入力にする。UTF-8 で3バイトの文字なら ceil(28,000 / 3) 字で上限を越える。
  const response = await ask(app, {
    selection: "あ".repeat(Math.ceil(JEV_STATE_TOKEN_LIMIT / 3)),
    languageId: "go",
  });

  // 黙って切ると、見えないところで文脈を読み落とした分類になる（RULE-004）。
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: "input is too large" });
  expect(run).not.toHaveBeenCalled();
});

test("未認証のリクエストは 401 を返す", async () => {
  const { app } = buildApp();

  const response = await ask(app, { selection: "code", languageId: "go" }, {});

  expect(response.status).toBe(401);
});
