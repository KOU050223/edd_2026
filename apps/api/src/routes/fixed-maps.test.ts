import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Concept } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { stubAuth } from "../auth/test-auth.js";
import { planLimits, utcDayKey, utcMonthKey } from "../contract/ai-usage.js";
import type {
  GenerateFixedObjectivesResponse,
  PutFixedObjectivesResponse,
} from "../contract/fixed-maps.js";
import { InMemoryAiUsageRepository } from "../repository/ai-usage.js";
import { InMemoryFixedMapCreatorRepository } from "../repository/fixed-map-creators.js";
import {
  createInMemoryRepositoryStore,
  InMemoryAuditLogRepository,
  InMemoryIdentityRepository,
  InMemoryLearningMapRepository,
  InMemoryPersonalCheckRepository,
  type InMemoryRepositoryStore,
} from "../repository/memory.js";
import { InMemoryUserPlanRepository } from "../repository/user-plans.js";
import { personalCheck } from "../maps/test-map.js";
import { createFixedMapsRoute } from "./fixed-maps.js";

const NOW = new Date("2026-10-08T09:00:00.000Z");
const USAGE_KEYS = { monthKey: utcMonthKey(NOW), dayKey: utcDayKey(NOW) };
const TOKENS = { "token-a": "user-a", "token-b": "user-b" };

const concept = (id: string, label: string): Concept => ({
  id,
  label,
  language: id.split(".")[0]!,
  summary: `${label}の概要。`,
  prerequisites: [],
  source: { kind: "manual" },
});

/** go は 2 件（学ぶ順）、ts は 1 件。 */
const FIXED_CONCEPTS = [
  concept("go.defer", "defer"),
  concept("go.goroutine", "goroutine"),
  concept("ts.type", "型"),
];

let store: InMemoryRepositoryStore;
let maps: InMemoryLearningMapRepository;
let creators: InMemoryFixedMapCreatorRepository;
let usage: InMemoryAiUsageRepository;
let keys: number;
let fetchMock: ReturnType<typeof vi.fn>;
/** 頼まれた Concept ID から、AI の応答の本文を作る。テストごとに差し替える。 */
let objectivesFor: (conceptIds: string[]) => unknown;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

function upstreamBody(text: string) {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { totalTokenCount: 1_000 },
    modelVersion: "gemini-3.6-flash",
  });
}

function promptOf(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body)) as {
    contents: { parts: { text: string }[] }[];
  };
  return body.contents[0]!.parts[0]!.text;
}

/** プロンプトに並べた Concept の ID（`<ID>|表示名|概要` の行）。 */
function conceptIdsInPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/^([a-z0-9]+\.[a-z0-9_]+)\|/gm)].map((match) => match[1]!);
}

beforeEach(() => {
  store = createInMemoryRepositoryStore();
  store.fixedObjectives.splice(
    0,
    store.fixedObjectives.length,
    { id: "go.defer:timing", conceptId: "go.defer", label: "実行タイミング", source: "manual" },
    { id: "go.defer:lifo", conceptId: "go.defer", label: "実行順", source: "manual" },
    { id: "go.defer:named", conceptId: "go.defer", label: "名前付き戻り値", source: "manual" },
  );
  maps = new InMemoryLearningMapRepository(store);
  creators = new InMemoryFixedMapCreatorRepository();
  creators.add("go", "user-a");
  usage = new InMemoryAiUsageRepository();
  keys = 0;
  // 既定: 今ある項目の1つ目を表示名を変えて引き継ぎ、2つ目はそのまま、3つ目は落とし、1つ足す。
  objectivesFor = (conceptIds) => ({
    nodes: conceptIds.map((key) =>
      key === "go.defer"
        ? {
            key,
            objectives: [
              { id: "go.defer:timing", label: "関数を抜けるときに実行される" },
              { id: "go.defer:lifo", label: "実行順" },
              { label: "引数はその場で評価される" },
            ],
          }
        : { key, objectives: [{ label: `${key} の項目1` }, { label: `${key} の項目2` }] },
    ),
  });
  fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      new Response(
        upstreamBody(JSON.stringify(objectivesFor(conceptIdsInPrompt(promptOf(init))))),
        { status: 200 },
      ),
    ),
  );
  const identity = new InMemoryIdentityRepository(store);
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(TOKENS));
  app.route(
    "/v1",
    createFixedMapsRoute(() => ({
      identity,
      maps,
      creators,
      audit: new InMemoryAuditLogRepository(store),
      fixedConcepts: FIXED_CONCEPTS,
      newKey: () => `k${String(++keys).padStart(7, "0")}`,
      nowIso: () => NOW.toISOString(),
      nowMs: () => NOW.getTime(),
      generation: {
        apiKey: "test-key",
        model: "gemini-3.6-flash",
        fetch: fetchMock as unknown as typeof fetch,
        usage,
        plans: new InMemoryUserPlanRepository(),
        retryDelaysMs: [],
        now: () => NOW,
      },
    })),
  );
});

function send(method: string, path: string, body?: unknown, token = "token-a") {
  return app.request(
    `/v1${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {} as CloudflareBindings,
  );
}

async function usedRequests() {
  return (await usage.get({ userId: "user-a", ...USAGE_KEYS })).dailyRequests;
}

describe("POST /v1/fixed-maps/:language/objectives:generate", () => {
  it("今ある項目を AI に渡し、引き継ぐ・新しく作る・消えるの差分を返す。保存はしない", async () => {
    const before = await maps.listFixedObjectives();

    const res = await send("POST", "/fixed-maps/go/objectives:generate", {});

    expect(res.status).toBe(200);
    const body = (await res.json()) as GenerateFixedObjectivesResponse;
    expect(body.concepts).toEqual([
      {
        conceptId: "go.defer",
        objectives: [
          {
            kind: "kept",
            id: "go.defer:timing",
            label: "関数を抜けるときに実行される",
            previousLabel: "実行タイミング",
          },
          { kind: "kept", id: "go.defer:lifo", label: "実行順", previousLabel: "実行順" },
          { kind: "new", label: "引数はその場で評価される" },
        ],
        removed: [{ id: "go.defer:named", label: "名前付き戻り値" }],
      },
      {
        conceptId: "go.goroutine",
        objectives: [
          { kind: "new", label: "go.goroutine の項目1" },
          { kind: "new", label: "go.goroutine の項目2" },
        ],
        removed: [],
      },
    ]);
    // 今ある項目の ID と表示名をプロンプトに載せる（決定 M5）。
    const prompt = promptOf(fetchMock.mock.calls[0]![1] as RequestInit);
    expect(prompt).toContain("- go.defer:timing|実行タイミング");
    expect(await maps.listFixedObjectives()).toEqual(before);
    // 2 Concept は1回の呼び出しに収まるので、1回分。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await usedRequests()).toBe(1);
  });

  it("conceptIds で作り直す Concept を絞れる", async () => {
    const res = await send("POST", "/fixed-maps/go/objectives:generate", {
      conceptIds: ["go.goroutine"],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as GenerateFixedObjectivesResponse;
    expect(body.concepts.map((item) => item.conceptId)).toEqual(["go.goroutine"]);
  });

  it("その Concept の今ある項目に無い ID が返ったら受理しない（決定 M5）", async () => {
    objectivesFor = () => ({
      nodes: [
        {
          key: "go.defer",
          objectives: [{ id: "go.defer:made_up", label: "a" }, { label: "b" }],
        },
      ],
    });

    const res = await send("POST", "/fixed-maps/go/objectives:generate", {
      conceptIds: ["go.defer"],
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "fixed objectives generation failed" });
  });

  it("他の Concept の項目の ID も受理しない", async () => {
    objectivesFor = () => ({
      nodes: [
        { key: "go.defer", objectives: [{ label: "a" }, { label: "b" }] },
        {
          key: "go.goroutine",
          objectives: [{ id: "go.defer:timing", label: "a" }, { label: "b" }],
        },
      ],
    });

    const res = await send("POST", "/fixed-maps/go/objectives:generate", {});

    expect(res.status).toBe(502);
  });

  it("作成者でなければ 403 で、上流を叩かず回数も使わない", async () => {
    const res = await send("POST", "/fixed-maps/go/objectives:generate", {}, "token-b");

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("別の言語の作成者でも 403", async () => {
    const res = await send("POST", "/fixed-maps/ts/objectives:generate", {});

    expect(res.status).toBe(403);
  });

  it("知らない言語は 404、その言語に無い Concept は 400", async () => {
    expect((await send("POST", "/fixed-maps/cobol/objectives:generate", {})).status).toBe(404);
    expect(
      (
        await send("POST", "/fixed-maps/go/objectives:generate", {
          conceptIds: ["ts.type"],
        })
      ).status,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("回数が足りなければ上流を叩かずに 429", async () => {
    const { dailyRequests } = planLimits("free");
    await usage.reserve({
      userId: "user-a",
      ...USAGE_KEYS,
      updatedAt: NOW.toISOString(),
      amount: dailyRequests,
      limits: { dailyRequests, monthlyRequests: Number.MAX_SAFE_INTEGER },
    });

    const res = await send("POST", "/fixed-maps/go/objectives:generate", {});

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "ai usage limit reached", limit: "daily" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("PUT /v1/fixed-maps/:language/concepts/:conceptId/objectives", () => {
  const path = "/fixed-maps/go/concepts/go.defer/objectives";

  it("ID 付きは引き継ぎ、ID 無しは新しい ID を振り、送らなかった項目は消す（決定 M6）", async () => {
    const res = await send("PUT", path, {
      objectives: [
        { id: "go.defer:timing", label: "関数を抜けるときに実行される", source: "ai" },
        { id: "go.defer:lifo", label: "実行順" },
        { label: "引数はその場で評価される", source: "ai" },
        { label: "手で足した項目" },
      ],
    });

    expect(res.status).toBe(200);
    const expected = [
      { id: "go.defer:timing", label: "関数を抜けるときに実行される", source: "ai" },
      { id: "go.defer:lifo", label: "実行順", source: "manual" },
      { id: "go.defer:k0000001", label: "引数はその場で評価される", source: "ai" },
      { id: "go.defer:k0000002", label: "手で足した項目", source: "manual" },
    ];
    expect(((await res.json()) as PutFixedObjectivesResponse).objectives).toEqual(expected);
    expect(await maps.listFixedObjectives()).toEqual(
      expected.map((objective) => ({ ...objective, conceptId: "go.defer" })),
    );
  });

  it("表示名を手で書き換えた項目は、ID を保ったまま手書きになる", async () => {
    store.fixedObjectives[0] = { ...store.fixedObjectives[0]!, source: "ai" };

    const res = await send("PUT", path, {
      objectives: [{ id: "go.defer:timing", label: "書き換えた" }],
    });

    expect(((await res.json()) as PutFixedObjectivesResponse).objectives).toEqual([
      { id: "go.defer:timing", label: "書き換えた", source: "manual" },
    ]);
  });

  it("消した項目を狙った確認問題を、全利用者の分消す。他の項目と他の Concept の問題は残す", async () => {
    const checks = new InMemoryPersonalCheckRepository(store);
    await checks.put("user-a", personalCheck("go.defer", "go.defer:named"), 0);
    await checks.put("user-b", personalCheck("go.defer", "go.defer:named"), 0);
    await checks.put("user-b", personalCheck("go.defer", "go.defer:timing"), 0);
    await checks.put("user-b", personalCheck("go.goroutine"), 0);

    await send("PUT", path, {
      objectives: [
        { id: "go.defer:timing", label: "実行タイミング" },
        { id: "go.defer:lifo", label: "実行順" },
      ],
    });

    expect(await checks.listAllByUser("user-a")).toEqual([]);
    expect(
      (await checks.listAllByUser("user-b")).map((check) => check.objectiveId ?? check.conceptId),
    ).toEqual(["go.defer:timing", "go.goroutine"]);
  });

  it("誰がいつ何を変えたかを監査ログに残す", async () => {
    await send("PUT", path, {
      objectives: [{ id: "go.defer:timing", label: "実行タイミング" }],
    });

    expect(store.auditLog).toEqual([
      {
        userId: "user-a",
        action: "fixed_objectives.replaced",
        occurredAtMs: NOW.getTime(),
        detail: {
          conceptId: "go.defer",
          objectiveIds: ["go.defer:timing"],
          removedIds: ["go.defer:lifo", "go.defer:named"],
        },
      },
    ]);
  });

  it("今ある一覧に無い ID・重なった ID・空の一覧は 400 で、何も変えない", async () => {
    const before = await maps.listFixedObjectives();
    for (const objectives of [
      [{ id: "go.defer:made_up", label: "a" }],
      [{ id: "go.goroutine:x", label: "a" }],
      [
        { id: "go.defer:timing", label: "a" },
        { id: "go.defer:timing", label: "b" },
      ],
      [],
    ]) {
      expect((await send("PUT", path, { objectives })).status).toBe(400);
    }
    expect(await maps.listFixedObjectives()).toEqual(before);
  });

  it("作成者でなければ 403、その言語に無い Concept は 404", async () => {
    const body = { objectives: [{ label: "a" }] };
    expect((await send("PUT", path, body, "token-b")).status).toBe(403);
    expect((await send("PUT", "/fixed-maps/go/concepts/ts.type/objectives", body)).status).toBe(
      404,
    );
    expect(store.auditLog).toEqual([]);
  });
});
