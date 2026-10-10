/**
 * リポジトリからのマップ（Issue #249）の API クライアントと、画面から切り離した判断。
 *
 * 契約は apps/api/src/contract/repo-maps.ts。Web は API のパッケージを import しないので、
 * 使う形だけをここに写す。描画から切り離してあるのは、jsdom が無くても検証できるようにするため
 * （apps/web/AGENTS.md）。
 *
 * 流れ: URL を入れて下見（枠を数えない）→ 下書きを作る（月の枠に数える）→ 要約 → 候補 →
 * 候補を選んで確定 → マップ。確定したマップには根拠（パス・要約・リンク）が付く。
 */

import { ApiError, writeErrorOf } from "./api.js";

const BASE = "/api/v1";
export const REPO_MAP_INSPECT_PATH = `${BASE}/repo-maps:inspect`;
export const REPO_MAP_DRAFTS_PATH = `${BASE}/repo-map-drafts`;

/** API と同じ入力の上限。入力欄の `maxLength` と検証に使う。 */
export const REPO_MAP_LIMITS = {
  hints: 5,
  folders: 50,
  title: 80,
  name: 40,
  description: 200,
} as const;

/** 下見・下書きの作成は GitHub を読むだけ（数秒）。 */
export const REPO_MAP_FETCH_TIMEOUT_MS = 30_000;
/** 要約・候補・確定は AI を順に呼ぶ（上流を最大 150 秒待つ）。確認問題より長い。 */
export const REPO_MAP_AI_TIMEOUT_MS = 330_000;

export type RepoMapEvidenceKind = "glossary" | "doc" | "code" | "issue" | "schema";

export interface RepoMapRepoInfo {
  owner: string;
  name: string;
  url: string;
  defaultBranch: string;
  commitSha: string;
}

export interface RepoMapUsage {
  monthlyDrafts: number;
  monthlyDraftsLimit: number;
  dailyRebuilds: number;
  dailyRebuildsLimit: number;
}

export interface RepoMapWorkspaceFolder {
  path: string;
  shared: boolean;
}

export interface RepoMapScan {
  blobTotal: number;
  kept: Partial<Record<"glossary" | "doc" | "schema" | "code" | "other", number>>;
  dropped: Partial<Record<string, number>>;
}

export interface InspectRepoResult {
  repo: RepoMapRepoInfo;
  monorepo: RepoMapWorkspaceFolder[] | null;
  folders: string[];
  scan: RepoMapScan;
  usage: RepoMapUsage;
}

export interface RepoMapMaterial {
  id: string;
  kind: RepoMapEvidenceKind;
  ref: string;
  url: string;
  text: string;
  pinned: boolean;
}

export interface RepoMapCandidate {
  id: string;
  name: string;
  original: string;
  description: string;
  evidence: { id: string; kind: RepoMapEvidenceKind; ref: string; url: string }[];
  fromSchema: boolean;
  schemaOnly: boolean;
}

export interface RepoMapDraft {
  id: string;
  repo: RepoMapRepoInfo;
  status: "fetched" | "summarized" | "candidates" | "failed";
  targets: { folders: string[]; files: string[]; issues: number[] };
  monorepo: RepoMapWorkspaceFolder[] | null;
  scan: RepoMapScan;
  listing: string;
  issues: { number: number; title: string }[];
  summary: {
    materials: RepoMapMaterial[];
    schema: { path: string; url: string; names: string[] }[];
    skipped: { ref: string; reason: string }[];
    docChars: number;
  } | null;
  candidates: { items: RepoMapCandidate[]; thin: boolean; excluded: string[] } | null;
  confirmedMapId: string | null;
  partial: boolean;
  ai: { calls: number; inputTokens: number; outputTokens: number };
  failure: { stage: "fetch" | "summarize" | "candidates"; code: string } | null;
  createdAt: string;
  expiresAt: string;
}

export interface RepoMapSources {
  repo: { url: string; commitSha: string };
  nodes: {
    conceptId: string;
    sources: {
      kind: RepoMapEvidenceKind;
      path: string | null;
      issueNumber: number | null;
      url: string;
      summary: string;
    }[];
  }[];
}

/** API が画面向けの文を添えて返した失敗。`code` は API の `error`。 */
export class RepoMapError extends ApiError {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super("unavailable");
  }
}

/** 同意が無い（または文面の版が変わった）ため、API が送る前に止めた。 */
export class RepoMapConsentRequiredError extends ApiError {
  constructor(readonly version: number) {
    super("consent_required");
  }
}

/** 失敗の本文を種類ごとの例外にする。 */
function failureOf(status: number, body: Record<string, unknown>): ApiError {
  // ログイン切れ・Worker の送信の同意・レート制限は、共通の種別へ分ける。
  const common = writeErrorOf(status, body);
  if (body.error === "consent_required" && typeof body.version === "number") {
    return new RepoMapConsentRequiredError(body.version);
  }
  if (common.kind === "login_required" || common.kind === "session_expired") return common;
  if (common.kind === "auth_unavailable") return common;
  // API が画面向けの文を添えた失敗（枠の超過は 429 でも、短時間の要求過多ではない）。
  if (typeof body.error === "string" && typeof body.message === "string") {
    return new RepoMapError(body.error, body.message, body);
  }
  // 文の無い 404・429 は、共通の種別（見つからない・要求過多）のまま返す。
  if (common.kind === "rate_limited" || common.kind === "not_found") return common;
  // バリデーションの失敗など、画面向けの文を持たない 400。
  if (typeof body.error === "string") return new RepoMapError("invalid_request", body.error, body);
  return common;
}

async function send(
  method: "GET" | "POST" | "DELETE",
  path: string,
  payload: unknown,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method,
      cache: "no-store",
      ...(payload === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError("unavailable");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw failureOf(response.status, body);
  }
  if (response.status === 204) return null;
  try {
    return (await response.json()) as unknown;
  } catch {
    // 2xx でも本文が読めなければ失敗として扱う（RULE-004）。
    throw new ApiError("unavailable");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 下見。保存せず、枠も数えない。 */
export async function inspectRepo(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<InspectRepoResult> {
  const body = await send(
    "POST",
    REPO_MAP_INSPECT_PATH,
    { url },
    fetcher,
    REPO_MAP_FETCH_TIMEOUT_MS,
  );
  if (
    !isObject(body) ||
    !isObject(body.repo) ||
    !isObject(body.usage) ||
    !Array.isArray(body.folders)
  ) {
    throw new ApiError("unavailable");
  }
  return body as unknown as InspectRepoResult;
}

export interface CreateDraftRequest {
  url: string;
  folders: string[];
  files: string[];
  issues: number[];
  consentVersion?: number;
}

/** 下書きを作る。この時点で今月の枠に数える。 */
export async function createRepoMapDraft(
  request: CreateDraftRequest,
  fetcher: typeof fetch = fetch,
): Promise<{ draft: RepoMapDraft; usage: RepoMapUsage }> {
  const body = await send(
    "POST",
    REPO_MAP_DRAFTS_PATH,
    request,
    fetcher,
    REPO_MAP_FETCH_TIMEOUT_MS,
  );
  if (!isObject(body) || !isObject(body.draft) || !isObject(body.usage)) {
    throw new ApiError("unavailable");
  }
  return body as unknown as { draft: RepoMapDraft; usage: RepoMapUsage };
}

export async function fetchRepoMapDrafts(
  fetcher: typeof fetch = fetch,
): Promise<{ drafts: RepoMapDraft[]; usage: RepoMapUsage }> {
  const body = await send(
    "GET",
    REPO_MAP_DRAFTS_PATH,
    undefined,
    fetcher,
    REPO_MAP_FETCH_TIMEOUT_MS,
  );
  if (!isObject(body) || !Array.isArray(body.drafts) || !isObject(body.usage)) {
    throw new ApiError("unavailable");
  }
  return body as unknown as { drafts: RepoMapDraft[]; usage: RepoMapUsage };
}

export async function fetchRepoMapDraft(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<RepoMapDraft> {
  const body = await send(
    "GET",
    `${REPO_MAP_DRAFTS_PATH}/${encodeURIComponent(id)}`,
    undefined,
    fetcher,
    REPO_MAP_FETCH_TIMEOUT_MS,
  );
  if (!isObject(body) || typeof body.id !== "string") throw new ApiError("unavailable");
  return body as unknown as RepoMapDraft;
}

export async function deleteRepoMapDraft(id: string, fetcher: typeof fetch = fetch): Promise<void> {
  await send(
    "DELETE",
    `${REPO_MAP_DRAFTS_PATH}/${encodeURIComponent(id)}`,
    undefined,
    fetcher,
    REPO_MAP_FETCH_TIMEOUT_MS,
  );
}

async function stage(
  id: string,
  step: "summarize" | "candidates" | "rebuild",
  payload: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<RepoMapDraft> {
  const body = await send(
    "POST",
    `${REPO_MAP_DRAFTS_PATH}/${encodeURIComponent(id)}/${step}`,
    payload,
    fetcher,
    REPO_MAP_AI_TIMEOUT_MS,
  );
  if (!isObject(body) || typeof body.id !== "string") throw new ApiError("unavailable");
  return body as unknown as RepoMapDraft;
}

/** 要約。外部呼び出しの上限で止まったら `partial` が true で返る（もう一度呼ぶと続きから進む）。 */
export function summarizeRepoMapDraft(
  id: string,
  consentVersion?: number,
  fetcher: typeof fetch = fetch,
): Promise<RepoMapDraft> {
  return stage(id, "summarize", consentVersion === undefined ? {} : { consentVersion }, fetcher);
}

export function buildRepoMapCandidates(
  id: string,
  consentVersion?: number,
  fetcher: typeof fetch = fetch,
): Promise<RepoMapDraft> {
  return stage(id, "candidates", consentVersion === undefined ? {} : { consentVersion }, fetcher);
}

/** 外す材料の ID（`E1`・`S1`）を指定して、候補だけを作り直す。1 日 5 回まで。 */
export function rebuildRepoMapCandidates(
  id: string,
  excludeIds: readonly string[],
  consentVersion?: number,
  fetcher: typeof fetch = fetch,
): Promise<RepoMapDraft> {
  return stage(
    id,
    "rebuild",
    { excludeIds, ...(consentVersion === undefined ? {} : { consentVersion }) },
    fetcher,
  );
}

export interface ConfirmRequest {
  title?: string;
  accepted: { id: string; name?: string; description?: string }[];
  consentVersion?: number;
}

/** 選んだ候補からマップを作る。作ったマップの ID を返す。 */
export async function confirmRepoMapDraft(
  id: string,
  request: ConfirmRequest,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const body = await send(
    "POST",
    `${REPO_MAP_DRAFTS_PATH}/${encodeURIComponent(id)}/confirm`,
    request,
    fetcher,
    REPO_MAP_AI_TIMEOUT_MS,
  );
  if (!isObject(body) || typeof body.mapId !== "string") throw new ApiError("unavailable");
  return body.mapId;
}

/**
 * 作ったマップの根拠。リポジトリから作ったマップでなければ（404）`null`。
 * 読めなかった（404 以外）ときは例外にする（根拠が「無い」のと区別する）。
 */
export async function fetchRepoMapSources(
  mapId: string,
  fetcher: typeof fetch = fetch,
): Promise<RepoMapSources | null> {
  try {
    const body = await send(
      "GET",
      `${BASE}/repo-maps/${encodeURIComponent(mapId)}/sources`,
      undefined,
      fetcher,
      REPO_MAP_FETCH_TIMEOUT_MS,
    );
    if (!isObject(body) || !isObject(body.repo) || !Array.isArray(body.nodes)) {
      throw new ApiError("unavailable");
    }
    return body as unknown as RepoMapSources;
  } catch (error: unknown) {
    if (error instanceof ApiError && error.kind === "not_found") return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// 画面から切り離した判断
// ---------------------------------------------------------------------------------------------

/** 対象のフォルダの既定の選び方。共有っぽいフォルダ（packages・shared など）を選ぶ。モノレポでなければ空（全体）。 */
export function defaultFolderSelection(monorepo: RepoMapWorkspaceFolder[] | null): string[] {
  if (monorepo === null) return [];
  return monorepo.filter((f) => f.shared).map((f) => f.path);
}

/** 入力欄の文字列を、ファイルのパスの一覧にする。空行は除き、重複は 1 つにする。 */
export function parseHintFiles(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
  ];
}

/**
 * 入力欄の文字列を、Issue 番号の一覧にする（`#12`・`12`・Issue の URL の末尾を受ける）。
 * 読めない行があれば `invalid` に残す（黙って捨てない）。
 */
export function parseHintIssues(text: string): { numbers: number[]; invalid: string[] } {
  const numbers: number[] = [];
  const invalid: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const match = /^(?:#|.*\/issues\/)?([0-9]{1,9})$/.exec(line);
    const value = match?.[1];
    if (value === undefined || Number(value) < 1) {
      invalid.push(line);
      continue;
    }
    if (!numbers.includes(Number(value))) numbers.push(Number(value));
  }
  return { numbers, invalid };
}

/** ヒント（ファイル・Issue）の入力を検証する。問題があれば画面向けの文を返す。 */
export function validateHints(
  files: readonly string[],
  issues: { numbers: number[]; invalid: string[] },
): string | undefined {
  if (files.length > REPO_MAP_LIMITS.hints) {
    return `参考にしてほしいファイルは ${String(REPO_MAP_LIMITS.hints)} 個までです。`;
  }
  if (issues.invalid.length > 0) {
    return `Issue の番号として読めない行があります: ${issues.invalid.join("、")}`;
  }
  if (issues.numbers.length > REPO_MAP_LIMITS.hints) {
    return `参考にしてほしい Issue は ${String(REPO_MAP_LIMITS.hints)} 個までです。`;
  }
  return undefined;
}

/** 下書きが次に進む段。 */
export type RepoMapNextStep =
  | { kind: "confirmed"; mapId: string }
  | { kind: "summarize"; resume: boolean }
  | { kind: "candidates" }
  | { kind: "choose" };

export function nextStep(draft: RepoMapDraft): RepoMapNextStep {
  if (draft.confirmedMapId !== null) return { kind: "confirmed", mapId: draft.confirmedMapId };
  if (draft.status === "candidates" && draft.candidates !== null) return { kind: "choose" };
  if (draft.status === "failed" && draft.failure?.stage === "candidates")
    return { kind: "candidates" };
  if (draft.status === "summarized") return { kind: "candidates" };
  return { kind: "summarize", resume: draft.partial || draft.status === "failed" };
}

/** 「要約」を呼び続ける回数の上限（外部呼び出しの上限で止まるたびに、続きから進む）。 */
export const MAX_SUMMARIZE_ROUNDS = 6;

/**
 * 要約を、終わるまで呼ぶ。上限の手前で止まる（`partial`）たびに続きから進める。
 * 進み具合を `onRound` に渡す。上限の回数でも終わらなければ、その時点の下書きを返す（呼び出し側が表示する）。
 */
export async function runSummarize(
  id: string,
  consentVersion: number | undefined,
  options: {
    fetcher?: typeof fetch;
    onRound?: (round: number, draft: RepoMapDraft) => void;
  } = {},
): Promise<RepoMapDraft> {
  const fetcher = options.fetcher ?? fetch;
  let draft = await summarizeRepoMapDraft(id, consentVersion, fetcher);
  for (let round = 1; draft.partial && round < MAX_SUMMARIZE_ROUNDS; round += 1) {
    options.onRound?.(round, draft);
    draft = await summarizeRepoMapDraft(id, consentVersion, fetcher);
  }
  return draft;
}

export const DROP_REASON_LABELS: Record<string, string> = {
  dependency_dir: "依存・生成物のフォルダ",
  lock_or_generated: "ロック・生成ファイル",
  binary: "画像・バイナリ",
  unreadable_doc: "読めない形式の設計書（PDF・画像）",
  too_large: "大きすぎるファイル",
  duplicate: "同じ内容の重複",
};

export const EVIDENCE_KIND_LABELS: Record<RepoMapEvidenceKind, string> = {
  glossary: "用語集",
  doc: "文書",
  code: "コード",
  issue: "Issue",
  schema: "データの形",
};

/** 候補を、選んだ ID の順の確定の入力にする。表示名・説明は、直したものだけを送る。 */
export function buildConfirmRequest(
  candidates: readonly RepoMapCandidate[],
  selected: ReadonlySet<string>,
  edits: Readonly<Record<string, { name?: string; description?: string } | undefined>>,
  title: string,
): ConfirmRequest {
  const accepted = candidates
    .filter((c) => selected.has(c.id))
    .map((c) => {
      const edit = edits[c.id];
      const name = edit?.name?.trim();
      const description = edit?.description?.trim();
      return {
        id: c.id,
        ...(name !== undefined && name !== "" && name !== c.name ? { name } : {}),
        ...(description !== undefined && description !== "" && description !== c.description
          ? { description }
          : {}),
      };
    });
  const trimmed = title.trim();
  return { accepted, ...(trimmed === "" ? {} : { title: trimmed }) };
}

/** 確定の入力を、送る前に確かめる。問題があれば画面向けの文を返す。 */
export function validateConfirm(request: ConfirmRequest, maxNodes = 30): string | undefined {
  if (request.accepted.length < 1) return "マップに入れる用語を 1 つ以上選んでください。";
  if (request.accepted.length > maxNodes) {
    return `マップに入れられる用語は ${String(maxNodes)} 個までです（${String(request.accepted.length)} 個選んでいます）。`;
  }
  if ((request.title ?? "").length > REPO_MAP_LIMITS.title) {
    return `題名は ${String(REPO_MAP_LIMITS.title)} 文字までです。`;
  }
  for (const item of request.accepted) {
    if ([...(item.name ?? "")].length > REPO_MAP_LIMITS.name) {
      return `表示名は ${String(REPO_MAP_LIMITS.name)} 文字までです。`;
    }
    if ([...(item.description ?? "")].length > REPO_MAP_LIMITS.description) {
      return `説明は ${String(REPO_MAP_LIMITS.description)} 文字までです。`;
    }
  }
  return undefined;
}
