import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MAP_GENERATION_CONSENT_VERSION } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { stubAuth } from "../auth/test-auth.js";
import { MAX_MAPS_PER_USER } from "../contract/learning-maps.js";
import type {
  ConfirmRepoMapDraftResponse,
  CreateRepoMapDraftResponse,
  RepoMapDraftView,
} from "../contract/repo-maps.js";
import {
  createInMemoryRepositoryStore,
  InMemoryIdentityRepository,
  InMemoryLearningMapRepository,
  InMemoryMapGenerationConsentRepository,
  type InMemoryRepositoryStore,
} from "../repository/memory.js";
import { InMemoryUserPlanRepository } from "../repository/user-plans.js";
import { GitHubError, type GitHubClient, type TreeEntry } from "../repo-maps/github.js";
import { InMemoryRepoMapDraftRepository } from "../repo-maps/memory.js";
import { headBytes } from "../repo-maps/prompts.js";
import { planObjectiveBatches, parseTree } from "../repo-maps/confirm.js";
import { createRepoMapsRoute } from "./repo-maps.js";

const NOW = new Date("2026-10-11T09:00:00.000Z");
const TOKENS = { "token-a": "user-a", "token-b": "user-b" };
const URL_IN = "github.com/owner/repo";
const SHA = "c".repeat(40);

const blob = (path: string, size = 1000): TreeEntry => ({
  path,
  type: "blob",
  sha: `sha:${path}`,
  size,
});

const TREE: TreeEntry[] = [
  blob("README.md", 2600),
  blob("docs/orders.md", 2400),
  blob("db/schema.rb", 800),
  blob("app/models/order.rb", 700),
];
const BODIES: Record<string, string> = {
  "sha:README.md": "# 注文システム\n注文と顧客を扱う。",
  "sha:docs/orders.md": "注文は paid になるまで下書きである。",
  "sha:db/schema.rb": 'create_table "orders" do |t|\nend\ncreate_table "customers" do |t|\nend\n',
  "sha:app/models/order.rb": "class Order\nend\n",
};

let store: InMemoryRepositoryStore;
let drafts: InMemoryRepoMapDraftRepository;
let maps: InMemoryLearningMapRepository;
let consents: InMemoryMapGenerationConsentRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;
let prompts: string[];
/** 木の応答。順に並べ替える。 */
let treeResponse: (keys: string[]) => unknown;
let objectivesResponse: (keys: string[]) => unknown;
let candidateItems: unknown[];
let seq: number;
let keySeq: number;

const geminiOk = (value: unknown): Response =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 600, totalTokenCount: 1000 },
      modelVersion: "gemini-3.8-flash",
    }),
    { status: 200 },
  );

/** `key|...` の行からノードの key を取り出す。 */
const keysIn = (prompt: string): string[] =>
  [...prompt.matchAll(/^(C[0-9]+)\|/gm)].map((m) => m[1]!);

function ai(prompt: string): Response {
  if (prompt.includes("学ぶ順に並べ")) return geminiOk(treeResponse(keysIn(prompt)));
  if (prompt.includes("「理解すること」を作ってください")) {
    return geminiOk(objectivesResponse(keysIn(prompt)));
  }
  if (prompt.includes("『ドメインの用語（業務の概念）』の候補")) return geminiOk(candidateItems);
  if (prompt.includes("パスの JSON 配列だけ")) return geminiOk(["app/models/order.rb"]);
  if (prompt.includes("番号の JSON 配列だけ")) return geminiOk([]);
  const label = /<<<資料: (.+)\n/.exec(prompt)?.[1] ?? "?";
  return geminiOk({ summary: `${label} の要約` });
}

const github = (): GitHubClient => ({
  getRepo: () => Promise.resolve({ owner: "Owner", name: "Repo", defaultBranch: "main" }),
  getHeadSha: () => Promise.resolve(SHA),
  getTree: () => Promise.resolve(TREE),
  getBlobText: (_r, sha, max) => {
    const body = BODIES[sha];
    if (body === undefined) return Promise.reject(new GitHubError("not-found", sha));
    return Promise.resolve({ text: headBytes(body, max), truncated: false });
  },
  listIssues: () => Promise.resolve([]),
  getIssue: () => Promise.reject(new Error("unused")),
});

function build() {
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(TOKENS));
  app.route(
    "/v1",
    createRepoMapsRoute(() => ({
      github: github(),
      drafts,
      consents,
      plans: new InMemoryUserPlanRepository(),
      identity: new InMemoryIdentityRepository(store),
      maps,
      newKey: () => `k${String((keySeq += 1)).padStart(7, "0")}`,
      newId: () => `r${String((seq += 1)).padStart(8, "0")}`,
      now: () => NOW,
      ai: {
        apiKey: "k",
        models: ["gemini-3.5-flash-lite"],
        candidateModels: ["gemini-3.8-flash"],
        fetch: (async (_u: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as {
            contents: { parts: { text: string }[] }[];
          };
          const prompt = body.contents[0]!.parts[0]!.text;
          prompts.push(prompt);
          return ai(prompt);
        }) as typeof fetch,
      },
    })),
  );
}

function call(method: string, path: string, body?: unknown, token = "token-a") {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 候補まで進めた下書き。 */
async function candidatesDraft(token = "token-a"): Promise<RepoMapDraftView> {
  const created = await call("POST", "/v1/repo-map-drafts", { url: URL_IN }, token);
  const id = ((await created.json()) as CreateRepoMapDraftResponse).draft.id;
  expect((await call("POST", `/v1/repo-map-drafts/${id}/summarize`, {}, token)).status).toBe(200);
  const res = await call("POST", `/v1/repo-map-drafts/${id}/candidates`, {}, token);
  expect(res.status).toBe(200);
  return (await res.json()) as RepoMapDraftView;
}

const confirm = (id: string, body: unknown, token = "token-a") =>
  call("POST", `/v1/repo-map-drafts/${id}/confirm`, body, token);

beforeEach(async () => {
  store = createInMemoryRepositoryStore();
  drafts = new InMemoryRepoMapDraftRepository(store.users);
  maps = new InMemoryLearningMapRepository(store);
  consents = new InMemoryMapGenerationConsentRepository(store);
  for (const u of ["user-a", "user-b"]) {
    await consents.put(u, { version: MAP_GENERATION_CONSENT_VERSION, grantedAt: "t" } as never);
  }
  prompts = [];
  seq = 0;
  keySeq = 0;
  candidateItems = [
    {
      name: "注文",
      original: "Order",
      description: "顧客が確定する購入の単位。",
      evidence: ["E1", "E3"],
    },
    { name: "顧客", original: "Customer", description: "注文をする人。", evidence: ["E2"] },
    { name: "支払い", original: "Payment", description: "注文の代金の支払い。", evidence: ["E1"] },
  ];
  // 既定: 渡した順の逆に並べ、前の 1 つを前提にする。
  treeResponse = (keys) => ({
    nodes: [...keys]
      .reverse()
      .map((key, i, all) => ({ key, prerequisite: i === 0 ? null : all[i - 1] })),
  });
  objectivesResponse = (keys) => ({
    nodes: keys.map((key) => ({
      key,
      objectives: [`${key} を説明できる`, `${key} の状態遷移を説明できる`],
    })),
  });
  build();
});

describe("POST /v1/repo-map-drafts/:id/confirm", () => {
  it("選んだ候補から、木・「理解すること」・根拠つきのマップを作り、下書きを消す", async () => {
    const draft = await candidatesDraft();
    const ids = draft.candidates!.items.filter((c) => !c.schemaOnly).map((c) => c.id);
    const res = await confirm(draft.id, { accepted: ids.map((id) => ({ id })) });
    expect(res.status).toBe(201);
    const { mapId } = (await res.json()) as ConfirmRepoMapDraftResponse;

    const map = await maps.get("user-a", mapId);
    expect(map).not.toBeNull();
    expect(map!.title).toBe("Repo のドメイン知識");
    const own = map!.nodes.filter((n) => n.kind === "own");
    // AI が決めた並び（渡した順の逆）。前提は 1 つ前のノード。
    expect(own.map((n) => n.label)).toEqual(["支払い", "顧客", "注文"]);
    expect(map!.edges).toHaveLength(2);
    // 「理解すること」は AI 由来で、全ノードに 2 項目ある。
    for (const n of own) {
      const items = map!.objectives.get(n.conceptId) ?? [];
      expect(items).toHaveLength(2);
      expect(items.every((o) => o.source === "ai")).toBe(true);
    }
    // 取り込み元と根拠（パス・要約）を保存する。
    const source = await maps.getRepoSource("user-a", mapId);
    expect(source).toMatchObject({ url: "github.com/Owner/Repo", commitSha: SHA });
    const order = own.find((n) => n.label === "注文")!;
    const orderSources = source!.nodeSources.filter((s) => s.conceptId === order.conceptId);
    expect(orderSources.map((s) => [s.kind, s.path])).toEqual(
      expect.arrayContaining([
        ["doc", "README.md"],
        ["code", "app/models/order.rb"],
      ]),
    );
    expect(orderSources.every((s) => s.summary !== "")).toBe(true);
    // 下書きは消える。
    expect(await drafts.get("user-a", draft.id)).toBeNull();
    // 呼び出しは記録に残る（木 1 回 + 理解すること）。
    expect(drafts.aiCallRows.filter((r) => r.call.stage === "tree")).toHaveLength(1);
    expect(drafts.aiCallRows.filter((r) => r.call.stage === "objectives").length).toBeGreaterThan(
      0,
    );
  });

  it("「理解すること」の作成に、根拠の要約と、直した表示名を渡す", async () => {
    const draft = await candidatesDraft();
    prompts.length = 0;
    const res = await confirm(draft.id, {
      title: "注文の世界",
      accepted: [{ id: "C1", name: "オーダー", description: "購入の単位。" }],
    });
    expect(res.status).toBe(201);
    const objectivesPrompt = prompts.find((p) => p.includes("「理解すること」を作ってください"))!;
    expect(objectivesPrompt).toContain("オーダー");
    expect(objectivesPrompt).toContain("学習マップ「注文の世界」");
    // 根拠の要約（README の要約）が入る。
    expect(objectivesPrompt).toContain("README.md の要約");
    const mapId = ((await res.json()) as ConfirmRepoMapDraftResponse).mapId;
    expect((await maps.get("user-a", mapId))!.title).toBe("注文の世界");
  });

  it("木の応答が不正なら、何も保存せず、下書きを候補の状態へ戻し、続けて確定できる", async () => {
    const draft = await candidatesDraft();
    treeResponse = (keys) => ({
      // 前提が後ろのノードを指している。
      nodes: keys.map((key, i) => ({ key, prerequisite: keys[i + 1] ?? null })),
    });
    const res = await confirm(draft.id, { accepted: [{ id: "C1" }, { id: "C2" }] });
    expect(res.status).toBe(502);
    expect(await maps.listByOwner("user-a")).toHaveLength(0);
    const view = (await (
      await call("GET", `/v1/repo-map-drafts/${draft.id}`)
    ).json()) as RepoMapDraftView;
    expect(view.status).toBe("candidates");
    expect(view.failure).toBeNull();
    // 課金された呼び出しは記録している。
    expect(drafts.aiCallRows.some((r) => r.call.stage === "tree")).toBe(true);

    treeResponse = (keys) => ({ nodes: keys.map((key) => ({ key, prerequisite: null })) });
    expect((await confirm(draft.id, { accepted: [{ id: "C1" }, { id: "C2" }] })).status).toBe(201);
  });

  it("「理解すること」が足りなければ、何も保存しない", async () => {
    const draft = await candidatesDraft();
    objectivesResponse = (keys) => ({
      nodes: keys.slice(1).map((key) => ({ key, objectives: ["a", "b"] })),
    });
    const res = await confirm(draft.id, { accepted: [{ id: "C1" }, { id: "C2" }] });
    expect(res.status).toBe(502);
    expect(await maps.listByOwner("user-a")).toHaveLength(0);
    expect(await drafts.get("user-a", draft.id)).not.toBeNull();
  });

  it("入力の検証: 知らない候補・重複・空は 400。要約前（候補の前）は 409。他人は 404", async () => {
    const created = await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    const early = ((await created.json()) as CreateRepoMapDraftResponse).draft.id;
    expect((await confirm(early, { accepted: [{ id: "C1" }] })).status).toBe(409);

    const draft = await candidatesDraft();
    expect((await confirm(draft.id, { accepted: [{ id: "C99" }] })).status).toBe(400);
    expect((await confirm(draft.id, { accepted: [{ id: "C1" }, { id: "C1" }] })).status).toBe(400);
    expect((await confirm(draft.id, { accepted: [] })).status).toBe(400);
    expect((await confirm(draft.id, { accepted: [{ id: "C1" }] }, "token-b")).status).toBe(404);
    expect(prompts.filter((p) => p.includes("学ぶ順に並べ"))).toHaveLength(0);
  });

  it("同意が古ければ 403。AI を呼ばない", async () => {
    const draft = await candidatesDraft();
    store.mapGenerationConsents.set("user-a", {
      version: MAP_GENERATION_CONSENT_VERSION - 1,
      grantedAt: "t",
    } as never);
    prompts.length = 0;
    expect((await confirm(draft.id, { accepted: [{ id: "C1" }] })).status).toBe(403);
    expect(prompts).toHaveLength(0);
  });

  it("マップの数が上限なら、AI を呼ばずに 409", async () => {
    const draft = await candidatesDraft();
    for (let i = 0; i < MAX_MAPS_PER_USER; i += 1) {
      await maps.create("user-a", {
        id: `m${String(i).padStart(8, "0")}`,
        content: { title: `t${String(i)}`, description: "", nodes: [], edges: [] },
        nowIso: "t",
        nowMs: 1,
        maxMaps: MAX_MAPS_PER_USER,
      });
    }
    prompts.length = 0;
    const res = await confirm(draft.id, { accepted: [{ id: "C1" }] });
    expect(res.status).toBe(409);
    expect(prompts).toHaveLength(0);
  });

  it("後始末（下書きの削除）に失敗しても確定は成功し、もう一度呼んでも二重に作らない", async () => {
    const draft = await candidatesDraft();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(drafts, "delete").mockRejectedValueOnce(new Error("transient"));
    const first = await confirm(draft.id, { accepted: [{ id: "C1" }] });
    expect(first.status).toBe(201);
    const second = await confirm(draft.id, { accepted: [{ id: "C1" }] });
    expect(second.status).toBe(201);
    expect(((await second.json()) as ConfirmRepoMapDraftResponse).mapId).toBe(
      ((await first.json()) as ConfirmRepoMapDraftResponse).mapId,
    );
    expect(await maps.listByOwner("user-a")).toHaveLength(1);
    errors.mockRestore();
  });

  it("同時の 2 つ目は 409 で、マップは 1 つだけ", async () => {
    const draft = await candidatesDraft();
    const [a, b] = await Promise.all([
      confirm(draft.id, { accepted: [{ id: "C1" }] }),
      confirm(draft.id, { accepted: [{ id: "C1" }] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await maps.listByOwner("user-a")).toHaveLength(1);
  });

  it("ノードが多くても、1 回の入力の上限（6,000 バイト）に収め、全ノードに項目を作る", async () => {
    candidateItems = Array.from({ length: 20 }, (_, i) => ({
      name: `用語${String(i + 1)}`,
      original: `Term${String(i + 1)}`,
      description: "あ".repeat(80),
      evidence: ["E1", "E2", "E3"],
    }));
    const draft = await candidatesDraft();
    const ids = draft.candidates!.items.filter((c) => !c.schemaOnly).map((c) => c.id);
    expect(ids).toHaveLength(20);
    prompts.length = 0;
    const res = await confirm(draft.id, { accepted: ids.map((id) => ({ id })) });
    expect(res.status).toBe(201);
    const objectivePrompts = prompts.filter((p) => p.includes("「理解すること」を作ってください"));
    expect(objectivePrompts.length).toBeGreaterThan(1);
    for (const p of [...objectivePrompts, ...prompts.filter((p) => p.includes("学ぶ順に並べ"))]) {
      expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(6_000);
    }
    const mapId = ((await res.json()) as ConfirmRepoMapDraftResponse).mapId;
    const map = (await maps.get("user-a", mapId))!;
    expect(map.nodes).toHaveLength(20);
    for (const n of map.nodes) expect(map.objectives.get(n.conceptId)).toHaveLength(2);
  });
});

describe("木の検証", () => {
  it("全部の key が 1 回ずつ。前提は前のノードだけ。形が違えば受理しない", () => {
    const keys = ["C1", "C2", "C3"];
    expect(
      parseTree(
        {
          nodes: [
            { key: "C2" },
            { key: "C1", prerequisite: "C2" },
            { key: "C3", prerequisite: "C1" },
          ],
        },
        keys,
      ).order,
    ).toEqual(["C2", "C1", "C3"]);
    for (const bad of [
      { nodes: [{ key: "C1" }, { key: "C2" }] },
      { nodes: [{ key: "C1" }, { key: "C1" }, { key: "C2" }, { key: "C3" }] },
      { nodes: [{ key: "C1", prerequisite: "C2" }, { key: "C2" }, { key: "C3" }] },
      { nodes: [{ key: "C1" }, { key: "C2" }, { key: "CX" }] },
      { nodes: "x" },
      null,
    ]) {
      expect(() => parseTree(bad, keys)).toThrow();
    }
  });

  it("「理解すること」は入力の上限に収まるよう分ける。1 ノードも収まらなければ null", () => {
    const node = (i: number, text: string) => ({
      key: `C${String(i)}`,
      label: `用語${String(i)}`,
      summary: "説明",
      evidence: Array.from({ length: 3 }, () => ({ kind: "doc" as const, ref: "README.md", text })),
      sources: [],
    });
    const nodes = Array.from({ length: 12 }, (_, i) => node(i + 1, "あ".repeat(120)));
    const batches = planObjectiveBatches("題名", nodes)!;
    expect(batches.flat()).toHaveLength(12);
    expect(batches.length).toBeGreaterThan(1);
    expect(planObjectiveBatches("題名", [node(1, "あ".repeat(120))], 100)).toBeNull();
  });
});
