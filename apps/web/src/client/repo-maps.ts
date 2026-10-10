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

import { ApiError, requestJson, writeErrorOf } from "./api.js";

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

/** ノードの種類（#322）。API の `REPO_MAP_NODE_KINDS` と同じ値。 */
export const REPO_MAP_NODE_KINDS = ["core", "event", "state", "record", "system"] as const;
export type RepoMapNodeKind = (typeof REPO_MAP_NODE_KINDS)[number];

export const REPO_MAP_NODE_KIND_LABELS: Record<RepoMapNodeKind, string> = {
  core: "中心の概念",
  event: "出来事・操作",
  state: "状態・指標",
  record: "記録・データ",
  system: "仕組み・外部",
};

/** 知らない値は「種類なし」にする。 */
export function asNodeKind(value: unknown): RepoMapNodeKind | null {
  return typeof value === "string" && (REPO_MAP_NODE_KINDS as readonly string[]).includes(value)
    ? (value as RepoMapNodeKind)
    : null;
}

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

/** 下見が返す、参考ファイルとして選べるファイル。 */
export interface RepoMapFolderStat {
  doc: number;
  code: number;
  schema: number;
}

export interface RepoMapFileOption {
  path: string;
  kind: "glossary" | "doc" | "schema" | "code";
}

export interface InspectRepoResult {
  repo: RepoMapRepoInfo;
  monorepo: RepoMapWorkspaceFolder[] | null;
  folders: string[];
  /** 参考ファイルの候補（古い API では無い）。 */
  files?: RepoMapFileOption[];
  filesTruncated?: boolean;
  /** 指定できるパスの全体（照合用）。古い API では無い。 */
  paths?: string[];
  pathsTruncated?: boolean;
  /** 対象にできるフォルダごとの、読める材料の件数（古い API では無い）。 */
  folderStats?: Record<string, RepoMapFolderStat>;
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
  /** AI が提案した種類。古い下書きでは無い。 */
  kind?: RepoMapNodeKind | null;
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
    /** ノードの種類（古い API・種類なしは無い・null）。 */
    kind?: RepoMapNodeKind | null;
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
  // 版も文も無い consent_required は、Worker の「送信の同意」。共通の文面（設定画面で同意する）にする。
  if (common.kind === "consent_required") return common;
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
  sessionRetries: boolean | number = false,
): Promise<{ drafts: RepoMapDraft[]; usage: RepoMapUsage }> {
  const body = await requestJson<unknown>(REPO_MAP_DRAFTS_PATH, fetcher, sessionRetries);
  if (!isObject(body) || !Array.isArray(body.drafts) || !isObject(body.usage)) {
    throw new ApiError("unavailable");
  }
  return body as unknown as { drafts: RepoMapDraft[]; usage: RepoMapUsage };
}

export async function fetchRepoMapDraft(
  id: string,
  fetcher: typeof fetch = fetch,
  sessionRetries: boolean | number = false,
): Promise<RepoMapDraft> {
  const body = await requestJson<unknown>(
    `${REPO_MAP_DRAFTS_PATH}/${encodeURIComponent(id)}`,
    fetcher,
    sessionRetries,
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
  accepted: {
    id: string;
    name?: string;
    description?: string;
    /** 直した種類。`null` は「種類なし」。省くと候補のまま。 */
    kind?: RepoMapNodeKind | null;
  }[];
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
  sessionRetries: boolean | number = false,
): Promise<RepoMapSources | null> {
  try {
    const body = await requestJson<unknown>(
      `${BASE}/repo-maps/${encodeURIComponent(mapId)}/sources`,
      fetcher,
      sessionRetries,
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

/** マップの画面が出す、根拠の状態。 */
export type RepoMapSourcesState =
  { kind: "none" } | { kind: "ok"; sources: RepoMapSources } | { kind: "failed" };

/**
 * 自分のマップの根拠を読む。読めなくても、マップの閲覧は止めない（失敗は画面に出す）。
 * ログイン切れだけは、マップ自体の読み込みと同じ扱い（呼び出し側の loader の失敗にする）。
 */
export async function loadRepoMapSources(
  mapId: string,
  own: boolean,
  fetcher: typeof fetch = fetch,
  sessionRetries: boolean | number = false,
): Promise<RepoMapSourcesState> {
  if (!own) return { kind: "none" };
  try {
    const sources = await fetchRepoMapSources(mapId, fetcher, sessionRetries);
    return sources === null ? { kind: "none" } : { kind: "ok", sources };
  } catch (error: unknown) {
    if (error instanceof ApiError && error.kind === "session_expired") throw error;
    console.error("failed to load repo map sources", error);
    return { kind: "failed" };
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

/**
 * 手で書かれたパスを、リポジトリの中のパスに揃える。先頭の `/`・`./`、GitHub の
 * `https://github.com/owner/repo/blob/ブランチ/` の接頭辞、`#L10` などの行の指定を取る。
 */
export function normalizeHintPath(raw: string, known?: ReadonlySet<string>): string {
  let path = raw.trim();
  const url = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\/(.+)$/.exec(path);
  if (url?.[1] !== undefined) {
    // URL のときだけ、行の指定（`#L10`・`#L10-L20`）と問い合わせを取る。
    // 普通のパスの `#` は、ファイル名の一部かもしれないので残す。
    const rest = url[1].replace(/#L\d+(?:-L?\d+)?$/, "").replace(/\?.*$/, "");
    const segments = rest.split("/");
    // ブランチ名に `/` が入る（`release/2026`）ので、一覧にあるパスで切れ目を決める。
    // 一覧が無い、または一致しないときは、ブランチを 1 区切りとして外す。
    const cut = known
      ? segments.findIndex((_, i) => i > 0 && known.has(segments.slice(i).join("/")))
      : -1;
    path = segments.slice(cut > 0 ? cut : 1).join("/");
  }
  return path.replace(/^(?:\.\/|\/)+/, "");
}

/** 入力欄の文字列を、ファイルのパスの一覧にする。空行は除き、重複は 1 つにする。 */
export function parseHintFiles(text: string, known?: ReadonlySet<string>): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => normalizeHintPath(line, known))
        .filter((line) => line !== ""),
    ),
  ];
}

export interface HintFileCheck {
  path: string;
  /** 下見の一覧にあるか。一覧が切れているときは確かめられない（`unknown`）。 */
  state: "found" | "missing" | "unknown";
  /** `missing` のとき、名前が近いファイル（大文字小文字違い、または同じファイル名）。 */
  suggestion?: string;
}

/**
 * 指定したファイルが、下見の一覧にあるかを照合する。無いものは、近い名前を添える。
 * 一覧が上限で切れていれば、無いものも「確かめられない」にする（作成時に API が確かめる）。
 */
export function checkHintFiles(
  paths: readonly string[],
  known: readonly string[],
  truncated: boolean,
): HintFileCheck[] {
  const set = new Set(known);
  return paths.map((path): HintFileCheck => {
    if (set.has(path)) return { path, state: "found" };
    if (truncated) return { path, state: "unknown" };
    const lower = path.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    const near =
      known.find((k) => k.toLowerCase() === lower) ??
      known.find((k) => (k.toLowerCase().split("/").pop() ?? "") === base);
    return near === undefined
      ? { path, state: "missing" }
      : { path, state: "missing", suggestion: near };
  });
}

/** 一覧から選べる候補を、検索語で絞る（パスの部分一致、大文字小文字を区別しない）。 */
export function filterFileOptions(
  options: readonly RepoMapFileOption[],
  query: string,
  limit = 50,
): RepoMapFileOption[] {
  const q = query.trim().toLowerCase();
  const hits = q === "" ? options : options.filter((o) => o.path.toLowerCase().includes(q));
  return hits.slice(0, limit);
}

export const FILE_KIND_LABELS: Record<RepoMapFileOption["kind"], string> = {
  glossary: "用語集",
  doc: "文書",
  schema: "データの形",
  code: "コード",
};

/** 根拠・材料を並べる順（用語集 → 文書 → データの形 → コード → Issue）。 */
export const EVIDENCE_ORDER: readonly RepoMapEvidenceKind[] = [
  "glossary",
  "doc",
  "schema",
  "code",
  "issue",
];

/** 種類ごとの件数を「文書 1・コード 5・Issue 3」の形にする（0 件の種類は出さない）。 */
export function evidenceCounts(items: readonly { kind: RepoMapEvidenceKind }[]): string {
  const counts = new Map<RepoMapEvidenceKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return EVIDENCE_ORDER.filter((kind) => counts.has(kind))
    .map((kind) => `${EVIDENCE_KIND_LABELS[kind]} ${String(counts.get(kind))}`)
    .join("・");
}

/** 種類ごとのグループにする（`EVIDENCE_ORDER` の順。空のグループは作らない）。 */
export function groupByEvidenceKind<T extends { kind: RepoMapEvidenceKind }>(
  items: readonly T[],
): { kind: RepoMapEvidenceKind; items: T[] }[] {
  return EVIDENCE_ORDER.map((kind) => ({
    kind,
    items: items.filter((i) => i.kind === kind),
  })).filter((group) => group.items.length > 0);
}

/** パスを「フォルダ」と「ファイル名」に分ける。長いパスの接頭辞を見出しに回すために使う。 */
export function splitPath(path: string): { dir: string; base: string } {
  const index = path.lastIndexOf("/");
  return index < 0
    ? { dir: "", base: path }
    : { dir: path.slice(0, index), base: path.slice(index + 1) };
}

export type CandidateSort = "default" | "evidence";

/**
 * 候補の一覧に出す順と絞り込み。`default` は AI が返した順のまま。
 * `evidence` は根拠が多い順（同数は元の順）。検索語は表示名・原文・説明に部分一致で効く。
 */
export function arrangeCandidates(
  candidates: readonly RepoMapCandidate[],
  options: {
    query: string;
    sort: CandidateSort;
    names: Readonly<Record<string, string | undefined>>;
  },
): RepoMapCandidate[] {
  const q = options.query.trim().toLowerCase();
  const matched =
    q === ""
      ? [...candidates]
      : candidates.filter((c) =>
          [options.names[c.id] ?? c.name, c.original, c.description].some((t) =>
            t.toLowerCase().includes(q),
          ),
        );
  if (options.sort === "default") return matched;
  const order = new Map(candidates.map((c, i) => [c.id, i]));
  return matched.sort(
    (a, b) =>
      b.evidence.length - a.evidence.length || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
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
  edits: Readonly<
    Record<
      string,
      { name?: string; description?: string; kind?: RepoMapNodeKind | null } | undefined
    >
  >,
  title: string,
): ConfirmRequest {
  const accepted = candidates
    .filter((c) => selected.has(c.id))
    .map((c) => {
      const edit = edits[c.id];
      const name = edit?.name?.trim();
      const description = edit?.description?.trim();
      // 空に直したものは、元に戻さずそのまま送る（validateConfirm が断る）。
      return {
        id: c.id,
        ...(name !== undefined && name !== c.name ? { name } : {}),
        ...(description !== undefined && description !== c.description ? { description } : {}),
        // 種類は、直したものだけを送る（候補と同じなら省く）。
        ...(edit?.kind !== undefined && edit.kind !== (c.kind ?? null) ? { kind: edit.kind } : {}),
      };
    });
  const trimmed = title.trim();
  return { accepted, ...(trimmed === "" ? {} : { title: trimmed }) };
}

/** 確定の入力を、送る前に確かめる。問題があれば画面向けの文を返す。 */
export function validateConfirm(
  request: ConfirmRequest,
  maxNodes = 30,
  candidates: readonly RepoMapCandidate[] = [],
): string | undefined {
  if (request.accepted.length < 1) return "マップに入れる用語を 1 つ以上選んでください。";
  if (request.accepted.length > maxNodes) {
    return `マップに入れられる用語は ${String(maxNodes)} 個までです（${String(request.accepted.length)} 個選んでいます）。`;
  }
  if ((request.title ?? "").length > REPO_MAP_LIMITS.title) {
    return `題名は ${String(REPO_MAP_LIMITS.title)} 文字までです。`;
  }
  for (const item of request.accepted) {
    if (item.name !== undefined && item.name === "") return "表示名を空にはできません。";
    if (item.description !== undefined && item.description === "") {
      return "説明を空にはできません。";
    }
    // サーバーは、説明に「（原文: ○○）」を足した最終の説明を 200 文字までで確かめる。同じ計算で見る。
    const base = candidates.find((c) => c.id === item.id);
    if (base !== undefined) {
      const label = item.name ?? base.name;
      const description = item.description ?? base.description;
      const summary =
        base.original !== "" && !label.includes(base.original)
          ? `${description}（原文: ${base.original}）`
          : description;
      if ([...summary].length > REPO_MAP_LIMITS.description) {
        return `「${label}」の説明は、原文の名前（${base.original}）を含めて ${String(REPO_MAP_LIMITS.description)} 文字までです。`;
      }
    }
    if ([...(item.name ?? "")].length > REPO_MAP_LIMITS.name) {
      return `表示名は ${String(REPO_MAP_LIMITS.name)} 文字までです。`;
    }
    if ([...(item.description ?? "")].length > REPO_MAP_LIMITS.description) {
      return `説明は ${String(REPO_MAP_LIMITS.description)} 文字までです。`;
    }
  }
  return undefined;
}

/** マップの根拠の応答から、ノードごとの種類を取り出す（種類なしのノードは入らない）。 */
export function nodeKindsOf(
  state: RepoMapSourcesState | undefined,
): ReadonlyMap<string, RepoMapNodeKind> {
  const kinds = new Map<string, RepoMapNodeKind>();
  if (state === undefined || state.kind !== "ok") return kinds;
  for (const node of state.sources.nodes) {
    const kind = asNodeKind(node.kind);
    if (kind !== null) kinds.set(node.conceptId, kind);
  }
  return kinds;
}

/** 作成の手順（左上に出す）。`current` は 1 始まり。5 は「全部済み」。 */
export const WIZARD_STEP_LABELS = [
  "リポジトリを選ぶ",
  "材料を読む",
  "用語を選ぶ",
  "マップができる",
] as const;

export interface WizardStep {
  label: string;
  state: "done" | "current" | "todo";
}

export function wizardSteps(current: 1 | 2 | 3 | 4 | 5): WizardStep[] {
  return WIZARD_STEP_LABELS.map((label, index) => ({
    label,
    state: index + 1 < current ? "done" : index + 1 === current ? "current" : "todo",
  }));
}

/** 下書きの段から、手順のどこにいるか。確定済みは全部済み。 */
export function wizardStepOf(step: RepoMapNextStep): 2 | 3 | 5 {
  if (step.kind === "confirmed") return 5;
  return step.kind === "choose" ? 3 : 2;
}

export interface KindColumn<T> {
  /** `null` は「種類なし」の列。 */
  kind: RepoMapNodeKind | null;
  items: T[];
}

/**
 * 候補を種類ごとの列にする。種類の 5 列は、空でも必ず出す（ドロップ先になる）。
 * 「種類なし」の列は、中身があるときだけ末尾に出す。列の中は、渡された順のまま。
 */
export function groupByKind<T>(
  items: readonly T[],
  kindOf: (item: T) => RepoMapNodeKind | null,
  /** 「種類なし」の列を、空でも出す（ドロップ先にする）。 */
  alwaysNone = false,
): KindColumn<T>[] {
  const columns: KindColumn<T>[] = REPO_MAP_NODE_KINDS.map((kind) => ({ kind, items: [] }));
  const none: KindColumn<T> = { kind: null, items: [] };
  for (const item of items) {
    const kind = kindOf(item);
    (columns.find((c) => c.kind === kind) ?? none).items.push(item);
  }
  return alwaysNone || none.items.length > 0 ? [...columns, none] : columns;
}

/** 候補の種類。直した種類があればそれ（`null` は種類なしに直した）。 */
export function effectiveKind(
  candidate: Pick<RepoMapCandidate, "kind">,
  edit: { kind?: RepoMapNodeKind | null } | undefined,
): RepoMapNodeKind | null {
  return edit?.kind !== undefined ? edit.kind : (candidate.kind ?? null);
}

/** ドラッグで運んでいる候補の ID を、dataTransfer に載せる／取り出すときの型名。 */
export const CANDIDATE_DRAG_TYPE = "application/x-repo-map-candidate";

export interface ScopeRow {
  path: string;
  shared: boolean;
  /** このフォルダを読むか（何も選ばなければ全体を読むので、全部 true）。 */
  reading: boolean;
  /** 件数。古い API（`folderStats` なし）では `null`。 */
  stat: RepoMapFolderStat | null;
  /** このフォルダの中の、参考ファイルの数。 */
  pinned: number;
}

export interface ScopeSummary {
  rows: ScopeRow[];
  /** 何も選んでいない（全体を読む）。 */
  readsAll: boolean;
  /** 読む材料の合計。数えられないとき（古い API）は `null`。 */
  totals: RepoMapFolderStat | null;
  /** 選んだフォルダの外にある参考ファイル（それでも読む）。 */
  outsidePinned: number;
}

/**
 * 「読む範囲」の表示を作る。フォルダの選び方を変えるたびに、何をどれだけ読むかがその場で変わる。
 * 入れ子のフォルダを両方選んでも、合計は二重に数えない。
 */
export function scopeSummary(
  inspected: Pick<InspectRepoResult, "monorepo" | "folders" | "folderStats" | "scan">,
  selected: ReadonlySet<string>,
  hintFiles: readonly string[],
  maxFolders: number = REPO_MAP_LIMITS.folders,
): ScopeSummary {
  const readsAll = selected.size === 0;
  const candidates: { path: string; shared: boolean }[] =
    inspected.monorepo ??
    inspected.folders.slice(0, maxFolders).map((path) => ({ path, shared: false }));
  const inside = (file: string, folder: string) => file.startsWith(`${folder}/`);
  const rows = candidates.map((c) => ({
    path: c.path,
    shared: c.shared,
    reading: readsAll || selected.has(c.path),
    stat: inspected.folderStats?.[c.path] ?? null,
    pinned: hintFiles.filter((f) => inside(f, c.path)).length,
  }));
  let totals: RepoMapFolderStat | null = null;
  if (readsAll) {
    const kept = inspected.scan.kept;
    totals = {
      doc: (kept.doc ?? 0) + (kept.glossary ?? 0),
      code: kept.code ?? 0,
      schema: kept.schema ?? 0,
    };
  } else if (inspected.folderStats !== undefined) {
    const chosen = [...selected].filter(
      (p) => !selected.has(p) || ![...selected].some((o) => o !== p && inside(p, o)),
    );
    totals = { doc: 0, code: 0, schema: 0 };
    for (const path of chosen) {
      const stat = inspected.folderStats[path];
      if (stat === undefined) continue;
      totals.doc += stat.doc;
      totals.code += stat.code;
      totals.schema += stat.schema;
    }
  }
  const outsidePinned = readsAll
    ? 0
    : hintFiles.filter((f) => ![...selected].some((folder) => inside(f, folder))).length;
  return { rows, readsAll, totals, outsidePinned };
}
