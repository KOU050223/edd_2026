/**
 * リポジトリからのマップの下書き（#249 の PR C1）。取得 → 分類 → 絞り込み → 一覧の圧縮まで。AI は使わない。
 *
 * 順序が要である。**GitHub の呼び出しと検証を全部済ませてから、月の枠を確保して保存する。**
 * GitHub の失敗や指定の誤りで、月 3 マップの枠を消費させない。
 */

import { MAP_GENERATION_CONSENT_VERSION, type ConsentRecord } from "@gakushu-sochi/domain";
import { nextUtcMonth, utcDayKey, utcMonthKey, type Plan } from "../contract/ai-usage.js";
import {
  REPO_MAP_DRAFT_TTL_DAYS,
  REPO_MAP_LIMITS,
  type CreateRepoMapDraftInput,
  type InspectRepoResponse,
  type RepoMapDraftView,
  type RepoMapRepoInfo,
  type RepoMapScan,
  type RepoMapUsageView,
  type RepoMapWorkspaceFolder,
} from "../contract/repo-maps.js";
import {
  analyzeTree,
  codeScore,
  compressListing,
  detectMonorepo,
  filterByFolders,
  validateTargets,
  type Analysis,
  type KeptFile,
  type TargetError,
} from "./classify.js";
import type { GitHubClient, IssueSummary, TreeEntry } from "./github.js";
import type { RepoMapDraftRepository, RepoMapUsage, StoredRepoMapDraft } from "./repository.js";
import { parseRepoUrl, repoUrl, type RepoRef } from "./url.js";

/** 一覧に載せる Issue のタイトルの数。 */
export const ISSUE_TITLE_COUNT = 50;
/** 下書きに残すファイルの数の上限。残す材料は C2 が使う分だけにして、行を小さく保つ。 */
export const STATE_LIMITS = { glossary: 20, schema: 20, doc: 150, code: 150 } as const;
/** `stage_state` の JSON の大きさの上限（バイト）。D1 の 1 行は 2MB まで。 */
export const MAX_STATE_BYTES = 120_000;
/** 作成のたびに一緒に消す、期限切れの下書きの件数の上限。 */
export const SWEEP_LIMIT = 50;
const STATE_VERSION = 1;

/** `stage_state` の中身。形の版は `stage_state_version`。 */
export interface FetchedState {
  scan: RepoMapScan;
  /** 要約の材料にするファイル（上限つき）。指定されたファイルは必ず入る。 */
  files: KeptFile[];
  listing: string;
  monorepo: RepoMapWorkspaceFolder[] | null;
  /** 更新の新しい順のタイトル（PR を除く）。 */
  issues: IssueSummary[];
  /** 利用者が指定した Issue（検証済み）。 */
  pinnedIssues: { number: number; title: string }[];
}

/** 呼び出し側が HTTP の応答へ写す、利用者の入力・状態のせいの失敗。 */
export class RepoMapRefusal extends Error {
  constructor(
    readonly code:
      "invalid_url" | "invalid_target" | "invalid_issue" | "consent_required" | "quota_exceeded",
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RepoMapRefusal";
  }
}

export interface RepoMapDeps {
  github: GitHubClient;
  drafts: RepoMapDraftRepository;
  /** 「今後表示しない」の記録を読む。 */
  consents: { get(userId: string): Promise<ConsentRecord | null> };
  plans: { get(userId: string): Promise<Plan> };
  newId: () => string;
  now: () => Date;
}

interface Source {
  ref: RepoRef;
  repo: RepoMapRepoInfo;
  entries: TreeEntry[];
}

function usageView(usage: RepoMapUsage, plan: Plan): RepoMapUsageView {
  const limits = REPO_MAP_LIMITS[plan];
  return {
    monthlyDrafts: usage.monthlyDrafts,
    monthlyDraftsLimit: limits.monthlyDrafts,
    dailyRebuilds: usage.dailyRebuilds,
    dailyRebuildsLimit: limits.dailyRebuilds,
  };
}

function targetRefusal(error: TargetError): RepoMapRefusal {
  if (error.code === "too_many") {
    return new RepoMapRefusal("invalid_target", `${error.field} は ${error.max} 個までです`, {
      field: error.field,
    });
  }
  if (error.code === "unknown_path") {
    return new RepoMapRefusal("invalid_target", `リポジトリに無いパスです: ${error.path}`, {
      field: error.field,
      path: error.path,
    });
  }
  return new RepoMapRefusal("invalid_issue", `Issue 番号が正しくありません: ${error.number}`, {
    number: error.number,
  });
}

function parseRef(url: string): RepoRef {
  const ref = parseRepoUrl(url);
  if (ref === null) {
    throw new RepoMapRefusal(
      "invalid_url",
      "github.com/owner/repo の形で入れてください（ブランチやパスは付けません）。",
    );
  }
  return ref;
}

/** GitHub から、既定のブランチの先頭とファイルの一覧を取る（3 リクエスト）。 */
async function fetchSource(github: GitHubClient, input: RepoRef): Promise<Source> {
  const info = await github.getRepo(input);
  // 保存・キャッシュのキーは、利用者が入れた綴りではなく GitHub の正式な名前にする。
  const ref: RepoRef = { owner: info.owner, name: info.name };
  const commitSha = await github.getHeadSha(ref, info.defaultBranch);
  const entries = await github.getTree(ref, commitSha);
  return {
    ref,
    repo: {
      owner: ref.owner,
      name: ref.name,
      url: repoUrl(ref),
      defaultBranch: info.defaultBranch,
      commitSha,
    },
    entries,
  };
}

function scanOf(analysis: Analysis): RepoMapScan {
  const kept: RepoMapScan["kept"] = {};
  for (const f of analysis.kept) kept[f.cls] = (kept[f.cls] ?? 0) + 1;
  return { blobTotal: analysis.blobTotal, kept, dropped: analysis.dropped };
}

/** 深さ 2 までのフォルダ。対象のフォルダの候補。 */
function topFolders(entries: TreeEntry[]): string[] {
  return entries
    .filter((e) => e.type === "tree" && e.path.split("/").length <= 2)
    .map((e) => e.path)
    .sort();
}

/** 材料のうち、下書きに残す分だけを選ぶ。指定されたファイルは必ず残す。 */
function selectFiles(kept: KeptFile[]): KeptFile[] {
  const depth = (p: string) => p.split("/").length;
  const byPath = (a: KeptFile, b: KeptFile) => a.path.localeCompare(b.path);
  const pick = (
    cls: KeptFile["cls"],
    limit: number,
    sort: (a: KeptFile, b: KeptFile) => number,
  ) => {
    const all = kept.filter((f) => f.cls === cls && !f.pinned).sort(sort);
    return all.slice(0, limit);
  };
  const docs = pick(
    "doc",
    STATE_LIMITS.doc,
    (a, b) => depth(a.path) - depth(b.path) || byPath(a, b),
  );
  const code = pick(
    "code",
    STATE_LIMITS.code,
    (a, b) => codeScore(b.path) - codeScore(a.path) || b.size - a.size || byPath(a, b),
  );
  return [
    ...kept.filter((f) => f.pinned).sort(byPath),
    ...pick("glossary", STATE_LIMITS.glossary, byPath),
    ...pick("schema", STATE_LIMITS.schema, byPath),
    ...docs,
    ...code,
  ];
}

function buildState(
  source: Source,
  folders: readonly string[],
  hintFiles: readonly string[],
  issues: IssueSummary[],
  pinnedIssues: { number: number; title: string }[],
): FetchedState {
  const inFolders = filterByFolders(source.entries, folders);
  // 指定されたファイルは、対象のフォルダの外にあっても入れる（利用者が名指ししている）。
  const pinned = new Set(hintFiles);
  const extra = source.entries.filter(
    (e) => e.type === "blob" && pinned.has(e.path) && !inFolders.includes(e),
  );
  const analysis = analyzeTree([...inFolders, ...extra], pinned);
  return {
    scan: scanOf(analysis),
    files: selectFiles(analysis.kept),
    listing: compressListing(analysis),
    monorepo: detectMonorepo(source.entries),
    issues,
    pinnedIssues,
  };
}

/** `POST /v1/repo-maps:inspect`。保存せず、枠も数えない。 */
export async function inspectRepo(
  deps: RepoMapDeps,
  userId: string,
  url: string,
): Promise<InspectRepoResponse> {
  const ref = parseRef(url);
  const source = await fetchSource(deps.github, ref);
  const analysis = analyzeTree(source.entries);
  const now = deps.now();
  const [usage, plan] = await Promise.all([
    deps.drafts.usage({ userId, monthKey: utcMonthKey(now), dayKey: utcDayKey(now) }),
    deps.plans.get(userId),
  ]);
  return {
    repo: source.repo,
    monorepo: detectMonorepo(source.entries),
    folders: topFolders(source.entries),
    scan: scanOf(analysis),
    usage: usageView(usage, plan),
  };
}

function toView(draft: StoredRepoMapDraft): RepoMapDraftView {
  const state = JSON.parse(draft.stageState) as FetchedState;
  const ref = { owner: draft.repoOwner, name: draft.repoName };
  return {
    id: draft.id,
    repo: {
      owner: ref.owner,
      name: ref.name,
      url: repoUrl(ref),
      defaultBranch: draft.defaultBranch,
      commitSha: draft.commitSha,
    },
    status: draft.status,
    targets: {
      folders: draft.targetFolders,
      files: draft.hintFiles,
      issues: draft.hintIssues,
    },
    monorepo: state.monorepo,
    scan: state.scan,
    listing: state.listing,
    issues: state.pinnedIssues,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
  };
}

export { toView as draftView, usageView };

/** 今の枠（読み取り）。 */
export async function currentUsage(
  deps: Pick<RepoMapDeps, "drafts" | "plans" | "now">,
  userId: string,
): Promise<RepoMapUsageView> {
  const now = deps.now();
  const [usage, plan] = await Promise.all([
    deps.drafts.usage({ userId, monthKey: utcMonthKey(now), dayKey: utcDayKey(now) }),
    deps.plans.get(userId),
  ]);
  return usageView(usage, plan);
}

/**
 * `POST /v1/repo-map-drafts`。
 *
 * 1. 入力の形・同意（枠を数える前に確かめる）  2. 枠の事前確認（GitHub を呼ぶ前に弾く）
 * 3. GitHub の取得と指定の検証  4. 枠の確保 → 保存（保存に失敗したら枠を戻す）
 */
export async function createDraft(
  deps: RepoMapDeps,
  userId: string,
  input: CreateRepoMapDraftInput,
): Promise<{ draft: RepoMapDraftView; usage: RepoMapUsageView }> {
  const ref = parseRef(input.url);

  if (input.consentVersion !== MAP_GENERATION_CONSENT_VERSION) {
    const stored = await deps.consents.get(userId);
    if (stored?.version !== MAP_GENERATION_CONSENT_VERSION) {
      throw new RepoMapRefusal(
        "consent_required",
        "マップを作る前に、AI へ送る内容を確認して同意してください。",
        { version: MAP_GENERATION_CONSENT_VERSION },
      );
    }
  }

  const now = deps.now();
  const monthKey = utcMonthKey(now);
  const dayKey = utcDayKey(now);
  const plan = await deps.plans.get(userId);
  const limit = REPO_MAP_LIMITS[plan].monthlyDrafts;
  const quotaRefusal = (usage: RepoMapUsage) =>
    new RepoMapRefusal("quota_exceeded", `今月に作れるマップの数（${limit}）に達しました。`, {
      limit,
      used: usage.monthlyDrafts,
      resetsAt: nextUtcMonth(now).toISOString(),
    });

  // 枠が尽きているなら、GitHub を呼ぶ前に断る。確保そのものは取得のあとで 1 文で行う。
  const before = await deps.drafts.usage({ userId, monthKey, dayKey });
  if (before.monthlyDrafts >= limit) throw quotaRefusal(before);

  const source = await fetchSource(deps.github, ref);
  const targetError = validateTargets(source.entries, {
    folders: input.folders,
    files: input.files,
    issues: input.issues,
  });
  if (targetError !== null) throw targetRefusal(targetError);

  // 指定された Issue が PR でないことを確かめる（Issues API は PR も同じ番号空間で返す）。
  const pinnedIssues: { number: number; title: string }[] = [];
  for (const number of input.issues) {
    const issue = await deps.github.getIssue(source.ref, number);
    if (issue.isPullRequest) {
      throw new RepoMapRefusal("invalid_issue", `#${number} は Issue ではなく PR です`, { number });
    }
    pinnedIssues.push({ number: issue.number, title: issue.title });
  }
  const issues = await deps.github.listIssues(source.ref, ISSUE_TITLE_COUNT);

  const state = buildState(source, input.folders, input.files, issues, pinnedIssues);
  const stageState = JSON.stringify(state);
  const stateBytes = new TextEncoder().encode(stageState).length;
  if (stateBytes > MAX_STATE_BYTES) {
    // 上限つきで選んでいるので、ここに来るのは規則の破れ。黙って切らず失敗にする。
    throw new Error(`repo map draft state is too large (${stateBytes} bytes)`);
  }

  const updatedAt = now.toISOString();
  const reserved = await deps.drafts.reserveDraft({ userId, monthKey, dayKey, updatedAt, limit });
  if (!reserved.reserved) throw quotaRefusal(reserved.usage);

  const draft: StoredRepoMapDraft = {
    id: deps.newId(),
    userId,
    repoOwner: source.ref.owner,
    repoName: source.ref.name,
    defaultBranch: source.repo.defaultBranch,
    commitSha: source.repo.commitSha,
    targetFolders: [...input.folders],
    hintFiles: [...input.files],
    hintIssues: [...input.issues],
    status: "fetched",
    stageState,
    stageStateVersion: STATE_VERSION,
    createdAt: updatedAt,
    updatedAt,
    expiresAt: new Date(now.getTime() + REPO_MAP_DRAFT_TTL_DAYS * 86_400_000).toISOString(),
  };
  try {
    await deps.drafts.create(draft);
  } catch (error) {
    // 保存できなかったのに枠だけ消えるのを防ぐ。戻せなくても、元の失敗を隠さない。
    await deps.drafts
      .releaseDraft({ userId, monthKey, updatedAt })
      .catch((releaseError: unknown) => {
        console.error("failed to release repo map draft quota", { userId, releaseError });
      });
    throw error;
  }

  // 期限切れを、作成のついでに少しずつ消す（定期実行は無い）。失敗しても作成は成功させるが、記録する。
  await deps.drafts.deleteExpired(updatedAt, SWEEP_LIMIT).catch((sweepError: unknown) => {
    console.error("failed to sweep expired repo map drafts", { sweepError });
  });

  return { draft: toView(draft), usage: usageView(reserved.usage, plan) };
}
