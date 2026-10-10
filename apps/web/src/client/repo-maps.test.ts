import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api.js";
import {
  buildConfirmRequest,
  confirmRepoMapDraft,
  createRepoMapDraft,
  defaultFolderSelection,
  fetchRepoMapSources,
  inspectRepo,
  loadRepoMapSources,
  MAX_SUMMARIZE_ROUNDS,
  nextStep,
  parseHintFiles,
  parseHintIssues,
  REPO_MAP_DRAFTS_PATH,
  REPO_MAP_INSPECT_PATH,
  RepoMapConsentRequiredError,
  RepoMapError,
  runSummarize,
  summarizeRepoMapDraft,
  validateConfirm,
  validateHints,
  type RepoMapCandidate,
  type RepoMapDraft,
} from "./repo-maps.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const REPO = {
  owner: "Owner",
  name: "Repo",
  url: "github.com/Owner/Repo",
  defaultBranch: "main",
  commitSha: "c".repeat(40),
};

const draft = (overrides: Partial<RepoMapDraft> = {}): RepoMapDraft => ({
  id: "r00000001",
  repo: REPO,
  status: "fetched",
  targets: { folders: [], files: [], issues: [] },
  monorepo: null,
  scan: { blobTotal: 0, kept: {}, dropped: {} },
  listing: "",
  issues: [],
  summary: null,
  candidates: null,
  confirmedMapId: null,
  partial: false,
  ai: { calls: 0, inputTokens: 0, outputTokens: 0 },
  failure: null,
  createdAt: "2026-10-11T00:00:00.000Z",
  expiresAt: "2026-11-10T00:00:00.000Z",
  ...overrides,
});

const candidate = (id: string, overrides: Partial<RepoMapCandidate> = {}): RepoMapCandidate => ({
  id,
  name: `用語${id}`,
  original: "",
  description: `説明${id}`,
  evidence: [],
  fromSchema: false,
  schemaOnly: false,
  ...overrides,
});

describe("API の呼び出し", () => {
  it("下見は URL を POST し、枠の表示つきの結果を返す", async () => {
    const fetcher = vi.fn(async () =>
      json({
        repo: REPO,
        monorepo: null,
        folders: ["apps"],
        scan: { blobTotal: 3, kept: {}, dropped: {} },
        usage: { monthlyDrafts: 1, monthlyDraftsLimit: 3, dailyRebuilds: 0, dailyRebuildsLimit: 5 },
      }),
    ) as unknown as typeof fetch;
    const result = await inspectRepo("github.com/owner/repo", fetcher);
    expect(result.repo.url).toBe("github.com/Owner/Repo");
    const [path, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(path).toBe(REPO_MAP_INSPECT_PATH);
    expect(JSON.parse(String(init?.body))).toEqual({ url: "github.com/owner/repo" });
  });

  it("API が文を添えた失敗は、その文を持つ例外にする（枠の超過は 429 でも、要求過多とは別）", async () => {
    const fetcher = (async () =>
      json(
        { error: "quota_exceeded", message: "今月に作れるマップの数（3）に達しました。", limit: 3 },
        429,
      )) as unknown as typeof fetch;
    const error = await createRepoMapDraft(
      { url: "github.com/o/r", folders: [], files: [], issues: [] },
      fetcher,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoMapError);
    expect((error as RepoMapError).code).toBe("quota_exceeded");
    expect((error as RepoMapError).detail).toContain("今月");
    expect((error as RepoMapError).extra.limit).toBe(3);
  });

  it("文の無い 429 は、要求過多として扱う", async () => {
    const fetcher = (async () => json({ error: "rate_limited" }, 429)) as unknown as typeof fetch;
    const error = await inspectRepo("github.com/o/r", fetcher).catch((e: unknown) => e);
    expect((error as ApiError).kind).toBe("rate_limited");
  });

  it("404（リポジトリが見つからない）は、API の文をそのまま持つ", async () => {
    const fetcher = (async () =>
      json(
        { error: "repo_not_found", message: "リポジトリが見つかりません。" },
        404,
      )) as unknown as typeof fetch;
    const error = await inspectRepo("github.com/o/r", fetcher).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoMapError);
    expect((error as RepoMapError).code).toBe("repo_not_found");
  });

  it("同意が要るときは、文面の版を持つ例外にする", async () => {
    const fetcher = (async () =>
      json(
        { error: "consent_required", message: "同意してください。", version: 3 },
        403,
      )) as unknown as typeof fetch;
    const error = await summarizeRepoMapDraft("r1", undefined, fetcher).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoMapConsentRequiredError);
    expect((error as RepoMapConsentRequiredError).version).toBe(3);
  });

  it("Worker の送信の同意（版も文も無い）は、共通の同意の文面の種別にする", async () => {
    const fetcher = (async () =>
      json({ error: "consent_required" }, 403)) as unknown as typeof fetch;
    const error = await createRepoMapDraft(
      { url: "github.com/o/r", folders: [], files: [], issues: [] },
      fetcher,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(RepoMapError);
    expect((error as ApiError).kind).toBe("consent_required");
  });

  it("2xx でも本文が読めなければ失敗にする", async () => {
    const fetcher = (async () =>
      new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(inspectRepo("github.com/o/r", fetcher)).rejects.toBeInstanceOf(ApiError);
  });

  it("確定は作ったマップの ID を返す", async () => {
    const fetcher = vi.fn(async () => json({ mapId: "mabcd1234" }, 201)) as unknown as typeof fetch;
    const mapId = await confirmRepoMapDraft(
      "r1",
      { accepted: [{ id: "C1" }], title: "題名" },
      fetcher,
    );
    expect(mapId).toBe("mabcd1234");
    const [path, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(path).toBe(`${REPO_MAP_DRAFTS_PATH}/r1/confirm`);
    expect(init?.method).toBe("POST");
  });

  it("根拠は、リポジトリから作っていないマップなら null。それ以外の失敗は例外", async () => {
    const notFound = (async () =>
      json({ error: "repo map source not found" }, 404)) as unknown as typeof fetch;
    await expect(fetchRepoMapSources("m1", notFound)).resolves.toBeNull();
    const broken = (async () => json({ error: "x" }, 500)) as unknown as typeof fetch;
    await expect(fetchRepoMapSources("m1", broken)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("根拠の読み込み（マップの画面）", () => {
  const sources = { repo: { url: "github.com/o/r", commitSha: "c".repeat(40) }, nodes: [] };

  it("共有のマップ（自分のマップでない）は読まない", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(loadRepoMapSources("m1", false, fetcher)).resolves.toEqual({ kind: "none" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("読めたら ok、リポジトリから作っていなければ none（404）", async () => {
    const ok = (async () => json(sources)) as unknown as typeof fetch;
    await expect(loadRepoMapSources("m1", true, ok)).resolves.toEqual({ kind: "ok", sources });
    const none = (async () =>
      json({ error: "repo map source not found" }, 404)) as unknown as typeof fetch;
    await expect(loadRepoMapSources("m1", true, none)).resolves.toEqual({ kind: "none" });
  });

  it("読めなかったときは failed にして記録する（「根拠が無い」と区別する）。ログイン切れは投げる", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = (async () => json({ error: "x" }, 500)) as unknown as typeof fetch;
    await expect(loadRepoMapSources("m1", true, broken)).resolves.toEqual({ kind: "failed" });
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();

    const expired = (async () =>
      json({ error: "session_expired" }, 401)) as unknown as typeof fetch;
    await expect(loadRepoMapSources("m1", true, expired)).rejects.toMatchObject({
      kind: "session_expired",
    });
  });
});

describe("要約の呼び出し", () => {
  it("外部呼び出しの上限で止まる（partial）たびに、続きから呼ぶ", async () => {
    const responses = [
      draft({ partial: true }),
      draft({ partial: true }),
      draft({ status: "summarized" }),
    ];
    const fetcher = vi.fn(async () => json(responses.shift())) as unknown as typeof fetch;
    const rounds: number[] = [];
    const result = await runSummarize("r00000001", undefined, {
      fetcher,
      onRound: (round) => rounds.push(round),
    });
    expect(result.status).toBe("summarized");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(rounds).toEqual([1, 2]);
  });

  it("上限の回数を超えて呼び続けない", async () => {
    const fetcher = vi.fn(async () => json(draft({ partial: true }))) as unknown as typeof fetch;
    const result = await runSummarize("r00000001", 3, { fetcher });
    expect(result.partial).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(MAX_SUMMARIZE_ROUNDS);
    // 同意の版は、毎回の呼び出しに載る。
    const body = JSON.parse(String(vi.mocked(fetcher).mock.calls[0]![1]?.body)) as {
      consentVersion: number;
    };
    expect(body.consentVersion).toBe(3);
  });
});

describe("次に進む段", () => {
  it.each([
    [draft({ status: "fetched" }), { kind: "summarize", resume: false }],
    [draft({ status: "fetched", partial: true }), { kind: "summarize", resume: true }],
    [
      draft({ status: "failed", failure: { stage: "summarize", code: "ai_upstream" } }),
      { kind: "summarize", resume: true },
    ],
    [draft({ status: "summarized" }), { kind: "candidates" }],
    [
      draft({ status: "failed", failure: { stage: "candidates", code: "ai_unusable" } }),
      { kind: "candidates" },
    ],
    [
      draft({ status: "candidates", candidates: { items: [], thin: false, excluded: [] } }),
      { kind: "choose" },
    ],
    [draft({ confirmedMapId: "m1" }), { kind: "confirmed", mapId: "m1" }],
  ] as const)("%#", (input, expected) => {
    expect(nextStep(input)).toEqual(expected);
  });
});

describe("入力の整形と検証", () => {
  it("対象のフォルダの既定は共有のフォルダ。モノレポでなければ全体（空）", () => {
    expect(defaultFolderSelection(null)).toEqual([]);
    expect(
      defaultFolderSelection([
        { path: "apps/web", shared: false },
        { path: "packages/domain", shared: true },
      ]),
    ).toEqual(["packages/domain"]);
  });

  it("参考のファイルは、空行を除き重複を 1 つにする", () => {
    expect(parseHintFiles(" docs/a.md \n\ndocs/a.md\nREADME.md\n")).toEqual([
      "docs/a.md",
      "README.md",
    ]);
  });

  it("参考の Issue は、番号・#番号・URL を読み、読めない行は残す", () => {
    expect(parseHintIssues("12\n#34\nhttps://github.com/o/r/issues/56\n12\nissue です\n0")).toEqual(
      { numbers: [12, 34, 56], invalid: ["issue です", "0"] },
    );
  });

  it("個数の超過・読めない行は、画面向けの文で断る", () => {
    expect(validateHints(["a", "b"], { numbers: [1], invalid: [] })).toBeUndefined();
    expect(validateHints(["1", "2", "3", "4", "5", "6"], { numbers: [], invalid: [] })).toContain(
      "5 個",
    );
    expect(validateHints([], { numbers: [], invalid: ["x"] })).toContain("x");
    expect(validateHints([], { numbers: [1, 2, 3, 4, 5, 6], invalid: [] })).toContain("Issue");
  });
});

describe("確定の入力", () => {
  const items = [candidate("C1"), candidate("C2"), candidate("C3")];

  it("選んだものだけを、候補の順に。直したものだけを送る", () => {
    const request = buildConfirmRequest(
      items,
      new Set(["C3", "C1"]),
      { C1: { name: " 新しい名前 " }, C3: { name: "用語C3", description: "説明C3" } },
      " 題名 ",
    );
    expect(request).toEqual({
      title: "題名",
      accepted: [{ id: "C1", name: "新しい名前" }, { id: "C3" }],
    });
  });

  it("名前・説明を空に直したものは、元に戻さず、送る前に断る", () => {
    const request = buildConfirmRequest(items, new Set(["C1"]), { C1: { name: "  " } }, "");
    expect(request.accepted).toEqual([{ id: "C1", name: "" }]);
    expect(validateConfirm(request)).toContain("空");
    const request2 = buildConfirmRequest(items, new Set(["C1"]), { C1: { description: "" } }, "");
    expect(validateConfirm(request2)).toContain("空");
  });

  it("題名が空なら送らない（リポジトリ名から付く）", () => {
    expect(buildConfirmRequest(items, new Set(["C1"]), {}, "  ").title).toBeUndefined();
  });

  it("選んでいない・多すぎる・長すぎるものは、送る前に断る", () => {
    expect(validateConfirm({ accepted: [] })).toContain("1 つ以上");
    expect(validateConfirm({ accepted: [{ id: "C1" }, { id: "C2" }] }, 1)).toContain("1 個まで");
    expect(validateConfirm({ accepted: [{ id: "C1", name: "あ".repeat(41) }] })).toContain("40");
    expect(validateConfirm({ accepted: [{ id: "C1", description: "あ".repeat(201) }] })).toContain(
      "200",
    );
    expect(validateConfirm({ accepted: [{ id: "C1" }], title: "あ".repeat(81) })).toContain("80");
    expect(validateConfirm({ accepted: [{ id: "C1", name: "あ".repeat(40) }] })).toBeUndefined();
  });
});
