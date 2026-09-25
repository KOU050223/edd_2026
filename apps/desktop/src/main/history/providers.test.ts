import { describe, expect, it } from "vitest";

import type { RawConversation } from "@gakushu-sochi/domain";

import {
  AnalysisProviderError,
  buildAnalysisPrompt,
  createCliAnalysisProvider,
  createManagedAnalysisProvider,
  parseAnalysisOutput,
  type CliRunner,
} from "./providers.js";

const CONV: RawConversation = { sourceId: "s1", body: "pointer receiver の話" };
const INPUT = { conversations: [CONV], knownConceptIds: ["go.pointer_receiver"] };

describe("buildAnalysisPrompt", () => {
  it("embeds sourceId, body, and known concept ids", () => {
    const prompt = buildAnalysisPrompt(INPUT);
    expect(prompt).toContain("conversation s1");
    expect(prompt).toContain("pointer receiver の話");
    expect(prompt).toContain("go.pointer_receiver");
  });
});

describe("parseAnalysisOutput", () => {
  it("parses a plain JSON object", () => {
    const result = parseAnalysisOutput(
      JSON.stringify({
        observations: [
          {
            sourceId: "s1",
            conceptCandidates: ["go.pointer_receiver"],
            kind: "explanation",
            confidence: 0.8,
          },
        ],
      }),
    );
    expect(result.observations).toHaveLength(1);
    expect(result.droppedObservations).toBe(0);
  });

  it("strips code fences and surrounding prose", () => {
    const result = parseAnalysisOutput('分析結果です\n```json\n{"observations": []}\n```\n以上');
    expect(result.observations).toEqual([]);
  });

  it("throws when the output is not a JSON object", () => {
    expect(() => parseAnalysisOutput("no json here")).toThrow(AnalysisProviderError);
    expect(() => parseAnalysisOutput("no json here")).toThrow(/JSON/);
  });

  it("throws when observations is missing", () => {
    expect(() => parseAnalysisOutput('{"foo": 1}')).toThrow(/observations/);
  });

  it("drops malformed observations and counts them", () => {
    const result = parseAnalysisOutput(
      JSON.stringify({
        observations: [
          { sourceId: "s1", conceptCandidates: ["x"], kind: "question", confidence: 0.5 },
          { sourceId: "bad", conceptCandidates: "not-an-array", kind: "question", confidence: 0.5 },
          { sourceId: "bad2", conceptCandidates: ["x"], kind: "weird", confidence: 0.5 },
          { sourceId: "bad3", conceptCandidates: ["x"], kind: "question", confidence: 2 },
        ],
      }),
    );
    expect(result.observations).toHaveLength(1);
    expect(result.droppedObservations).toBe(3);
  });
});

describe("createCliAnalysisProvider", () => {
  const spec = {
    id: "codex-cli",
    command: "codex",
    versionArgs: ["--version"],
    analyzeArgs: ["exec", "-"],
    timeoutMs: 5_000,
  };

  it("is available when the version probe succeeds", async () => {
    const runner: CliRunner = { run: () => Promise.resolve({ stdout: "codex 1.0" }) };
    const provider = createCliAnalysisProvider(spec, runner);
    expect(await provider.isAvailable()).toBe(true);
  });

  it("is unavailable when the command is missing", async () => {
    const runner: CliRunner = {
      run: () => Promise.reject(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })),
    };
    const provider = createCliAnalysisProvider(spec, runner);
    expect(await provider.isAvailable()).toBe(false);
  });

  it("passes the prompt on stdin and parses stdout", async () => {
    let seenInput = "";
    const runner: CliRunner = {
      run: (_command, _args, input) => {
        seenInput = input;
        return Promise.resolve({
          stdout: JSON.stringify({
            observations: [
              {
                sourceId: "s1",
                conceptCandidates: ["go.pointer_receiver"],
                kind: "explanation",
                confidence: 0.9,
              },
            ],
          }),
        });
      },
    };
    const provider = createCliAnalysisProvider(spec, runner);
    const result = await provider.analyze(INPUT);
    expect(seenInput).toContain("conversation s1");
    expect(result.observations).toHaveLength(1);
  });

  it("wraps non-zero exits in AnalysisProviderError", async () => {
    const runner: CliRunner = {
      run: () =>
        Promise.reject(
          new AnalysisProviderError("cli_failed", "codex が終了コード 1 で失敗しました。"),
        ),
    };
    const provider = createCliAnalysisProvider(spec, runner);
    await expect(provider.analyze(INPUT)).rejects.toMatchObject({ code: "cli_failed" });
  });
});

describe("createManagedAnalysisProvider", () => {
  function depsWith(response: { status: number; body: unknown }) {
    return {
      baseUrl: "https://api.example.test/v1",
      getAccessToken: () => Promise.resolve("token"),
      fetch: (() =>
        Promise.resolve(
          new Response(
            typeof response.body === "string" ? response.body : JSON.stringify(response.body),
            { status: response.status },
          ),
        )) as typeof fetch,
    };
  }

  it("is unavailable when no access token exists", async () => {
    const provider = createManagedAnalysisProvider({
      baseUrl: "https://api.example.test/v1",
      getAccessToken: () => Promise.reject(new Error("not logged in")),
      fetch: (() => Promise.reject(new Error("should not be called"))) as typeof fetch,
    });
    expect(await provider.isAvailable()).toBe(false);
  });

  it("sends conversations and returns observations", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const provider = createManagedAnalysisProvider({
      baseUrl: "https://api.example.test/v1",
      getAccessToken: () => Promise.resolve("token"),
      fetch: ((url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              observations: [
                {
                  sourceId: "s1",
                  conceptCandidates: ["go.pointer_receiver"],
                  kind: "question",
                  confidence: 0.7,
                },
              ],
              droppedObservations: 0,
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch,
    });
    const result = await provider.analyze(INPUT);
    expect(result.observations).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.example.test/v1/ai/history-analysis");
    expect(requests[0]?.init?.redirect).toBe("error");
    expect(requests[0]?.init?.signal).toBeDefined();
  });

  it("throws rate_limited on 429", async () => {
    const provider = createManagedAnalysisProvider(
      depsWith({ status: 429, body: { error: "limit", message: "上限" } }),
    );
    await expect(provider.analyze(INPUT)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("throws request_failed on other errors", async () => {
    const provider = createManagedAnalysisProvider(
      depsWith({ status: 503, body: { error: "not configured" } }),
    );
    await expect(provider.analyze(INPUT)).rejects.toMatchObject({ code: "request_failed" });
  });

  it("throws invalid_response when the body is not JSON", async () => {
    const provider = createManagedAnalysisProvider(depsWith({ status: 200, body: "<html>" }));
    await expect(provider.analyze(INPUT)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
