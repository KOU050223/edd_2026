import { describe, expect, it, vi } from "vitest";
import type { AiUsageSummary } from "./ai-usage.js";
import { ApiError } from "./api.js";
import { MapLimitError } from "./learning-maps.js";
import {
  buildMapGenerateRequest,
  creationChecksSummary,
  CreationChecksError,
  generateCreationChecks,
  generateLearningMap,
  generationCost,
  MAP_GENERATE_PATH,
  MapConsentRequiredError,
  MapGenerationError,
  remainingRequests,
} from "./map-generation.js";

const MAP = {
  id: "mabcdefgh",
  title: "Go で Web API",
  description: "",
  visibility: "private",
  latestVersion: null,
  shareKey: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  updatedAt: "2026-10-08T00:00:00.000Z",
  nodes: [],
  edges: [],
  creationChecks: { status: "pending" },
};

const REQUEST = {
  kind: "goal",
  theme: "Go",
  goal: "Web API を作る",
  level: "basic",
  checks: true,
} as const;

describe("buildMapGenerateRequest", () => {
  it("前後の空白を落とし、分野の全体マップでは目標を送らない", () => {
    expect(
      buildMapGenerateRequest({ ...REQUEST, kind: "field", theme: " Kotlin ", goal: "残った目標" }),
    ).toEqual({ kind: "field", theme: "Kotlin", level: "basic", checks: true });
    expect(buildMapGenerateRequest({ ...REQUEST, goal: " Web API を作る " })).toEqual(REQUEST);
  });

  it("テーマが空、または目標までのマップで目標が空なら送れない", () => {
    expect(buildMapGenerateRequest({ ...REQUEST, theme: "  " })).toBeUndefined();
    expect(buildMapGenerateRequest({ ...REQUEST, goal: "" })).toBeUndefined();
  });
});

describe("回数", () => {
  const usage = (dailyUsed: number, monthlyUsed: number): AiUsageSummary => ({
    plan: "free",
    managedAi: {
      daily: { used: dailyUsed, limit: 15, resetAt: "2026-10-09T00:00:00.000Z" },
      monthly: { used: monthlyUsed, limit: 150, resetAt: "2026-11-01T00:00:00.000Z" },
    },
  });

  it("確認問題も作るなら倍の回数を使う", () => {
    expect(generationCost(false)).toBe(5);
    expect(generationCost(true)).toBe(10);
  });

  it("残りは日と月の小さい方で、0 未満にしない", () => {
    expect(remainingRequests(usage(3, 10))).toBe(12);
    expect(remainingRequests(usage(0, 145))).toBe(5);
    expect(remainingRequests(usage(16, 0))).toBe(0);
  });
});

describe("generateLearningMap", () => {
  it("要求を送り、作ったマップを返す", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe(MAP_GENERATE_PATH);
      expect(JSON.parse(String(init?.body))).toEqual({ ...REQUEST, consentVersion: 2 });
      return Response.json({ map: MAP }, { status: 201 });
    });

    await expect(generateLearningMap({ ...REQUEST, consentVersion: 2 }, fetcher)).resolves.toEqual(
      MAP,
    );
  });

  it("同意が無ければ、今の版を持つ例外にする", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: "map generation consent required", version: 2 }, { status: 403 }),
    );

    const error = await generateLearningMap(REQUEST, fetcher).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MapConsentRequiredError);
    expect((error as MapConsentRequiredError).version).toBe(2);
  });

  it("マップの数の上限と、API の文を添えた失敗を分ける", async () => {
    const limit = vi.fn(async () =>
      Response.json({ error: "learning_map_limit_reached", message: "…" }, { status: 409 }),
    );
    await expect(generateLearningMap(REQUEST, limit)).rejects.toBeInstanceOf(MapLimitError);

    const failed = vi.fn(async () =>
      Response.json(
        {
          error: "map generation failed",
          message: "AI が作ったマップが木の形になっていませんでした。",
        },
        { status: 502 },
      ),
    );
    const error = await generateLearningMap(REQUEST, failed).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MapGenerationError);
    expect((error as MapGenerationError).detail).toContain("木の形");

    // 回数の上限（429）も、API の文をそのまま出す。
    const usage = vi.fn(async () =>
      Response.json(
        { error: "ai usage limit reached", message: "残りが足りません。" },
        { status: 429 },
      ),
    );
    await expect(generateLearningMap(REQUEST, usage)).rejects.toMatchObject({
      detail: "残りが足りません。",
    });
  });

  it("2xx でもマップとして読めなければ失敗にする", async () => {
    const fetcher = vi.fn(async () => Response.json({ map: { id: "m" } }, { status: 201 }));

    await expect(generateLearningMap(REQUEST, fetcher)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("ログインの切れは共通の種別にする", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "session_expired" }, { status: 401 }));

    const error = await generateLearningMap(REQUEST, fetcher).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("session_expired");
  });
});

describe("generateCreationChecks", () => {
  it("マップの口へ送り、作った組と作れなかった数を返す", async () => {
    const result = { checks: [], failedCount: 1, skippedCount: 2 };
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      expect(url).toBe("/api/v1/learning-maps/mabcdefgh/checks:generate");
      return Response.json(result);
    });

    await expect(generateCreationChecks("mabcdefgh", fetcher)).resolves.toEqual(result);
  });

  it("全部失敗したときは、もう一度頼めるかを持つ例外にする", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: "creation checks failed", message: "もう一度だけ作り直せます。", retryable: true },
        { status: 502 },
      ),
    );

    const error = await generateCreationChecks("mabcdefgh", fetcher).catch(
      (value: unknown) => value,
    );

    expect(error).toBeInstanceOf(CreationChecksError);
    expect((error as CreationChecksError).retryable).toBe(true);
  });
});

describe("creationChecksSummary", () => {
  it("作れなかった組があるときだけ、その数と代わりの作り方を添える", () => {
    expect(
      creationChecksSummary({ checks: Array(10).fill({}), failedCount: 0, skippedCount: 0 }),
    ).toBe("確認問題を 10 組作りました。");
    expect(
      creationChecksSummary({ checks: Array(7).fill({}), failedCount: 1, skippedCount: 2 }),
    ).toContain("3 組は作れませんでした");
  });
});
