/**
 * 要約の段（#249 の PR C2a）。下書きの材料から、文書・コード・Issue を AI で要約し、データの形を機械で読む。
 *
 * 流れ（スパイクの ④⑤⑥⑧）:
 * 1. 文書（用語集 → README → 浅い文書）を最大 {@link DOC_SLOTS} 件、本文の先頭 4,000 バイトを要約
 * 2. 重要なコードを AI に選ばせ（指定されたファイルを先に入れ、残りを選ばせる）、最大 {@link CODE_SLOTS} 件を要約
 * 3. Issue のタイトルから選ばせ（指定を先に）、最大 {@link ISSUE_SLOTS} 件の本文の冒頭を要約
 * 4. データの形（`schema.rb` など）を AI なしで読み、名前だけ取る
 *
 * 要約は `(リポジトリ, blob SHA, 役割, 読む上限)` で保管し、同じ中身を 2 度要約しない。途中で失敗しても
 * 済んだ分は保管済みなので、やり直しは続きから進む。1 リクエストの外部呼び出しは
 * {@link MAX_SUBREQUESTS} 回に収める（Workers 無料プランの 50 回に、D1 の呼び出しの分を残す）。
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
/** 機械で読むデータの形のファイルの数の上限。 */
export const SCHEMA_FILES = 4;
/** データの形のファイルを読むバイト数の上限。 */
export const SCHEMA_READ_BYTES = 120_000;
/**
 * 1 リクエストで呼んでよい外部（GitHub・Gemini）の回数の上限。Workers 無料プランは 50 回で、
 * D1 の呼び出しも数えるので、10 回分を残す。想定の最大は 36 回（文書 5 + コード 5 + データの形 4 +
 * Issue 5 + 要約 15 + 選択 2 の内訳。docs/ai-limits.md）。
 */
export const MAX_SUBREQUESTS = 40;

/** 外部呼び出しの回数の管理。上限を超える設計の誤りは、送る前に例外にする。 */
class SubrequestBudget {
  private used = 0;
  take(label: string): void {
    this.used += 1;
    if (this.used > MAX_SUBREQUESTS) {
      throw new Error(
        `repo map summarize exceeded ${String(MAX_SUBREQUESTS)} subrequests: ${label}`,
      );
    }
  }
}

const depthOf = (path: string) => path.split("/").length;
const isReadme = (path: string) => /(^|\/)readme/i.test(path);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number");
}

/** 要約の応答（`{"summary": "..."}`）から本文を取る。形が違えば失敗にする。 */
function summaryText(value: unknown, label: string): string {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { summary?: unknown }).summary === "string" &&
    (value as { summary: string }).summary.trim() !== ""
  ) {
    return (value as { summary: string }).summary.trim();
  }
  throw new AiStageFailure(
    "unusable",
    502,
    {
      error: "ai_response_unusable",
      reason: "shape",
      message: "AI の応答を読み取れませんでした。もう一度お試しください。",
    },
    `summary shape: ${label}`,
  );
}

/** 失敗を下書きへ書き、応答にする失敗の種類。 */
function failureCodeOf(error: unknown): string {
  if (error instanceof AiStageFailure) return `ai_${error.kind}`;
  if (error instanceof GitHubError) return `github_${error.kind}`;
  return "internal";
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
  if (deps.ai === undefined) {
    throw new AiStageFailure(
      "not_configured",
      503,
      { error: "ai_not_configured", message: "AI の設定に問題があります。" },
      "ai config missing",
    );
  }
  const ai = new AiSession(deps.ai);
  const stageNow = now.toISOString();

  const record = async () => {
    await deps.drafts.recordAiCalls({
      userId,
      draftId,
      monthKey: utcMonthKey(now),
      dayKey: utcDayKey(now),
      updatedAt: stageNow,
      calls: ai.calls,
    });
  };

  try {
    const summary = await runSummaries(deps, draft, state, ai);
    const next: FetchedState = { ...state, summary };
    await deps.drafts.update(userId, draftId, {
      status: "summarized",
      stageState: JSON.stringify(next),
      stageStateVersion: draft.stageStateVersion,
      failedStage: null,
      failureCode: null,
      updatedAt: stageNow,
    });
    await record();
  } catch (error) {
    // 呼び出しの記録と、失敗の状態を残してから投げ直す。記録に失敗しても元の失敗を隠さない。
    const stage: DraftStage = "summarize";
    await record().catch((recordError: unknown) => {
      console.error("failed to record repo map ai calls", { draftId, recordError });
    });
    await deps.drafts
      .update(userId, draftId, {
        status: "failed",
        stageState: draft.stageState,
        stageStateVersion: draft.stageStateVersion,
        failedStage: stage,
        failureCode: failureCodeOf(error),
        updatedAt: stageNow,
      })
      .catch((updateError: unknown) => {
        console.error("failed to mark repo map draft as failed", { draftId, updateError });
      });
    throw error;
  }

  const saved = await deps.drafts.get(userId, draftId);
  if (saved === null) throw new Error("repo map draft disappeared after summarize");
  return draftView(saved);
}

async function runSummaries(
  deps: RepoMapDeps,
  draft: StoredRepoMapDraft,
  state: FetchedState,
  ai: AiSession,
): Promise<SummaryState> {
  const ref = { owner: draft.repoOwner, name: draft.repoName };
  const budget = new SubrequestBudget();
  const skipped: SummaryState["skipped"] = [];
  const materials: MaterialState[] = [];
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

  // ---- 保管した要約を、まとめて 1 回で引く（ファイルの blob SHA が分かっている分）。
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

  /** 保管があれば使い、無ければ AI で要約して保管する。 */
  const summarizeOne = async (params: {
    cacheSha: string;
    role: SummaryRole;
    bytesLimit: number;
    label: string;
    readText: () => Promise<string>;
  }): Promise<string> => {
    const hit = cache.get(cacheKey(params.cacheSha, params.role, params.bytesLimit));
    if (hit !== undefined) return hit.summary;
    const text = await params.readText();
    budget.take(`summary ${params.label}`);
    const value = await ai.json(
      "summarize",
      `summary:${params.label}`,
      buildSummaryPrompt(params.role, params.label, text),
      { maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS, thinkingBudget: SUMMARY_THINKING_BUDGET },
    );
    const summary = summaryText(value, params.label);
    const model = ai.calls[ai.calls.length - 1]?.model ?? "";
    await deps.drafts.putSummary({
      repoOwner: ref.owner,
      repoName: ref.name,
      blobSha: params.cacheSha,
      role: params.role,
      bytesLimit: params.bytesLimit,
      summary,
      model,
      promptVersion: PROMPT_VERSION,
      createdAt: deps.now().toISOString(),
    });
    return summary;
  };

  const readBlob = (file: KeptFile, maxBytes: number) => async () => {
    budget.take(`blob ${file.path}`);
    return (await deps.github.getBlobText(ref, file.sha, maxBytes)).text;
  };

  const files = state.files;
  const schemaFiles = files.filter((f) => f.cls === "schema" && !f.pinned).slice(0, SCHEMA_FILES);
  await loadCache(files.map((f) => f.sha));

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
  let docChars = 0;
  for (const file of docs) {
    const role: SummaryRole = file.cls === "glossary" ? "glossary" : "doc";
    const summary = await summarizeOne({
      cacheSha: file.sha,
      role,
      bytesLimit: FILE_HEAD_BYTES,
      label: file.path,
      readText: async () => headBytes(await readBlob(file, FILE_HEAD_BYTES)(), FILE_HEAD_BYTES),
    });
    docChars += summary.length;
    addMaterial(role, file.path, summary, file.pinned);
  }

  // ---- 2. コード。指定されたファイルを先に入れ、残りを AI に選ばせる。
  const pinnedCode = files.filter((f) => f.pinned && f.cls !== "glossary" && f.cls !== "doc");
  const candidates = files
    .filter((f) => !f.pinned && f.cls === "code")
    .sort(
      (a, b) =>
        codeScore(b.path) - codeScore(a.path) || b.size - a.size || a.path.localeCompare(b.path),
    );
  const codeSlots = Math.max(0, CODE_SLOTS - pinnedCode.length);
  let picked: KeptFile[] = [];
  if (codeSlots > 0 && candidates.length > 0) {
    budget.take("pick code");
    const overview = materials[0]?.text ?? "(文書なし)";
    const value = await ai.json(
      "select",
      "pick-code",
      buildPickCodePrompt(overview, state.listing, codeSlots),
      { maxOutputTokens: SELECT_MAX_OUTPUT_TOKENS, thinkingBudget: SUMMARY_THINKING_BUDGET },
    );
    if (!isStringArray(value)) {
      throw new AiStageFailure(
        "unusable",
        502,
        {
          error: "ai_response_unusable",
          reason: "shape",
          message: "AI の応答を読み取れませんでした。もう一度お試しください。",
        },
        "pick-code shape",
      );
    }
    const byPath = new Map(candidates.map((f) => [f.path, f]));
    // 一覧に無いパスは捨てる（AI が作ったパスを読みに行かない）。
    picked = [...new Set(value)]
      .flatMap((p) => {
        const f = byPath.get(p);
        return f === undefined ? [] : [f];
      })
      .slice(0, codeSlots);
  }
  for (const file of [...pinnedCode, ...picked]) {
    const summary = await summarizeOne({
      cacheSha: file.sha,
      role: "code",
      bytesLimit: FILE_HEAD_BYTES,
      label: file.path,
      readText: async () => headBytes(await readBlob(file, FILE_HEAD_BYTES)(), FILE_HEAD_BYTES),
    });
    addMaterial("code", file.path, summary, file.pinned);
  }

  // ---- 3. Issue。指定を先に、残りを AI に選ばせる。
  const pinnedNumbers = draft.hintIssues;
  const pinnedSet = new Set(pinnedNumbers);
  const issuePool = state.issues.filter((i) => !pinnedSet.has(i.number));
  const issueSlots = Math.max(0, ISSUE_SLOTS - pinnedNumbers.length);
  let chosen: number[] = [...pinnedNumbers];
  if (issueSlots > 0 && issuePool.length > 0) {
    budget.take("pick issue");
    const titles = issuePool
      .map(
        (i) =>
          `#${String(i.number)} [${i.state}] ${i.title}${i.labels.length > 0 ? ` {${i.labels.join(",")}}` : ""}`,
      )
      .join("\n");
    const value = await ai.json("select", "pick-issue", buildPickIssuePrompt(titles, issueSlots), {
      maxOutputTokens: SELECT_MAX_OUTPUT_TOKENS,
      thinkingBudget: SUMMARY_THINKING_BUDGET,
    });
    if (!isNumberArray(value)) {
      throw new AiStageFailure(
        "unusable",
        502,
        {
          error: "ai_response_unusable",
          reason: "shape",
          message: "AI の応答を読み取れませんでした。もう一度お試しください。",
        },
        "pick-issue shape",
      );
    }
    const known = new Set(issuePool.map((i) => i.number));
    chosen = [...chosen, ...[...new Set(value)].filter((n) => known.has(n)).slice(0, issueSlots)];
  }
  for (const number of chosen) {
    budget.take(`issue #${String(number)}`);
    const issue = await deps.github.getIssue(ref, number);
    if (issue.isPullRequest) {
      skipped.push({ ref: `#${String(number)}`, reason: "pull_request" });
      continue;
    }
    const cacheSha = `issue:${String(number)}:${issue.updatedAt}`;
    await loadCache([cacheSha]);
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
  const schema: SummaryState["schema"] = [];
  for (const file of schemaFiles) {
    let text: string;
    try {
      budget.take(`schema ${file.path}`);
      text = (await deps.github.getBlobText(ref, file.sha, SCHEMA_READ_BYTES)).text;
    } catch (error) {
      // バイナリ・取得失敗は、その 1 ファイルだけ読まなかったものとして残す（段全体は止めない）。
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
