/**
 * 要約の段（#249 の PR C2a）。下書きの材料から、文書・コード・Issue を AI で要約し、データの形を機械で読む。
 *
 * 流れ（スパイクの ④⑤⑥⑧）:
 * 1. 文書（指定 → 用語集 → README → 浅い順）を最大 {@link DOC_SLOTS} 件、本文の先頭 4,000 バイトを要約
 * 2. 重要なコードを AI に選ばせ（指定されたファイルを先に入れ、残りを選ばせる）、最大 {@link CODE_SLOTS} 件を要約
 * 3. Issue のタイトルから選ばせ（指定を先に）、最大 {@link ISSUE_SLOTS} 件の本文の冒頭を要約
 * 4. データの形（`schema.rb` など。指定されたものを含む）を AI なしで読み、名前だけ取る
 *
 * **1 リクエストの外部呼び出しは {@link MAX_SUBREQUESTS} 回に収める**（Workers 無料プランは 50 回で、
 * D1 の呼び出しも数える可能性がある）。実際に送る回数（Gemini の送り直し・モデルの切り替えを含む）を
 * 数え、次の呼び出しの最悪の回数が残りに収まらなければ、**止めて続きから再開できる形で返す**
 * （`partial`）。選んだ結果は先に下書きへ書き、要約は `(リポジトリ, blob SHA, 役割, 読む上限)` で保管する。
 * 再開では、選び直さず、済んだ要約を使う。
 */

import { utcDayKey, utcMonthKey } from "../contract/ai-usage.js";
import type { RepoMapDraftView } from "../contract/repo-maps.js";
import {
  AiSession,
  AiStageFailure,
  MAX_AI_CALLS_PER_DRAFT,
  SELECT_MAX_OUTPUT_TOKENS,
  SUMMARY_MAX_OUTPUT_TOKENS,
  SUMMARY_THINKING_BUDGET,
} from "./ai.js";
import { codeScore, MAX_HINTS, type KeptFile } from "./classify.js";
import { GitHubError } from "./github.js";
import {
  buildPickCodePrompt,
  buildPickIssuePrompt,
  buildSummaryPrompt,
  FILE_HEAD_BYTES,
  headBytes,
  ISSUE_HEAD_BYTES,
  PROMPT_VERSION,
  type SummaryRole,
} from "./prompts.js";
import type { DraftStage, StoredRepoMapDraft, StoredSummary } from "./repository.js";
import { extractSchemaNames } from "./schema.js";
import {
  draftView,
  parseState,
  RepoMapRefusal,
  requireConsent,
  type FetchedState,
  type MaterialState,
  type RepoMapDeps,
  type SummaryState,
} from "./service.js";

/** 文書の要約の数の上限（指定された文書を含む）。 */
export const DOC_SLOTS = 3;
/** コードの要約の数の上限（指定されたファイルを含む。スパイクと同じ 5）。 */
export const CODE_SLOTS = MAX_HINTS;
/** Issue の要約の数の上限（指定された Issue を含む）。 */
export const ISSUE_SLOTS = MAX_HINTS;
/** 機械で読むデータの形のファイルの数の上限（指定されたものを含む）。 */
export const SCHEMA_FILES = 4;
/** データの形のファイルを読むバイト数の上限。 */
export const SCHEMA_READ_BYTES = 120_000;
/**
 * 1 リクエストで送ってよい外部（GitHub・Gemini）の回数の上限。Workers 無料プランの 50 回から、
 * D1 の呼び出し（約 11 回。保管の書き込みと記録は batch で 1 回）の分を残す。
 */
export const MAX_SUBREQUESTS = 36;

/** 外部呼び出しの残りが足りない。段を止めて、続きから再開できる形で返す合図。 */
class StageBudgetReached extends Error {
  constructor() {
    super("repo map summarize reached its subrequest budget");
    this.name = "StageBudgetReached";
  }
}

/** 実際に送る外部呼び出し（送り直し・モデルの切り替えを含む）の数。 */
class SubrequestBudget {
  private used = 0;
  constructor(private readonly limit: number) {}
  /** 送る前に、最悪の回数の余裕があるか確かめる。足りなければ止める。 */
  require(attempts: number): void {
    if (this.used + attempts > this.limit) throw new StageBudgetReached();
  }
  /** 実際に送ったものを数える（送る直前に呼ぶ）。 */
  count(): void {
    this.used += 1;
  }
}

const depthOf = (path: string) => path.split("/").length;
const isReadme = (path: string) => /(^|\/)readme/i.test(path);

const SHAPE_BODY = {
  error: "ai_response_unusable",
  reason: "shape",
  message: "AI の応答を読み取れませんでした。もう一度お試しください。",
};

function shapeFailure(label: string): AiStageFailure {
  return new AiStageFailure("unusable", 502, SHAPE_BODY, `shape: ${label}`);
}

/** 要約の応答（`{"summary": "..."}`）から本文を取る。形が違えば失敗にする。 */
function summaryText(value: unknown, label: string): string {
  const summary =
    typeof value === "object" && value !== null
      ? (value as { summary?: unknown }).summary
      : undefined;
  if (typeof summary === "string" && summary.trim() !== "") return summary.trim();
  throw shapeFailure(`summary ${label}`);
}

/** 失敗を下書きへ書くときのコード。 */
function failureCodeOf(error: unknown): string {
  if (error instanceof AiStageFailure) return `ai_${error.kind}`;
  if (error instanceof GitHubError) return `github_${error.kind}`;
  return "internal";
}

/** 段の途中の状態。`pending` は終わりに（失敗・中断でも）まとめて保管する。 */
interface Run {
  budget: SubrequestBudget;
  ai: AiSession;
  pending: StoredSummary[];
}

export async function summarizeDraft(
  deps: RepoMapDeps,
  userId: string,
  draftId: string,
  input: { consentVersion?: number | undefined },
): Promise<RepoMapDraftView> {
  const now = deps.now();
  const draft = await deps.drafts.get(userId, draftId);
  if (draft === null || draft.expiresAt <= now.toISOString()) {
    throw new RepoMapRefusal("not_found", "下書きが見つかりません。", {});
  }
  // 済んでいる段は、もう一度呼ばれても何も送らずに結果を返す。
  if (draft.status === "summarized" || draft.status === "candidates") return draftView(draft);
  if (draft.status === "failed" && draft.failedStage !== "summarize") {
    throw new RepoMapRefusal("not_found", "この下書きは要約の段から続けられません。", {});
  }
  const state = parseState(draft);

  // AI へ送る前に、同意（今の版）と、下書きごとの呼び出しの上限を確かめる。
  await requireConsent(deps, userId, input.consentVersion);
  if (draft.aiCalls >= MAX_AI_CALLS_PER_DRAFT) {
    throw new RepoMapRefusal(
      "quota_exceeded",
      "この下書きで使える AI の呼び出しの上限に達しました。新しい下書きを作ってください。",
      { limit: MAX_AI_CALLS_PER_DRAFT, used: draft.aiCalls },
    );
  }
  const aiConfig = deps.ai;
  if (aiConfig === undefined) {
    throw new AiStageFailure(
      "not_configured",
      503,
      { error: "ai_not_configured", message: "AI の設定に問題があります。" },
      "ai config missing",
    );
  }
  const budget = new SubrequestBudget(deps.subrequestBudget ?? MAX_SUBREQUESTS);
  const ai = new AiSession({
    ...aiConfig,
    // 実際に送る回数を数える。送る前に最悪の回数の余裕を確かめるので、ここでは止めない。
    fetch: (url, init) => {
      budget.count();
      return aiConfig.fetch(url, init);
    },
  });
  const run: Run = { budget, ai, pending: [] };
  const stageNow = now.toISOString();

  /** 保管・記録を書く。 */
  const flush = async (): Promise<void> => {
    await deps.drafts.putSummaries(run.pending);
    await deps.drafts.recordAiCalls({
      userId,
      draftId,
      monthKey: utcMonthKey(now),
      dayKey: utcDayKey(now),
      updatedAt: stageNow,
      calls: ai.calls,
    });
  };
  const patch = (status: "fetched" | "summarized" | "failed", next: FetchedState, extra = {}) =>
    deps.drafts.update(userId, draftId, {
      status,
      stageState: JSON.stringify(next),
      stageStateVersion: draft.stageStateVersion,
      failedStage: null,
      failureCode: null,
      updatedAt: stageNow,
      ...extra,
    });

  let progress: NonNullable<FetchedState["progress"]> = { ...state.progress };
  try {
    const summary = await runSummaries(deps, draft, state, run, async (next) => {
      progress = next;
      await patch("fetched", { ...state, progress: next });
    });
    await patch("summarized", { ...state, progress, summary });
    await flush();
  } catch (error) {
    if (error instanceof StageBudgetReached) {
      // 外部呼び出しの上限の手前で止めた。選んだ結果と済んだ要約は保管したので、もう一度呼べば続きから進む。
      await patch("fetched", { ...state, progress });
      await flush();
    } else {
      // 課金された呼び出しと済んだ要約を残し、失敗の段を書いてから、元の失敗を投げ直す。
      // 書けなくても、元の失敗を隠さない（記録して投げ直す）。
      await flush().catch((flushError: unknown) => {
        console.error("failed to flush repo map summaries", { draftId, flushError });
      });
      const stage: DraftStage = "summarize";
      await patch(
        "failed",
        { ...state, progress },
        {
          failedStage: stage,
          failureCode: failureCodeOf(error),
        },
      ).catch((updateError: unknown) => {
        console.error("failed to mark repo map draft as failed", { draftId, updateError });
      });
      throw error;
    }
  }

  const saved = await deps.drafts.get(userId, draftId);
  if (saved === null) throw new Error("repo map draft disappeared after summarize");
  return draftView(saved);
}

async function runSummaries(
  deps: RepoMapDeps,
  draft: StoredRepoMapDraft,
  state: FetchedState,
  run: Run,
  saveProgress: (progress: NonNullable<FetchedState["progress"]>) => Promise<void>,
): Promise<SummaryState> {
  const ref = { owner: draft.repoOwner, name: draft.repoName };
  const { budget, ai } = run;
  const skipped: SummaryState["skipped"] = [];
  const materials: MaterialState[] = [];
  const progress: NonNullable<FetchedState["progress"]> = { ...state.progress };
  const addMaterial = (
    kind: MaterialState["kind"],
    refText: string,
    text: string,
    isPinned: boolean,
  ) => {
    materials.push({
      id: `E${String(materials.length + 1)}`,
      kind,
      ref: refText,
      text,
      pinned: isPinned,
    });
  };

  // GitHub の呼び出しは、送る前に 1 回分の余裕を確かめて数える。
  const github = {
    blob: (file: KeptFile, maxBytes: number) => {
      budget.require(1);
      budget.count();
      return deps.github.getBlobText(ref, file.sha, maxBytes);
    },
    issue: (number: number) => {
      budget.require(1);
      budget.count();
      return deps.github.getIssue(ref, number);
    },
  };
  /** AI へ送る前に、最悪の回数（モデル × 巡）の余裕を確かめる。 */
  const needAi = () => {
    budget.require(ai.worstCaseAttempts);
  };

  // ---- 保管した要約。必要になる分だけを、まとめて引く（D1 の束縛は 100 個まで）。
  const cache = new Map<string, StoredSummary>();
  const cacheKey = (sha: string, role: SummaryRole, limit: number) =>
    `${sha}|${role}|${String(limit)}`;
  const loadCache = async (shas: readonly string[]) => {
    const rows = await deps.drafts.getSummaries({
      repoOwner: ref.owner,
      repoName: ref.name,
      promptVersion: PROMPT_VERSION,
      blobShas: shas,
    });
    for (const row of rows) cache.set(cacheKey(row.blobSha, row.role, row.bytesLimit), row);
  };

  /** 保管があれば使い、無ければ AI で要約して（終わりにまとめて）保管する。 */
  const summarizeOne = async (params: {
    cacheSha: string;
    role: SummaryRole;
    bytesLimit: number;
    label: string;
    readText: () => Promise<string>;
  }): Promise<string> => {
    const hit = cache.get(cacheKey(params.cacheSha, params.role, params.bytesLimit));
    if (hit !== undefined) return hit.summary;
    // 本文を取るより先に、AI へ送る余裕があるかを確かめる（取ったのに送れず、無駄にしない）。
    // 本文の取得（1 回）と送信（最悪の回数）の合計で見る。
    budget.require(1 + ai.worstCaseAttempts);
    const text = await params.readText();
    needAi();
    const value = await ai.json(
      "summarize",
      `summary:${params.label}`,
      buildSummaryPrompt(params.role, params.label, text),
      { maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS, thinkingBudget: SUMMARY_THINKING_BUDGET },
    );
    const summary = summaryText(value, params.label);
    const stored: StoredSummary = {
      repoOwner: ref.owner,
      repoName: ref.name,
      blobSha: params.cacheSha,
      role: params.role,
      bytesLimit: params.bytesLimit,
      summary,
      model: ai.calls[ai.calls.length - 1]?.model ?? "",
      promptVersion: PROMPT_VERSION,
      createdAt: deps.now().toISOString(),
    };
    run.pending.push(stored);
    cache.set(cacheKey(params.cacheSha, params.role, params.bytesLimit), stored);
    return summary;
  };

  const files = state.files;

  // ---- 1. 文書。指定されたものを先に、そのあと用語集 → README → 浅い順。
  const docPool = files
    .filter((f) => f.cls === "glossary" || f.cls === "doc")
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.cls === "glossary") - Number(a.cls === "glossary") ||
        Number(isReadme(b.path)) - Number(isReadme(a.path)) ||
        depthOf(a.path) - depthOf(b.path) ||
        b.size - a.size ||
        a.path.localeCompare(b.path),
    );
  // 指定された文書は枠を超えても入れる（利用者が名指ししている）。
  const pinnedDocs = docPool.filter((f) => f.pinned);
  const docs = [
    ...pinnedDocs,
    ...docPool.filter((f) => !f.pinned).slice(0, Math.max(0, DOC_SLOTS - pinnedDocs.length)),
  ];
  await loadCache(docs.map((f) => f.sha));
  let docChars = 0;
  for (const file of docs) {
    const role: SummaryRole = file.cls === "glossary" ? "glossary" : "doc";
    const summary = await summarizeOne({
      cacheSha: file.sha,
      role,
      bytesLimit: FILE_HEAD_BYTES,
      label: file.path,
      readText: async () => (await github.blob(file, FILE_HEAD_BYTES)).text,
    });
    docChars += summary.length;
    addMaterial(role, file.path, summary, file.pinned);
  }

  // ---- 2. コード。指定されたファイルを先に入れ、残りを AI に選ばせる（選んだ結果は先に書く）。
  // データの形のファイルは、指定されていても AI へは渡さない（4. で機械で読む）。
  const pinnedCode = files.filter(
    (f) => f.pinned && f.cls !== "glossary" && f.cls !== "doc" && f.cls !== "schema",
  );
  const candidates = files
    .filter((f) => !f.pinned && f.cls === "code")
    .sort(
      (a, b) =>
        codeScore(b.path) - codeScore(a.path) || b.size - a.size || a.path.localeCompare(b.path),
    );
  const codeSlots = Math.max(0, CODE_SLOTS - pinnedCode.length);
  if (progress.codePicks === undefined) {
    let picks: string[] = [];
    if (codeSlots > 0 && candidates.length > 0) {
      needAi();
      const overview = materials[0]?.text ?? "(文書なし)";
      const value = await ai.json(
        "select",
        "pick-code",
        buildPickCodePrompt(overview, state.listing, codeSlots),
        { maxOutputTokens: SELECT_MAX_OUTPUT_TOKENS, thinkingBudget: SUMMARY_THINKING_BUDGET },
      );
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        throw shapeFailure("pick-code");
      }
      const known = new Set(candidates.map((f) => f.path));
      // 一覧に無いパスは捨てる（AI が作ったパスを読みに行かない）。
      picks = [...new Set(value as string[])].filter((p) => known.has(p)).slice(0, codeSlots);
    }
    progress.codePicks = picks;
    await saveProgress({ ...progress });
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const picked = progress.codePicks.flatMap((p) => {
    const f = byPath.get(p);
    return f === undefined ? [] : [f];
  });
  const codeFiles = [...pinnedCode, ...picked];
  await loadCache(codeFiles.map((f) => f.sha));
  for (const file of codeFiles) {
    const summary = await summarizeOne({
      cacheSha: file.sha,
      role: "code",
      bytesLimit: FILE_HEAD_BYTES,
      label: file.path,
      readText: async () => (await github.blob(file, FILE_HEAD_BYTES)).text,
    });
    addMaterial("code", file.path, summary, file.pinned);
  }

  // ---- 3. Issue。指定を先に、残りを AI に選ばせる（選んだ結果は先に書く）。
  const pinnedNumbers = draft.hintIssues;
  const pinnedSet = new Set(pinnedNumbers);
  const issuePool = state.issues.filter((i) => !pinnedSet.has(i.number));
  const issueSlots = Math.max(0, ISSUE_SLOTS - pinnedNumbers.length);
  if (progress.issuePicks === undefined) {
    let picks: number[] = [];
    if (issueSlots > 0 && issuePool.length > 0) {
      needAi();
      const titles = issuePool
        .map(
          (i) =>
            `#${String(i.number)} [${i.state}] ${i.title}${i.labels.length > 0 ? ` {${i.labels.join(",")}}` : ""}`,
        )
        .join("\n");
      const value = await ai.json(
        "select",
        "pick-issue",
        buildPickIssuePrompt(titles, issueSlots),
        {
          maxOutputTokens: SELECT_MAX_OUTPUT_TOKENS,
          thinkingBudget: SUMMARY_THINKING_BUDGET,
        },
      );
      if (!Array.isArray(value) || !value.every((v) => typeof v === "number")) {
        throw shapeFailure("pick-issue");
      }
      const known = new Set(issuePool.map((i) => i.number));
      picks = [...new Set(value as number[])].filter((n) => known.has(n)).slice(0, issueSlots);
    }
    progress.issuePicks = picks;
    await saveProgress({ ...progress });
  }
  // 更新日時が一覧で分かるものは、保管のキーを先にまとめて引く。
  const updatedAt = new Map(state.issues.map((i) => [i.number, i.updatedAt]));
  const chosen = [...pinnedNumbers, ...progress.issuePicks];
  await loadCache(
    chosen.flatMap((n) => {
      const at = updatedAt.get(n);
      return at === undefined ? [] : [`issue:${String(n)}:${at}`];
    }),
  );
  for (const number of chosen) {
    const issue = await github.issue(number);
    if (issue.isPullRequest) {
      skipped.push({ ref: `#${String(number)}`, reason: "pull_request" });
      continue;
    }
    const cacheSha = `issue:${String(number)}:${issue.updatedAt}`;
    if (updatedAt.get(number) !== issue.updatedAt) await loadCache([cacheSha]);
    const summary = await summarizeOne({
      cacheSha,
      role: "issue",
      bytesLimit: ISSUE_HEAD_BYTES,
      label: `Issue #${String(number)}`,
      readText: () => Promise.resolve(headBytes(`${issue.title}\n${issue.body}`, ISSUE_HEAD_BYTES)),
    });
    addMaterial("issue", `#${String(number)}`, summary, pinnedSet.has(number));
  }

  // ---- 4. データの形。AI を使わず、名前だけ取る（ファイルそのものは AI へ渡さない）。
  // 指定されたものを先に（捨てる規則は通っていない）。
  const schemaFiles = files
    .filter((f) => f.cls === "schema")
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.path.localeCompare(b.path))
    .slice(0, SCHEMA_FILES);
  const schema: SummaryState["schema"] = [];
  for (const file of schemaFiles) {
    let text: string;
    try {
      text = (await github.blob(file, SCHEMA_READ_BYTES)).text;
    } catch (error) {
      // バイナリは、その 1 ファイルだけ読まなかったものとして残す（段全体は止めない）。
      if (error instanceof GitHubError && error.kind === "unreadable") {
        skipped.push({ ref: file.path, reason: "unreadable" });
        continue;
      }
      throw error;
    }
    const names = extractSchemaNames(file.path, text);
    if (names.length > 0) schema.push({ path: file.path, names });
  }

  return { materials, schema, skipped, docChars };
}
