import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createAuth, type AuthVariables } from "../auth/middleware.js";
import type { AuthVerifier } from "../auth/verifier.js";
import { rateLimit } from "../auth/rate-limit.js";
import { AI_USAGE_LIMITS } from "../contract/ai-usage.js";
import { InMemoryAiUsageRepository } from "../repository/ai-usage.js";
import { InMemoryIdentityRepository } from "../repository/memory.js";
import type { AiUsageRepository } from "../repository/types.js";
import { createAiRoute } from "./ai.js";

const PROFILE_RATE_LIMITER = {
  limit: () => Promise.resolve({ success: true }),
} as unknown as RateLimit;

/**
 * 認証を通ったものとして固定の sub を返す検証器。
 *
 * 本物の `Auth0Verifier` は Discovery と JWKS の取得を伴う。ここで確かめたいのは
 * AI ルートの振る舞いなので、`createAuth` の継ぎ目（docs/auth.md §4）に
 * これを挿す。検証器そのものの検証は `verifier` 側の責務である。
 */
function verifierFor(sub: string): AuthVerifier {
  return {
    verify: (token) =>
      token === "valid-token"
        ? Promise.resolve({ sub })
        : Promise.reject(new Error("unexpected token in test")),
  };
}

/**
 * `waitUntil` に預けられた仕事を待てる ExecutionContext。
 *
 * 素の vitest は Worker ランタイムを持たないため、`c.executionCtx` は
 * テストから渡す必要がある。トークンの蓄積は応答を返した後に走るので、
 * 預けられた Promise を掴んでおかないと結果を確かめられない。
 */
function createExecutionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settled: () => Promise.all(pending) };
}

interface Harness {
  app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;
  usage: AiUsageRepository;
}

/** `app.ts` と同じ順序で、AI ルートに必要な分だけを組み立てる。 */
function buildApp(
  options: {
    sub?: string;
    usage?: AiUsageRepository;
    now?: () => Date;
  } = {},
): Harness {
  const usage = options.usage ?? new InMemoryAiUsageRepository();
  const identity = new InMemoryIdentityRepository();
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use(
    "/v1/*",
    createAuth(() => verifierFor(options.sub ?? "auth0|user-a")),
  );
  app.use(
    "/v1/ai/responses",
    rateLimit((env) => env.PROFILE_RATE_LIMITER),
  );
  app.route(
    "/v1",
    createAiRoute((env) => ({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      fetch: (input, init) => globalThis.fetch(input, init),
      usage,
      identity,
      now: options.now ?? (() => new Date("2026-09-22T10:00:00.000Z")),
    })),
  );
  return { app, usage };
}

const ENV = {
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-3.6-flash",
  PROFILE_RATE_LIMITER,
} as unknown as CloudflareBindings;

/** `usageMetadata` 付きの SSE を返す上流。値は累計である。 */
function stubUpstream(body: string) {
  const fetchMock = vi
    .fn()
    .mockImplementation(
      () =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        ) as Promise<Response>,
    );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const SSE_WITH_USAGE =
  'data: {"candidates":[{"content":{"parts":[{"text":"こん"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12}}\n\n' +
  'data: {"candidates":[{"content":{"parts":[{"text":"にちは"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}\n\n' +
  "data: [DONE]\n\n";

function ask(
  harness: Harness,
  body: Record<string, unknown>,
  ctx: ExecutionContext,
  env: CloudflareBindings = ENV,
) {
  return harness.app.request(
    "https://api.example.test/v1/ai/responses",
    {
      method: "POST",
      headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
    ctx,
  );
}

describe("POST /v1/ai/responses", () => {
  it("認証済みの質問を Gemini のストリームとして返す", async () => {
    const fetchMock = stubUpstream(SSE_WITH_USAGE);
    const harness = buildApp();
    const { ctx, settled } = createExecutionContext();

    const response = await ask(
      harness,
      {
        selection: "const answer = 42",
        question: "これは何ですか？",
        model: "gemini-3.6-flash",
        temperature: 0.3,
        maxTokens: 1024,
      },
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("[DONE]");
    await settled();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String((init as RequestInit | undefined)?.body))).toMatchObject({
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse",
      expect.objectContaining({ method: "POST" }),
    );
    vi.unstubAllGlobals();
  });

  it("本文を書き換えずにそのまま中継する", async () => {
    stubUpstream(SSE_WITH_USAGE);
    const harness = buildApp();
    const { ctx, settled } = createExecutionContext();

    const response = await ask(harness, { selection: "code", question: "explain" }, ctx);

    // 計測のために中身を加工すると、クライアントの解析がサーバー側の都合に依存する。
    expect(await response.text()).toBe(SSE_WITH_USAGE);
    await settled();
    vi.unstubAllGlobals();
  });

  it("API キー未設定をエラーとして返す", async () => {
    const harness = buildApp();
    const { ctx } = createExecutionContext();

    const response = await ask(harness, { selection: "code", question: "explain" }, ctx, {
      PROFILE_RATE_LIMITER,
    } as unknown as CloudflareBindings);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "AI service is not configured" });
  });

  it("選択文が空なら拒否する", async () => {
    const harness = buildApp();
    const { ctx } = createExecutionContext();

    const response = await ask(harness, { selection: "", question: "質問" }, ctx);

    expect(response.status).toBe(400);
  });

  it("質問が空なら解説依頼として Gemini に送る", async () => {
    const fetchMock = stubUpstream(SSE_WITH_USAGE);
    const harness = buildApp();
    const { ctx, settled } = createExecutionContext();

    const response = await ask(harness, { selection: "const answer = 42", question: "   " }, ctx);

    expect(response.status).toBe(200);
    await response.text();
    await settled();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(String((init as RequestInit | undefined)?.body)).toContain(
      "この選択テキストを初心者にも分かるように解説してください。",
    );
    vi.unstubAllGlobals();
  });

  describe("モデルの allowlist（docs/auth.md §10.1）", () => {
    it("許可外のモデルを拒否し、上流を呼ばない", async () => {
      const fetchMock = stubUpstream(SSE_WITH_USAGE);
      const harness = buildApp();
      const { ctx } = createExecutionContext();

      // 既定より単価の高いモデル（入力 $1.50 / 出力 $9.00）。
      const response = await ask(
        harness,
        { selection: "code", question: "explain", model: "gemini-3.5-flash" },
        ctx,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "model is not allowed" });
      // 拒否したのに課金だけ発生する、という状態を作らない。
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("許可外のモデルを拒否しても回数を消費しない", async () => {
      stubUpstream(SSE_WITH_USAGE);
      const harness = buildApp();
      const { ctx } = createExecutionContext();

      await ask(
        harness,
        { selection: "code", question: "explain", model: "gemini-3.5-flash" },
        ctx,
      );

      const usage = await harness.usage.get({
        userId: "auth0|user-a",
        monthKey: "2026-09",
        dayKey: "2026-09-22",
      });
      expect(usage.monthlyRequests).toBe(0);
      vi.unstubAllGlobals();
    });

    it("未指定なら GEMINI_MODEL を使う", async () => {
      const fetchMock = stubUpstream(SSE_WITH_USAGE);
      const harness = buildApp();
      const { ctx, settled } = createExecutionContext();

      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);

      expect(response.status).toBe(200);
      await response.text();
      await settled();
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("gemini-3.6-flash");
      vi.unstubAllGlobals();
    });
  });

  describe("1回あたりの上限（docs/architecture.md）", () => {
    it("入力が上限を超えたら、切り捨てずに理由付きで拒否する", async () => {
      const fetchMock = stubUpstream(SSE_WITH_USAGE);
      const harness = buildApp();
      const { ctx } = createExecutionContext();

      const response = await ask(
        harness,
        { selection: "あ".repeat(AI_USAGE_LIMITS.inputTokensPerRequest + 1), question: "" },
        ctx,
      );

      expect(response.status).toBe(400);
      // 黙って切ると、利用者から見て AI が文脈を読み落とした状態になる（RULE-004）。
      await expect(response.json()).resolves.toMatchObject({
        error: "input is too large",
        limitTokens: AI_USAGE_LIMITS.inputTokensPerRequest,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("政策値を超える maxTokens を拒否する", async () => {
      const fetchMock = stubUpstream(SSE_WITH_USAGE);
      const harness = buildApp();
      const { ctx } = createExecutionContext();

      const response = await ask(
        harness,
        {
          selection: "code",
          question: "explain",
          maxTokens: AI_USAGE_LIMITS.outputTokensPerRequest + 1,
        },
        ctx,
      );

      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("maxTokens 未指定でも出力上限を上流へ送る", async () => {
      const fetchMock = stubUpstream(SSE_WITH_USAGE);
      const harness = buildApp();
      const { ctx, settled } = createExecutionContext();

      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);
      await response.text();
      await settled();

      // 上流の既定値（上限なし）で走らせると、1回あたりの単価が決まらない。
      const [, init] = fetchMock.mock.calls[0] ?? [];
      expect(JSON.parse(String((init as RequestInit | undefined)?.body))).toMatchObject({
        generationConfig: { maxOutputTokens: AI_USAGE_LIMITS.outputTokensPerRequest },
      });
      vi.unstubAllGlobals();
    });
  });

  describe("利用量の蓄積", () => {
    it("消費トークン量を累計として記録する", async () => {
      stubUpstream(SSE_WITH_USAGE);
      const harness = buildApp();
      const { ctx, settled } = createExecutionContext();

      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);
      await response.text();
      await settled();

      const usage = await harness.usage.get({
        userId: "auth0|user-a",
        monthKey: "2026-09",
        dayKey: "2026-09-22",
      });
      expect(usage.monthlyRequests).toBe(1);
      expect(usage.dailyRequests).toBe(1);
      // 各チャンクの usageMetadata は累計なので、最後の値が総消費になる。
      expect(usage.monthlyTokens).toBe(15);
      vi.unstubAllGlobals();
    });

    it("usageMetadata が無ければ 0 とみなさず、見積もりを記録する", async () => {
      stubUpstream(
        'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\ndata: [DONE]\n\n',
      );
      const harness = buildApp();
      const { ctx, settled } = createExecutionContext();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);
      await response.text();
      await settled();

      const usage = await harness.usage.get({
        userId: "auth0|user-a",
        monthKey: "2026-09",
        dayKey: "2026-09-22",
      });
      // 0 を足すと、安全弁が「消費されていない」と判断し続ける（RULE-004）。
      expect(usage.monthlyTokens).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      vi.unstubAllGlobals();
    });

    it("ストリームを読み切らない呼び出しでも回数は消費される", async () => {
      stubUpstream(SSE_WITH_USAGE);
      const harness = buildApp();
      const { ctx } = createExecutionContext();

      // 本文を読まずに捨てる。完了を待ってから数える実装だと、これを
      // 繰り返すだけで上限を素通りできる。
      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);
      await response.body?.cancel();

      const usage = await harness.usage.get({
        userId: "auth0|user-a",
        monthKey: "2026-09",
        dayKey: "2026-09-22",
      });
      expect(usage.monthlyRequests).toBe(1);
      vi.unstubAllGlobals();
    });

    it("途中で中断してもトークンを記録する", async () => {
      stubUpstream(SSE_WITH_USAGE);
      const harness = buildApp();
      const { ctx, settled } = createExecutionContext();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);
      // 上流は既にそこまで生成しており、課金は発生している。中断するだけで
      // 安全弁をすり抜けられてはならない（`flush` は cancel 時に呼ばれない）。
      await response.body?.cancel();
      await settled();

      const usage = await harness.usage.get({
        userId: "auth0|user-a",
        monthKey: "2026-09",
        dayKey: "2026-09-22",
      });
      expect(usage.monthlyTokens).toBeGreaterThan(0);
      warn.mockRestore();
      vi.unstubAllGlobals();
    });
  });

  describe("上限に達したユーザーを止める（完了条件）", () => {
    /** 指定した回数を消費済みにする。 */
    async function seed(
      usage: AiUsageRepository,
      userId: string,
      count: number,
      keys: { monthKey: string; dayKey: string },
    ) {
      for (let i = 0; i < count; i += 1) {
        await usage.increment({ userId, ...keys, updatedAt: "2026-09-22T00:00:00.000Z" });
      }
    }

    it("日次上限に達したら 429 と回復時刻を返す", async () => {
      const fetchMock = stubUpstream(SSE_WITH_USAGE);
      const usage = new InMemoryAiUsageRepository();
      await seed(usage, "auth0|user-a", AI_USAGE_LIMITS.dailyRequests, {
        monthKey: "2026-09",
        dayKey: "2026-09-22",
      });
      const harness = buildApp({ usage });
      const { ctx } = createExecutionContext();

      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        error: "ai usage limit reached",
        limit: "daily",
        // 明日 UTC 0時に回復する。
        resetAt: "2026-09-23T00:00:00.000Z",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("上限到達の理由が利用者に伝わる文面を含む", async () => {
      stubUpstream(SSE_WITH_USAGE);
      const usage = new InMemoryAiUsageRepository();
      await seed(usage, "auth0|user-a", AI_USAGE_LIMITS.dailyRequests, {
        monthKey: "2026-09",
        dayKey: "2026-09-22",
      });
      const harness = buildApp({ usage });
      const { ctx } = createExecutionContext();

      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);
      const body = (await response.json()) as { message: string };

      expect(body.message).toContain("上限");
      // 上限を BYOK / Copilot への出口にする（docs/architecture.md）。
      expect(body.message).toContain("BYOK");
      vi.unstubAllGlobals();
    });

    it("月次上限に達したら 429 を返す", async () => {
      stubUpstream(SSE_WITH_USAGE);
      const usage = new InMemoryAiUsageRepository();
      // 日次上限に当たらないよう、日を跨いで積む。
      for (let day = 1; day <= 10; day += 1) {
        await seed(usage, "auth0|user-a", AI_USAGE_LIMITS.monthlyRequests / 10, {
          monthKey: "2026-09",
          dayKey: `2026-09-${String(day).padStart(2, "0")}`,
        });
      }
      const harness = buildApp({ usage });
      const { ctx } = createExecutionContext();

      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        limit: "monthly",
        resetAt: "2026-10-01T00:00:00.000Z",
      });
      vi.unstubAllGlobals();
    });

    it("トークンの安全弁に当たったら止め、回数と同じ見せ方をする", async () => {
      stubUpstream(SSE_WITH_USAGE);
      const usage = new InMemoryAiUsageRepository();
      await seed(usage, "auth0|user-a", 1, { monthKey: "2026-09", dayKey: "2026-09-22" });
      await usage.addTokens({
        userId: "auth0|user-a",
        monthKey: "2026-09",
        dayKey: "2026-09-22",
        tokens: AI_USAGE_LIMITS.monthlyTokens,
        updatedAt: "2026-09-22T00:00:00.000Z",
      });
      const harness = buildApp({ usage });
      const { ctx } = createExecutionContext();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);
      const body = (await response.json()) as { message: string };

      expect(response.status).toBe(429);
      // 内部の別勘定を利用者へ説明しない（docs/architecture.md「利用者への見せ方」）。
      expect(body.message).not.toContain("token");
      // 当たったこと自体が「想定が外れた」という信号なので、記録する。
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      vi.unstubAllGlobals();
    });

    it("上限に達したユーザーが他のユーザーを止めない", async () => {
      stubUpstream(SSE_WITH_USAGE);
      const usage = new InMemoryAiUsageRepository();
      await seed(usage, "auth0|user-a", AI_USAGE_LIMITS.dailyRequests, {
        monthKey: "2026-09",
        dayKey: "2026-09-22",
      });

      const blocked = await ask(
        buildApp({ usage, sub: "auth0|user-a" }),
        { selection: "code", question: "explain" },
        createExecutionContext().ctx,
      );
      expect(blocked.status).toBe(429);

      const other = createExecutionContext();
      const allowed = await ask(
        buildApp({ usage, sub: "auth0|user-b" }),
        { selection: "code", question: "explain" },
        other.ctx,
      );
      expect(allowed.status).toBe(200);
      await allowed.text();
      await other.settled();
      vi.unstubAllGlobals();
    });

    it("日が変わると日次の回数が回復する", async () => {
      stubUpstream(SSE_WITH_USAGE);
      const usage = new InMemoryAiUsageRepository();
      await seed(usage, "auth0|user-a", AI_USAGE_LIMITS.dailyRequests, {
        monthKey: "2026-09",
        dayKey: "2026-09-22",
      });
      const harness = buildApp({ usage, now: () => new Date("2026-09-23T00:00:01.000Z") });
      const { ctx, settled } = createExecutionContext();

      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);

      expect(response.status).toBe(200);
      await response.text();
      await settled();
      const after = await usage.get({
        userId: "auth0|user-a",
        monthKey: "2026-09",
        dayKey: "2026-09-23",
      });
      expect(after.dailyRequests).toBe(1);
      // 月次は跨いでいないので積み上がったまま。
      expect(after.monthlyRequests).toBe(AI_USAGE_LIMITS.dailyRequests + 1);
      vi.unstubAllGlobals();
    });

    it("残量を回数で返す。トークン数は返さない", async () => {
      stubUpstream(SSE_WITH_USAGE);
      const harness = buildApp();
      const { ctx, settled } = createExecutionContext();

      const response = await ask(harness, { selection: "code", question: "explain" }, ctx);

      expect(response.headers.get("X-AI-Requests-Remaining")).toBe(
        String(AI_USAGE_LIMITS.monthlyRequests - 1),
      );
      expect(response.headers.get("X-AI-Requests-Limit")).toBe(
        String(AI_USAGE_LIMITS.monthlyRequests),
      );
      await response.text();
      await settled();
      vi.unstubAllGlobals();
    });
  });
});
