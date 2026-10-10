import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MAP_GENERATION_CONSENT_VERSION } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { stubAuth } from "../auth/test-auth.js";
import { nextUtcMonth } from "../contract/ai-usage.js";
import {
  REPO_MAP_DRAFT_TTL_DAYS,
  type CreateRepoMapDraftResponse,
  type InspectRepoResponse,
  type ListRepoMapDraftsResponse,
  type RepoMapDraftView,
} from "../contract/repo-maps.js";
import {
  createInMemoryRepositoryStore,
  InMemoryIdentityRepository,
  InMemoryMapGenerationConsentRepository,
  type InMemoryRepositoryStore,
} from "../repository/memory.js";
import { InMemoryUserPlanRepository } from "../repository/user-plans.js";
import { GitHubError, type GitHubClient, type TreeEntry } from "../repo-maps/github.js";
import { InMemoryRepoMapDraftRepository } from "../repo-maps/memory.js";
import { MAX_STATE_BYTES } from "../repo-maps/service.js";
import { createRepoMapsRoute } from "./repo-maps.js";

const NOW = new Date("2026-10-11T09:00:00.000Z");
const TOKENS = { "token-a": "user-a", "token-b": "user-b" };
const SHA = "c".repeat(40);

const blob = (path: string, size = 1000, sha = `sha:${path}`): TreeEntry => ({
  path,
  type: "blob",
  sha,
  size,
});
const dir = (path: string): TreeEntry => ({ path, type: "tree", sha: `dir:${path}` });

/** 小さなモノレポ。 */
const TREE: TreeEntry[] = [
  dir("apps"),
  dir("apps/web"),
  dir("apps/api"),
  dir("packages"),
  dir("packages/domain"),
  blob("README.md", 500),
  blob("apps/web/package.json", 200),
  blob("apps/api/package.json", 200),
  blob("packages/domain/package.json", 200),
  blob("packages/domain/src/order.ts", 800),
  blob("apps/api/src/app.ts", 900),
  blob("node_modules/x/index.js", 100),
  blob("assets/logo.png", 100),
];

interface FakeGitHub extends GitHubClient {
  calls: string[];
}

function fakeGitHub(
  overrides: Partial<{
    tree: TreeEntry[];
    fail: GitHubError;
    isPullRequest: boolean;
    canonical: { owner: string; name: string };
  }> = {},
): FakeGitHub {
  const calls: string[] = [];
  const canonical = overrides.canonical ?? { owner: "Owner", name: "Repo" };
  const guard = (name: string) => {
    calls.push(name);
    if (overrides.fail) throw overrides.fail;
  };
  return {
    calls,
    getRepo: () => {
      guard("getRepo");
      return Promise.resolve({ ...canonical, defaultBranch: "main" });
    },
    getHeadSha: () => {
      guard("getHeadSha");
      return Promise.resolve(SHA);
    },
    getTree: () => {
      guard("getTree");
      return Promise.resolve(overrides.tree ?? TREE);
    },
    getBlobText: () => Promise.reject(new Error("not used in C1")),
    listIssues: () => {
      guard("listIssues");
      return Promise.resolve([
        {
          number: 9,
          title: "注文の状態",
          state: "open",
          labels: [],
          updatedAt: "2026-10-01T00:00:00Z",
        },
      ]);
    },
    getIssue: (_ref, number) => {
      guard("getIssue");
      return Promise.resolve({
        number,
        title: `t${number}`,
        state: "open",
        labels: [],
        updatedAt: "2026-10-01T00:00:00Z",
        body: "",
        isPullRequest: overrides.isPullRequest ?? false,
      });
    },
  };
}

let store: InMemoryRepositoryStore;
let drafts: InMemoryRepoMapDraftRepository;
let consents: InMemoryMapGenerationConsentRepository;
let plans: InMemoryUserPlanRepository;
let identity: InMemoryIdentityRepository;
let github: FakeGitHub;
let seq: number;
let now: Date;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;

function build() {
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(TOKENS));
  app.route(
    "/v1",
    createRepoMapsRoute(() => ({
      github,
      drafts,
      consents,
      plans,
      identity,
      newId: () => `r${String((seq += 1)).padStart(8, "0")}`,
      now: () => now,
    })),
  );
}

beforeEach(() => {
  store = createInMemoryRepositoryStore();
  // users の行が無い利用者の書き込みを、D1 の外部キーと同じく拒否する。
  drafts = new InMemoryRepoMapDraftRepository(store.users);
  identity = new InMemoryIdentityRepository(store);
  consents = new InMemoryMapGenerationConsentRepository(store);
  plans = new InMemoryUserPlanRepository();
  github = fakeGitHub();
  seq = 0;
  now = new Date(NOW);
  build();
});

function call(method: string, path: string, body?: unknown, token = "token-a") {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function consent(userId = "user-a") {
  await consents.put(userId, {
    version: MAP_GENERATION_CONSENT_VERSION,
    grantedAt: NOW.toISOString(),
  } as never);
}

const URL_IN = "github.com/owner/repo";

describe("POST /v1/repo-maps:inspect", () => {
  it("正式な名前・SHA・モノレポの案内・フォルダを返し、保存も枠の消費もしない", async () => {
    const res = await call("POST", "/v1/repo-maps:inspect", { url: URL_IN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InspectRepoResponse;
    // 利用者が入れた綴りではなく、GitHub の正式な名前を返す。
    expect(body.repo).toMatchObject({
      owner: "Owner",
      name: "Repo",
      url: "github.com/Owner/Repo",
      defaultBranch: "main",
      commitSha: SHA,
    });
    expect(body.monorepo).toEqual([
      { path: "apps/api", shared: false },
      { path: "apps/web", shared: false },
      { path: "packages/domain", shared: true },
    ]);
    expect(body.folders).toEqual(["apps", "apps/api", "apps/web", "packages", "packages/domain"]);
    expect(body.scan.dropped).toEqual({ dependency_dir: 1, binary: 1 });
    expect(body.usage).toMatchObject({ monthlyDrafts: 0, monthlyDraftsLimit: 3 });
    // 参考ファイルを選ぶための一覧。捨てるファイル（依存・バイナリ）は入らない。
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.filesTruncated).toBe(false);
    // 照合用のパスは、選ぶ用の一覧と違い、捨てる規則に当たるものも含む（API は指定を受ける）。
    expect(body.pathsTruncated).toBe(false);
    for (const file of body.files) expect(body.paths).toContain(file.path);
    expect(body.paths.length).toBeGreaterThanOrEqual(body.files.length);
    expect(body.files.map((f) => f.path)).not.toContain("node_modules/x/index.js");
    for (const file of body.files) {
      expect(["glossary", "doc", "schema", "code"]).toContain(file.kind);
    }

    const list = (await (
      await call("GET", "/v1/repo-map-drafts")
    ).json()) as ListRepoMapDraftsResponse;
    expect(list.drafts).toEqual([]);
    expect(list.usage.monthlyDrafts).toBe(0);
  });

  it("URL の形が違えば GitHub を呼ばずに 400", async () => {
    const res = await call("POST", "/v1/repo-maps:inspect", {
      url: "github.com/owner/repo/tree/main",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_url");
    expect(github.calls).toHaveLength(0);
  });

  it("認証が無ければ 401", async () => {
    const res = await app.request("/v1/repo-maps:inspect", {
      method: "POST",
      body: JSON.stringify({ url: URL_IN }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/repo-map-drafts", () => {
  beforeEach(async () => {
    await consent();
  });

  it("下書きを作り、枠を 1 つ数え、30 日の期限を付ける", async () => {
    const res = await call("POST", "/v1/repo-map-drafts", {
      url: URL_IN,
      folders: ["packages"],
      files: ["apps/api/src/app.ts"],
      issues: [3],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateRepoMapDraftResponse;
    expect(body.draft).toMatchObject({
      id: "r00000001",
      status: "fetched",
      repo: { owner: "Owner", name: "Repo", commitSha: SHA },
      targets: { folders: ["packages"], files: ["apps/api/src/app.ts"], issues: [3] },
      issues: [{ number: 3, title: "t3" }],
    });
    expect(Date.parse(body.draft.expiresAt) - Date.parse(body.draft.createdAt)).toBe(
      REPO_MAP_DRAFT_TTL_DAYS * 86_400_000,
    );
    expect(body.usage).toMatchObject({ monthlyDrafts: 1, monthlyDraftsLimit: 3 });
    // 対象のフォルダの外の指定ファイルも材料に入る。AI に見せる一覧は圧縮したもの。
    expect(body.draft.listing).toContain("## ディレクトリ");
    expect(body.draft.scan.kept).toEqual({ code: 2, other: 1 });
  });

  it("初めての利用者（users の行がまだ無い）でも作れ、行を用意する", async () => {
    expect(store.users.has("user-a")).toBe(false);
    const res = await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    expect(res.status).toBe(201);
    expect(store.users.has("user-a")).toBe(true);
  });

  it("GitHub の失敗では users の行も作らない", async () => {
    github = fakeGitHub({ fail: new GitHubError("not-found", "x") });
    build();
    await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    expect(store.users.has("user-a")).toBe(false);
  });

  it("GitHub の呼び出しのあいだに月が変わったら、新しい月の枠・時刻で作る", async () => {
    const times = [new Date("2026-10-31T23:59:59.000Z"), new Date("2026-11-01T00:00:03.000Z")];
    now = times[0]!;
    // 1 回目（事前の確認）だけ 10 月、そのあとは 11 月を返す。
    let reads = 0;
    drafts = new InMemoryRepoMapDraftRepository(store.users);
    app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
    app.use("/v1/*", stubAuth(TOKENS));
    app.route(
      "/v1",
      createRepoMapsRoute(() => ({
        github,
        drafts,
        consents,
        plans,
        identity,
        newId: () => "r00000001",
        now: () => times[Math.min(reads++ > 0 ? 1 : 0, 1)]!,
      })),
    );
    const res = await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateRepoMapDraftResponse;
    expect(body.draft.createdAt).toBe("2026-11-01T00:00:03.000Z");
    expect(
      (await drafts.usage({ userId: "user-a", monthKey: "2026-11", dayKey: "2026-11-01" }))
        .monthlyDrafts,
    ).toBe(1);
    expect(
      (await drafts.usage({ userId: "user-a", monthKey: "2026-10", dayKey: "2026-10-31" }))
        .monthlyDrafts,
    ).toBe(0);
  });

  it("上限を超える大きさの指定ファイルは、作る前に断り、枠を消費しない", async () => {
    github = fakeGitHub({ tree: [...TREE, blob("docs/architecture.md", 250_000)] });
    build();
    const res = await call("POST", "/v1/repo-map-drafts", {
      url: URL_IN,
      files: ["docs/architecture.md"],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "invalid_target",
      field: "files",
      path: "docs/architecture.md",
    });
    const usage = await drafts.usage({
      userId: "user-a",
      monthKey: "2026-10",
      dayKey: "2026-10-11",
    });
    expect(usage.monthlyDrafts).toBe(0);
  });

  it("パスが長くても、指定ファイルを残して材料を上限に収め、作れる", async () => {
    const big: TreeEntry[] = [dir("src")];
    const long = (kind: string, i: number) => `${kind}/${"p".repeat(280)}_${i}`;
    for (let i = 0; i < 400; i += 1) {
      big.push(blob(`${long("src/domain", i)}.ts`, 2000 + i));
      big.push(blob(`${long("docs/guide", i)}.md`, 3000 + i));
    }
    const pinned = `${long("src/domain", 399)}.ts`;
    github = fakeGitHub({ tree: big });
    build();
    const res = await call("POST", "/v1/repo-map-drafts", { url: URL_IN, files: [pinned] });
    expect(res.status).toBe(201);
    const stored = await drafts.get("user-a", "r00000001");
    const state = JSON.parse(stored!.stageState) as { files: { path: string; pinned: boolean }[] };
    expect(new TextEncoder().encode(stored!.stageState).length).toBeLessThanOrEqual(
      MAX_STATE_BYTES,
    );
    expect(state.files.some((f) => f.path === pinned && f.pinned)).toBe(true);
    // 並びの後ろ（優先度の低いコード）から外れている。
    expect(state.files.length).toBeLessThan(301);
  });

  it("同意が無ければ、GitHub を呼ばず枠も数えずに 403", async () => {
    store.mapGenerationConsents.clear();
    const res = await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "consent_required",
      version: MAP_GENERATION_CONSENT_VERSION,
    });
    expect(github.calls).toHaveLength(0);
    expect(
      (await drafts.usage({ userId: "user-a", monthKey: "2026-10", dayKey: "2026-10-11" }))
        .monthlyDrafts,
    ).toBe(0);
  });

  it("その場の同意（consentVersion）でも作れる", async () => {
    store.mapGenerationConsents.clear();
    const res = await call("POST", "/v1/repo-map-drafts", {
      url: URL_IN,
      consentVersion: MAP_GENERATION_CONSENT_VERSION,
    });
    expect(res.status).toBe(201);
  });

  it("月の枠（free は 3）を超えたら 429。GitHub を呼ばず、戻る日時を返す", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await call("POST", "/v1/repo-map-drafts", { url: URL_IN })).status).toBe(201);
    }
    github.calls.length = 0;
    const res = await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: "quota_exceeded",
      limit: 3,
      used: 3,
      resetsAt: nextUtcMonth(NOW).toISOString(),
    });
    expect(github.calls).toHaveLength(0);
  });

  it("月が変われば枠は戻る。plus は枠が大きい", async () => {
    for (let i = 0; i < 3; i += 1) await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    now = new Date("2026-11-01T00:00:00.000Z");
    expect((await call("POST", "/v1/repo-map-drafts", { url: URL_IN })).status).toBe(201);

    plans.set("user-b", "plus");
    await consent("user-b");
    for (let i = 0; i < 4; i += 1) {
      expect((await call("POST", "/v1/repo-map-drafts", { url: URL_IN }, "token-b")).status).toBe(
        201,
      );
    }
  });

  it("GitHub の失敗や指定の誤りでは枠を消費しない", async () => {
    github = fakeGitHub({ fail: new GitHubError("not-found", "x") });
    build();
    expect((await call("POST", "/v1/repo-map-drafts", { url: URL_IN })).status).toBe(404);

    github = fakeGitHub();
    build();
    for (const bad of [
      { folders: ["nope"] },
      { files: ["apps"] },
      { files: ["a", "b", "c", "d", "e", "f"] },
    ]) {
      expect((await call("POST", "/v1/repo-map-drafts", { url: URL_IN, ...bad })).status).toBe(400);
    }
    github = fakeGitHub({ isPullRequest: true });
    build();
    const pr = await call("POST", "/v1/repo-map-drafts", { url: URL_IN, issues: [5] });
    expect(pr.status).toBe(400);
    expect(((await pr.json()) as { error: string }).error).toBe("invalid_issue");

    const usage = await drafts.usage({
      userId: "user-a",
      monthKey: "2026-10",
      dayKey: "2026-10-11",
    });
    expect(usage.monthlyDrafts).toBe(0);
  });

  it("保存に失敗したら確保した枠を戻して、元の失敗を返す", async () => {
    vi.spyOn(drafts, "create").mockRejectedValueOnce(new Error("disk full"));
    const res = await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    expect(res.status).toBe(500);
    const usage = await drafts.usage({
      userId: "user-a",
      monthKey: "2026-10",
      dayKey: "2026-10-11",
    });
    expect(usage.monthlyDrafts).toBe(0);
  });

  it("期限切れの下書きを、作成のついでに消す", async () => {
    await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    now = new Date(NOW.getTime() + (REPO_MAP_DRAFT_TTL_DAYS + 1) * 86_400_000);
    // 別の利用者の作成でも消える（戻ってこない利用者の分を残さない）。
    await consent("user-b");
    await call("POST", "/v1/repo-map-drafts", { url: URL_IN }, "token-b");
    expect(await drafts.get("user-a", "r00000001")).toBeNull();
    expect(await drafts.get("user-b", "r00000002")).not.toBeNull();
  });

  it("大きなリポジトリでも、保存する材料は上限に収まる", async () => {
    const big: TreeEntry[] = [dir("src")];
    for (let i = 0; i < 6000; i += 1) {
      big.push(blob(`src/domain/entity_${i}_${"x".repeat(60)}.ts`, 2000 + i));
      big.push(blob(`docs/guide/${"d".repeat(60)}_${i}.md`, 3000 + i));
    }
    github = fakeGitHub({ tree: big });
    build();
    const res = await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    expect(res.status).toBe(201);
    const stored = await drafts.get("user-a", "r00000001");
    expect(new TextEncoder().encode(stored!.stageState).length).toBeLessThan(MAX_STATE_BYTES);
    const body = (await res.json()) as CreateRepoMapDraftResponse;
    expect(new TextEncoder().encode(body.draft.listing).length).toBeLessThanOrEqual(4_500);
  });
});

describe("GitHub の失敗の写し方", () => {
  it.each([
    ["not-found", 404, "repo_not_found"],
    ["moved", 404, "repo_moved"],
    ["too-large", 422, "repo_too_large"],
    ["rate-limited", 503, "github_rate_limited"],
    ["timeout", 502, "github_unavailable"],
    ["unavailable", 502, "github_unavailable"],
    ["unauthorized", 503, "github_not_configured"],
  ] as const)("%s は %i %s", async (kind, status, error) => {
    github = fakeGitHub({ fail: new GitHubError(kind, "x") });
    build();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await call("POST", "/v1/repo-maps:inspect", { url: URL_IN });
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: string }).error).toBe(error);
    // 運営の設定の問題は記録する。利用者の再試行では直らない。
    expect(errors).toHaveBeenCalledTimes(kind === "unauthorized" ? 1 : 0);
    errors.mockRestore();
  });

  it("非公開と存在しないは同じ本文", async () => {
    github = fakeGitHub({ fail: new GitHubError("not-found", "private") });
    build();
    const a = await call("POST", "/v1/repo-maps:inspect", { url: URL_IN });
    github = fakeGitHub({ fail: new GitHubError("not-found", "missing") });
    build();
    const b = await call("POST", "/v1/repo-maps:inspect", { url: URL_IN });
    expect(await a.json()).toEqual(await b.json());
  });
});

describe("下書きの読み書き", () => {
  let created: RepoMapDraftView;

  beforeEach(async () => {
    await consent();
    const res = await call("POST", "/v1/repo-map-drafts", { url: URL_IN });
    created = ((await res.json()) as CreateRepoMapDraftResponse).draft;
  });

  it("持ち主は一覧と詳細で読める", async () => {
    const list = (await (
      await call("GET", "/v1/repo-map-drafts")
    ).json()) as ListRepoMapDraftsResponse;
    expect(list.drafts.map((d) => d.id)).toEqual([created.id]);
    const one = await call("GET", `/v1/repo-map-drafts/${created.id}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(created);
  });

  it("他人の下書きは存在しないのと同じ 404（読む・消す）", async () => {
    expect(
      (await call("GET", `/v1/repo-map-drafts/${created.id}`, undefined, "token-b")).status,
    ).toBe(404);
    expect(
      (await call("DELETE", `/v1/repo-map-drafts/${created.id}`, undefined, "token-b")).status,
    ).toBe(404);
    expect((await call("GET", "/v1/repo-map-drafts/rzzzzzzzz")).status).toBe(404);
    const other = (await (
      await call("GET", "/v1/repo-map-drafts", undefined, "token-b")
    ).json()) as ListRepoMapDraftsResponse;
    expect(other.drafts).toEqual([]);
    // 持ち主の分は残っている。
    expect((await call("GET", `/v1/repo-map-drafts/${created.id}`)).status).toBe(200);
  });

  it("期限が切れたら読めない（一覧にも出ない）", async () => {
    now = new Date(NOW.getTime() + REPO_MAP_DRAFT_TTL_DAYS * 86_400_000);
    expect((await call("GET", `/v1/repo-map-drafts/${created.id}`)).status).toBe(404);
    const list = (await (
      await call("GET", "/v1/repo-map-drafts")
    ).json()) as ListRepoMapDraftsResponse;
    expect(list.drafts).toEqual([]);
  });

  it("消せる。消しても今月の枠は戻らない", async () => {
    expect((await call("DELETE", `/v1/repo-map-drafts/${created.id}`)).status).toBe(204);
    expect((await call("GET", `/v1/repo-map-drafts/${created.id}`)).status).toBe(404);
    const list = (await (
      await call("GET", "/v1/repo-map-drafts")
    ).json()) as ListRepoMapDraftsResponse;
    expect(list.usage.monthlyDrafts).toBe(1);
  });
});
