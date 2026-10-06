import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_USAGE_LIMITS, type AllowedModel } from "../contract/ai-usage.js";
import { requestCheckGeneration, type UpstreamRequest } from "./upstream.js";

const PRIMARY: AllowedModel = "gemini-3.8-flash";
const FALLBACK: AllowedModel = "gemini-3.5-flash-lite";

/** 上流の応答を順に返す `fetch`。並びを使い切ったら最後の応答を返し続ける。 */
function fetchReturning(...responses: (() => Response | Promise<Response>)[]) {
  let index = 0;
  return vi.fn<typeof fetch>(() => {
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return Promise.resolve(next());
  });
}

const ok = () => new Response('{"candidates":[]}', { status: 200 });
const busy = () => new Response("busy", { status: 503 });

function request(
  fetchMock: ReturnType<typeof fetchReturning>,
  overrides: Partial<UpstreamRequest> = {},
): Promise<Awaited<ReturnType<typeof requestCheckGeneration>>> {
  return requestCheckGeneration({
    fetch: fetchMock,
    apiKey: "test-key",
    models: [PRIMARY],
    prompt: "PROMPT",
    retryDelaysMs: [0, 0],
    conceptId: "go.pointer_receiver",
    ...overrides,
  });
}

function sentModels(fetchMock: ReturnType<typeof fetchReturning>): string[] {
  return fetchMock.mock.calls.map(([url]) => {
    const match = /\/models\/([^:]+):generateContent$/.exec(String(url));
    return match?.[1] ?? "?";
  });
}

function silence(level: "warn" | "error") {
  return vi.spyOn(console, level).mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestCheckGeneration", () => {
  it("2xx の本文と、応答したモデルを返す", async () => {
    const fetchMock = fetchReturning(ok);

    await expect(request(fetchMock)).resolves.toEqual({
      ok: true,
      raw: '{"candidates":[]}',
      model: PRIMARY,
    });
  });

  it("タイムアウト・転送の不追跡・出力上限を付けて、キーをヘッダで送る", async () => {
    const fetchMock = fetchReturning(ok);

    await request(fetchMock);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${PRIMARY}:generateContent`,
    );
    // 単発の外向き fetch なので壁時計で切る（RULE-001）。
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // 資格情報を載せるのでリダイレクトを追跡しない（RULE-002）。Workers は
    // `redirect: "error"` を実装しておらず送信前に例外を投げるので `manual`（#253）。
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      contents: [{ parts: [{ text: "PROMPT" }] }],
      generationConfig: {
        maxOutputTokens: AI_USAGE_LIMITS.outputTokensPerRequest,
        responseMimeType: "application/json",
      },
    });
  });

  describe("送り直し", () => {
    it("混雑（503）のあとに同じモデルで送り直して成功する", async () => {
      silence("warn");
      const fetchMock = fetchReturning(busy, ok);

      const result = await request(fetchMock);

      expect(result).toMatchObject({ ok: true, model: PRIMARY });
      expect(sentModels(fetchMock)).toEqual([PRIMARY, PRIMARY]);
    });

    it("先頭のモデルが混雑なら、待たずに次のモデルへ送り、そのモデルを返す", async () => {
      // 混雑はモデルごとなので、同じモデルを待つより別のモデルへ回す（#268）。
      silence("warn");
      const fetchMock = fetchReturning(busy, ok);

      const result = await request(fetchMock, {
        models: [PRIMARY, FALLBACK],
        // 巡の間の待ちに入ったら終わらないようにして、待たずに次へ送ることを確かめる。
        retryDelaysMs: [60_000],
      });

      expect(result).toMatchObject({ ok: true, model: FALLBACK });
      expect(sentModels(fetchMock)).toEqual([PRIMARY, FALLBACK]);
    });

    it("500 も一時的な失敗として送り直す", async () => {
      silence("warn");
      const fetchMock = fetchReturning(() => new Response("oops", { status: 500 }), ok);

      await expect(request(fetchMock)).resolves.toMatchObject({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("混雑が続けば、待ち時間の数だけ送り直してから失敗を返す", async () => {
      silence("warn");
      silence("error");
      const fetchMock = fetchReturning(busy);

      const result = await request(fetchMock);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({
        ok: false,
        reason: "upstream-status",
        status: 503,
        trace: { attempts: 3, statuses: [503, 503, 503] },
      });
    });

    it("どのモデルも混雑なら、巡ごとに全部を試し、送った順のモデルを経過に残す", async () => {
      silence("warn");
      silence("error");
      const fetchMock = fetchReturning(busy);

      const result = await request(fetchMock, { models: [PRIMARY, FALLBACK] });

      // 待ち時間 2 つ → 3 巡 × 2 モデル。
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(result).toMatchObject({
        ok: false,
        trace: {
          attempts: 6,
          models: [PRIMARY, FALLBACK, PRIMARY, FALLBACK, PRIMARY, FALLBACK],
          statuses: [503, 503, 503, 503, 503, 503],
        },
      });
    });

    it.each([400, 429])("%i は送り直さず、次のモデルへも回さない", async (status) => {
      // 4xx は要求の誤り、429 は割り当て超過で、すぐ送り直しても直らない。
      silence("error");
      const fetchMock = fetchReturning(() => new Response("no", { status }));

      const result = await request(fetchMock, { models: [PRIMARY, FALLBACK] });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: false, reason: "upstream-status", status });
    });

    it("503 の本文が壊れていても、送り直す", async () => {
      // 本文を捨てる処理の失敗を、接続の失敗として扱わない。
      const warn = silence("warn");
      const broken = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection closed"));
            },
          }),
          { status: 503 },
        );
      const fetchMock = fetchReturning(broken, ok);

      await expect(request(fetchMock)).resolves.toMatchObject({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        "check generation could not discard an upstream body",
        expect.anything(),
      );
    });
  });

  describe("失敗", () => {
    it("転送（3xx）は追わずに失敗とする", async () => {
      // `redirect: "manual"` では 3xx がそのまま返る。API キーを転送先へ送り直さない（#253）。
      silence("error");
      const fetchMock = fetchReturning(
        () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
      );

      const result = await request(fetchMock);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: false, reason: "upstream-status", status: 302 });
    });

    it("届かなければ、例外の名前と文を経過に残す", async () => {
      const error = silence("error");
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.reject(new TypeError("network unreachable")),
      );

      const result = await request(fetchMock);

      expect(result).toMatchObject({
        ok: false,
        reason: "upstream-unreachable",
        trace: { attempts: 1, statuses: [], cause: "TypeError: network unreachable" },
      });
      expect(error).toHaveBeenCalled();
    });

    it("時間切れは upstream-timeout にする", async () => {
      silence("error");
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
      );

      const result = await request(fetchMock);

      expect(result).toMatchObject({ ok: false, reason: "upstream-timeout" });
    });

    it("2xx でも本文が読めなければ失敗とする", async () => {
      // 成功の状態コードで失敗を隠さない（RULE-004）。
      const error = silence("error");
      const fetchMock = fetchReturning(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("connection reset"));
              },
            }),
            { status: 200 },
          ),
      );

      const result = await request(fetchMock);

      expect(result).toMatchObject({
        ok: false,
        reason: "upstream-unreadable",
        trace: { attempts: 1, statuses: [200] },
      });
      expect(error).toHaveBeenCalledWith(
        "check generation upstream body could not be read",
        expect.anything(),
      );
    });
  });

  describe("上流のエラー本文", () => {
    it("Gemini のエラー本文から、状態・文・理由・割り当て・再試行の目安を取り出す", async () => {
      // 原因（混雑か割り当て超過か）を本番で切り分けるため（#253）。
      silence("error");
      const geminiError = JSON.stringify({
        error: {
          code: 403,
          message: "API key not valid.",
          status: "PERMISSION_DENIED",
          details: [
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }],
            },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "33s" },
          ],
        },
      });
      const fetchMock = fetchReturning(() => new Response(geminiError, { status: 403 }));

      const result = await request(fetchMock);

      expect(result).toMatchObject({
        ok: false,
        trace: {
          upstreamStatus: "PERMISSION_DENIED",
          upstreamMessage: "API key not valid.",
          upstreamReason: "API_KEY_INVALID",
          quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
          retryDelay: "33s",
          elapsedMs: expect.any(Number),
        },
      });
    });

    it("JSON でない本文は、そのまま文として残す", async () => {
      silence("error");
      const fetchMock = fetchReturning(() => new Response("  nope  ", { status: 400 }));

      const result = await request(fetchMock);

      expect(result).toMatchObject({ ok: false, trace: { upstreamMessage: "nope" } });
    });

    it("API キーらしい文字列を伏せ、長い文は切り詰める", async () => {
      silence("error");
      const message = `key=AIzaSyA1234567890abcdefghijklmnop ${"x".repeat(400)}`;
      const fetchMock = fetchReturning(
        () => new Response(JSON.stringify({ error: { message } }), { status: 400 }),
      );

      const result = await request(fetchMock);

      if (result.ok) throw new Error("失敗を期待した");
      const text = result.trace.upstreamMessage ?? "";
      expect(text).not.toContain("AIza");
      expect(text.startsWith("key=[redacted] ")).toBe(true);
      expect(text).toHaveLength(301);
      expect(text.endsWith("…")).toBe(true);
    });
  });
});
