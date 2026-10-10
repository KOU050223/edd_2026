import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { MAP_GENERATION_CONSENT_VERSION } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { stubAuth } from "../auth/test-auth.js";
import type { CreateRepoMapDraftResponse, RepoMapDraftView } from "../contract/repo-maps.js";
import {
  createInMemoryRepositoryStore,
  InMemoryIdentityRepository,
  InMemoryMapGenerationConsentRepository,
  type InMemoryRepositoryStore,
} from "../repository/memory.js";
import { InMemoryUserPlanRepository } from "../repository/user-plans.js";
import { GitHubError, type GitHubClient, type TreeEntry } from "../repo-maps/github.js";
import { InMemoryRepoMapDraftRepository } from "../repo-maps/memory.js";
import { headBytes } from "../repo-maps/prompts.js";
import { MAX_CANDIDATES, MAX_SCHEMA_ONLY, normalizeName } from "../repo-maps/candidates.js";
import { createRepoMapsRoute } from "./repo-maps.js";

const NOW = new Date("2026-10-11T09:00:00.000Z");
const TOKENS = { "token-a": "user-a", "token-b": "user-b" };
const URL_IN = "github.com/owner/repo";

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
  "sha:db/schema.rb":
    'create_table "orders" do |t|\nend\ncreate_table "order_items" do |t|\nend\ncreate_table "audit_logs" do |t|\nend\n',
  "sha:app/models/order.rb": "class Order\nend\n",
};

let store: InMemoryRepositoryStore;
let drafts: InMemoryRepoMapDraftRepository;
let consents: InMemoryMapGenerationConsentRepository;
let plans: InMemoryUserPlanRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;
let prompts: string[];
let tree: TreeEntry[];
/** 候補の段の応答を作る。テストごとに差し替える。 */
let candidatesResponse: (prompt: string) => unknown;
let seq: number;

function geminiOk(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 500, totalTokenCount: 900 },
      modelVersion: "gemini-3.8-flash",
    }),
    { status: 200 },
  );
}

function ai(prompt: string): Response {
  if (prompt.includes("『ドメインの用語（業務の概念）』の候補")) {
    return geminiOk(JSON.stringify(candidatesResponse(prompt)));
  }
  if (prompt.includes("パスの JSON 配列だけ"))
    return geminiOk(JSON.stringify(["app/models/order.rb"]));
  if (prompt.includes("番号の JSON 配列だけ")) return geminiOk("[]");
  const label = /<<<資料: (.+)\n/.exec(prompt)?.[1] ?? "?";
  return geminiOk(JSON.stringify({ summary: `${label} の要約` }));
}

const github = (): GitHubClient => ({
  getRepo: () => Promise.resolve({ owner: "Owner", name: "Repo", defaultBranch: "main" }),
  getHeadSha: () => Promise.resolve("c".repeat(40)),
  getTree: () => Promise.resolve(tree),
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
      plans,
      identity: new InMemoryIdentityRepository(store),
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

async function summarizedDraft(token = "token-a"): Promise<RepoMapDraftView> {
  const created = await call("POST", "/v1/repo-map-drafts", { url: URL_IN }, token);
  expect(created.status).toBe(201);
  const draft = ((await created.json()) as CreateRepoMapDraftResponse).draft;
  const res = await call("POST", `/v1/repo-map-drafts/${draft.id}/summarize`, {}, token);
  expect(res.status).toBe(200);
  return (await res.json()) as RepoMapDraftView;
}

const candidates = (id: string, body: unknown = {}, token = "token-a") =>
  call("POST", `/v1/repo-map-drafts/${id}/candidates`, body, token);
const rebuild = (id: string, body: unknown = {}, token = "token-a") =>
  call("POST", `/v1/repo-map-drafts/${id}/rebuild`, body, token);

beforeEach(async () => {
  store = createInMemoryRepositoryStore();
  drafts = new InMemoryRepoMapDraftRepository(store.users);
  consents = new InMemoryMapGenerationConsentRepository(store);
  plans = new InMemoryUserPlanRepository();
  for (const u of ["user-a", "user-b"]) {
    await consents.put(u, { version: MAP_GENERATION_CONSENT_VERSION, grantedAt: "t" } as never);
  }
  prompts = [];
  tree = TREE;
  seq = 0;
  candidatesResponse = () => [
    {
      name: "注文",
      original: "Order",
      description: "顧客が確定する購入の単位。",
      evidence: ["E1", "E3"],
    },
    {
      name: "注文明細",
      original: "OrderItem",
      description: "注文に含まれる商品の行。",
      evidence: ["E2"],
    },
  ];
  build();
});

describe("POST /v1/repo-map-drafts/:id/candidates", () => {
  it("根拠を ID で受け、パスとリンクは機械で戻す。データの形の印も機械で付ける", async () => {
    const draft = await summarizedDraft();
    // AI の自己申告（fromSchema）は受けない。
    candidatesResponse = () => [
      {
        name: "注文",
        original: "Order",
        description: "購入の単位。",
        evidence: ["E1", "E3"],
        fromSchema: false,
      },
      {
        name: "割引",
        original: "Discount",
        description: "価格を下げる仕組み。",
        evidence: ["E2"],
        fromSchema: true,
      },
    ];
    const res = await candidates(draft.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RepoMapDraftView;
    expect(body.status).toBe("candidates");
    const [order, discount] = body.candidates!.items;
    expect(order).toMatchObject({
      name: "注文",
      original: "Order",
      fromSchema: true,
      schemaOnly: false,
    });
    expect(order!.evidence).toEqual([
      expect.objectContaining({ id: "E1", kind: "doc", ref: "README.md" }),
      expect.objectContaining({ id: "E3", kind: "code", ref: "app/models/order.rb" }),
    ]);
    expect(order!.evidence[0]!.url).toBe(
      `https://github.com/Owner/Repo/blob/${"c".repeat(40)}/README.md`,
    );
    expect(discount).toMatchObject({ fromSchema: false });
  });

  it("文書にはなく、データの形にだけある名前を足す（上限つき）", async () => {
    const draft = await summarizedDraft();
    const body = (await (await candidates(draft.id)).json()) as RepoMapDraftView;
    const only = body.candidates!.items.filter((c) => c.schemaOnly);
    // orders / order_items は候補に当たる。audit_logs だけが「データの形にだけある」。
    expect(only.map((c) => c.original)).toEqual(["audit_logs"]);
    expect(only[0]).toMatchObject({
      fromSchema: true,
      evidence: [expect.objectContaining({ kind: "schema", ref: "db/schema.rb" })],
    });
    expect(only.length).toBeLessThanOrEqual(MAX_SCHEMA_ONLY);
  });

  it("根拠が無い・作り話の根拠の候補は外す。重複は 1 つ。上限を超えない", async () => {
    const draft = await summarizedDraft();
    candidatesResponse = () => [
      { name: "注文", original: "Order", description: "x", evidence: ["E1"] },
      { name: "同じ", original: "Order", description: "重複", evidence: ["E1"] },
      { name: "幻", original: "Ghost", description: "根拠が作り話", evidence: ["E99"] },
      ...Array.from({ length: 30 }, (_, i) => ({
        name: `用語${String(i)}`,
        original: `Term${String(i)}`,
        description: "d",
        evidence: ["E2"],
      })),
    ];
    const body = (await (await candidates(draft.id)).json()) as RepoMapDraftView;
    const names = body.candidates!.items.map((c) => c.name);
    expect(names).not.toContain("幻");
    expect(names).not.toContain("同じ");
    expect(body.candidates!.items.filter((c) => !c.schemaOnly).length).toBeLessThanOrEqual(
      MAX_CANDIDATES,
    );
  });

  it("応答の形が違えば受理せず 502。失敗の段を残し、課金された呼び出しは記録し、続きから再実行できる", async () => {
    const draft = await summarizedDraft();
    const before = (
      await drafts.usage({ userId: "user-a", monthKey: "2026-10", dayKey: "2026-10-11" })
    ).monthlyTokens;
    candidatesResponse = () => [{ name: "注文", evidence: ["E1"] }];
    const res = await candidates(draft.id);
    expect(res.status).toBe(502);
    const view = (await (
      await call("GET", `/v1/repo-map-drafts/${draft.id}`)
    ).json()) as RepoMapDraftView;
    expect(view.status).toBe("failed");
    expect(view.failure).toEqual({ stage: "candidates", code: "ai_unusable" });
    expect(view.summary).not.toBeNull();
    const after = (
      await drafts.usage({ userId: "user-a", monthKey: "2026-10", dayKey: "2026-10-11" })
    ).monthlyTokens;
    expect(after).toBeGreaterThan(before);

    candidatesResponse = () => [
      { name: "注文", original: "Order", description: "d", evidence: ["E1"] },
    ];
    expect((await candidates(draft.id)).status).toBe(200);
  });

  it("要約の前は 409。他人は 404。済んだ段は AI を呼ばない", async () => {
    const created = await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    const id = ((await created.json()) as CreateRepoMapDraftResponse).draft.id;
    expect((await candidates(id)).status).toBe(409);

    const draft = await summarizedDraft();
    expect((await candidates(draft.id, {}, "token-b")).status).toBe(404);
    expect((await candidates(draft.id)).status).toBe(200);
    prompts.length = 0;
    expect((await candidates(draft.id)).status).toBe(200);
    expect(prompts).toHaveLength(0);
  });

  it("同意が古ければ 403。AI を呼ばない", async () => {
    const draft = await summarizedDraft();
    store.mapGenerationConsents.set("user-a", {
      version: MAP_GENERATION_CONSENT_VERSION - 1,
      grantedAt: "t",
    } as never);
    prompts.length = 0;
    const res = await candidates(draft.id);
    expect(res.status).toBe(403);
    expect(prompts).toHaveLength(0);
  });

  it("文書が薄いときは、データの形とコードを主の材料にするよう頼む", async () => {
    tree = [blob("README.md", 120), blob("docs/orders.md", 200), ...TREE.slice(2)];
    const draft = await summarizedDraft();
    const body = (await (await candidates(draft.id)).json()) as RepoMapDraftView;
    expect(body.candidates!.thin).toBe(true);
    expect(prompts.filter((p) => p.includes("文書が少ない"))).toHaveLength(1);

    // 文書が十分なら頼まない。
    prompts.length = 0;
    tree = TREE;
    const full = await summarizedDraft();
    const fullBody = (await (await candidates(full.id)).json()) as RepoMapDraftView;
    expect(fullBody.candidates!.thin).toBe(false);
    expect(prompts.filter((p) => p.includes("文書が少ない"))).toHaveLength(0);
  });

  it("候補の段は、設定した候補用のモデルで呼ぶ", async () => {
    const draft = await summarizedDraft();
    await candidates(draft.id);
    const calls = drafts.aiCallRows.filter((r) => r.call.stage === "candidates");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.call.model).toBe("gemini-3.8-flash");
  });

  it("同時の 2 つ目は 409 で、AI を呼ばない", async () => {
    const draft = await summarizedDraft();
    prompts.length = 0;
    const [a, b] = await Promise.all([candidates(draft.id), candidates(draft.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(prompts.filter((p) => p.includes("候補を最大"))).toHaveLength(1);
  });
});

describe("POST /v1/repo-map-drafts/:id/rebuild", () => {
  it("外す材料を除いて、候補だけを作り直す（要約はやり直さない）", async () => {
    const draft = await summarizedDraft();
    await candidates(draft.id);
    prompts.length = 0;
    candidatesResponse = () => [
      { name: "注文", original: "Order", description: "d", evidence: ["E1", "E2"] },
    ];
    const res = await rebuild(draft.id, { excludeIds: ["E2"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RepoMapDraftView;
    expect(body.candidates!.excluded).toEqual(["E2"]);
    // 外した材料の行は送らない。根拠にも使えない。
    const sent = prompts.filter((p) => p.includes("候補を最大"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("[E2]");
    expect(body.candidates!.items[0]!.evidence.map((e) => e.id)).toEqual(["E1"]);
    // 要約の呼び出しは増えない。
    expect(prompts.filter((p) => p.includes("要約してください"))).toHaveLength(0);
  });

  it("1 日 5 回まで。月の枠には数えない。知らない ID は 400", async () => {
    const draft = await summarizedDraft();
    await candidates(draft.id);
    for (let i = 0; i < 5; i += 1) {
      expect((await rebuild(draft.id)).status).toBe(200);
    }
    const sixth = await rebuild(draft.id);
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toMatchObject({
      error: "quota_exceeded",
      kind: "rebuild",
      limit: 5,
    });
    const usage = await drafts.usage({
      userId: "user-a",
      monthKey: "2026-10",
      dayKey: "2026-10-11",
    });
    expect(usage.dailyRebuilds).toBe(5);
    expect(usage.monthlyDrafts).toBe(1);
    expect((await rebuild(draft.id, { excludeIds: ["E99"] })).status).toBe(400);
  });

  it("失敗しても、前の候補と状態を残す", async () => {
    const draft = await summarizedDraft();
    await candidates(draft.id);
    candidatesResponse = () => "not an array";
    const res = await rebuild(draft.id);
    expect(res.status).toBe(502);
    const view = (await (
      await call("GET", `/v1/repo-map-drafts/${draft.id}`)
    ).json()) as RepoMapDraftView;
    expect(view.status).toBe("candidates");
    expect(view.candidates!.items.length).toBeGreaterThan(0);
  });

  it("材料を全部外すことはできない", async () => {
    const draft = await summarizedDraft();
    const all = draft.summary!.materials.map((m) => m.id);
    const res = await rebuild(draft.id, { excludeIds: [...all, "S1"] });
    expect(res.status).toBe(400);
  });
});

describe("名前のつき合わせ", () => {
  it("snake_case と CamelCase、単数と複数を同じ名前として扱う", () => {
    expect(normalizeName("order_items")).toBe("orderitems");
    expect(normalizeName("OrderItem")).toBe("orderitem");
    expect(normalizeName("注文")).toBe("");
  });
});
