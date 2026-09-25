import { expect, test, vi } from "vitest";
import { Hono } from "hono";
import type { AuthVariables } from "../auth/middleware.js";
import { AUTHORIZED_HEADERS, stubAuth } from "../auth/test-auth.js";
import {
  DEFAULT_CONCEPT_THRESHOLD,
  JEV_MODEL,
  JEV_STATE_TOKEN_LIMIT,
  createAiConceptScoresRoute,
  type ConceptScoresBody,
} from "./ai-concept-scores.js";

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

function buildApp(options: { ai?: Ai; now?: () => number } = {}) {
  const run = stubJev({});
  const ai = options.ai ?? ({ run } as unknown as Ai);
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  app.route(
    "/v1",
    createAiConceptScoresRoute(() => ({ ai, now: options.now ?? (() => 1000) })),
  );
  return { app, run };
}

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

test("AI のバインドが無ければ 503 を返し、運営側の障害としてログに残す", async () => {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth("user-a"));
  app.route(
    "/v1",
    createAiConceptScoresRoute(() => ({ now: () => 1000 })),
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
