/**
 * リポジトリからのマップ（Issue #249）の外部契約。
 *
 * 1. `POST /v1/repo-maps:inspect` — URL から、既定のブランチ・commit SHA・モノレポの案内・
 *    フォルダの候補を返す。**保存せず、枠も数えない。** 下書きを作る前に対象のフォルダを選ぶため。
 * 2. `POST /v1/repo-map-drafts` — 下書きを作る。取得 → 分類 → 絞り込み → 一覧の圧縮までを行い
 *    （AI は使わない）、**この時点で月の枠に数える。**
 * 3. `GET /v1/repo-map-drafts`・`GET /v1/repo-map-drafts/:id`・`DELETE /v1/repo-map-drafts/:id`
 *
 * 要約・候補（AI を使う段）は PR C2、確定は PR D。数字の正本は docs/ai-limits.md。
 * 契約はこのアプリに置く（apps/api/AGENTS.md）。
 */

import * as v from "valibot";
import type { Plan } from "./ai-usage.js";
import {
  MAX_MAP_TITLE_LENGTH,
  MAX_NODE_LABEL_LENGTH,
  MAX_NODE_SUMMARY_LENGTH,
} from "./learning-maps.js";

/**
 * ノードの「種類」（#322）。リポジトリから作ったマップだけが持つ。色分けと凡例に使う。
 * 当てはまらない・AI が返さない・知らない値は `null`（種類なし）にする。
 */
export const REPO_MAP_NODE_KINDS = ["core", "event", "state", "record", "system"] as const;
export type RepoMapNodeKind = (typeof REPO_MAP_NODE_KINDS)[number];

export const REPO_MAP_NODE_KIND_LABELS: Record<RepoMapNodeKind, string> = {
  core: "中心の概念",
  event: "出来事・操作",
  state: "状態・指標",
  record: "記録・データ",
  system: "仕組み・外部",
};

/** 外から来た値（AI の応答など）を種類にする。知らない値は `null`。 */
export function normalizeNodeKind(value: unknown): RepoMapNodeKind | null {
  return typeof value === "string" && (REPO_MAP_NODE_KINDS as readonly string[]).includes(value)
    ? (value as RepoMapNodeKind)
    : null;
}

/** リポジトリからのマップの回数の上限（プランごと）。正本は docs/ai-limits.md。 */
export interface RepoMapLimits {
  /** 暦月（UTC）に作れる下書き（マップ）の数。作った時点で数える。 */
  monthlyDrafts: number;
  /** 1 日（UTC）に作り直せる回数。月の枠には数えない。 */
  dailyRebuilds: number;
}

/**
 * free は政策値（docs/ai-limits.md）。plus は**仮の値**で、AI 生成をデバッグする開発者のアカウントが
 * 枠に当たらないために置く（上限を外さないのはバグでの繰り返しを止めるため）。リリース前に決める（#290）。
 */
export const REPO_MAP_LIMITS: Record<Plan, RepoMapLimits> = {
  free: { monthlyDrafts: 3, dailyRebuilds: 5 },
  plus: { monthlyDrafts: 100, dailyRebuilds: 100 },
};

/** 下書きの寿命（日）。過ぎたものは読めない扱いにし、消す。 */
export const REPO_MAP_DRAFT_TTL_DAYS = 30;

/** 「参考にしてほしいファイル・Issue」の個数の上限（各）。 */
export const REPO_MAP_MAX_HINTS = 5;
/** 対象のフォルダの個数の上限。 */
export const REPO_MAP_MAX_FOLDERS = 50;
/** 1 つのパスの長さの上限。 */
const MAX_PATH_LENGTH = 300;

const pathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PATH_LENGTH));

/** `POST /v1/repo-maps:inspect` が受け取るもの。 */
export const inspectRepoSchema = v.strictObject({
  url: v.pipe(v.string(), v.maxLength(200)),
});
export type InspectRepoInput = v.InferOutput<typeof inspectRepoSchema>;

/**
 * `POST /v1/repo-map-drafts` が受け取るもの。
 *
 * `consentVersion` は、その場で同意したときだけ送る（「今後表示しない」の記録があれば省ける）。
 * 枠は作った時点で消えるので、同意の確認は枠を数える前に行う。
 */
export const createRepoMapDraftSchema = v.strictObject({
  url: v.pipe(v.string(), v.maxLength(200)),
  folders: v.optional(v.pipe(v.array(pathSchema), v.maxLength(REPO_MAP_MAX_FOLDERS)), []),
  files: v.optional(v.pipe(v.array(pathSchema), v.maxLength(REPO_MAP_MAX_HINTS)), []),
  issues: v.optional(
    v.pipe(
      v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
      v.maxLength(REPO_MAP_MAX_HINTS),
    ),
    [],
  ),
  consentVersion: v.optional(v.pipe(v.number(), v.integer())),
});
export type CreateRepoMapDraftInput = v.InferOutput<typeof createRepoMapDraftSchema>;

/** 捨てた理由ごとの件数。文面は画面側が持つ。 */
export type DroppedCounts = Partial<
  Record<
    | "dependency_dir"
    | "lock_or_generated"
    | "binary"
    | "unreadable_doc"
    | "too_large"
    | "duplicate",
    number
  >
>;

/** 絞り込みの結果の概要。 */
export interface RepoMapScan {
  /** ツリーのファイル数（絞り込む前、対象のフォルダの中）。 */
  blobTotal: number;
  /** 残したファイルの分類ごとの件数。 */
  kept: Partial<Record<"glossary" | "doc" | "schema" | "code" | "other", number>>;
  dropped: DroppedCounts;
}

export interface RepoMapWorkspaceFolder {
  path: string;
  /** 共有っぽいフォルダ。確認画面で既定のチェックを入れる。 */
  shared: boolean;
}

export interface RepoMapRepoInfo {
  owner: string;
  name: string;
  /** `github.com/owner/repo`。 */
  url: string;
  defaultBranch: string;
  /** 取得した時点の既定のブランチの先頭。根拠のリンクをこの SHA で固定する。 */
  commitSha: string;
}

export interface RepoMapUsageView {
  monthlyDrafts: number;
  monthlyDraftsLimit: number;
  dailyRebuilds: number;
  dailyRebuildsLimit: number;
}

export interface InspectRepoResponse {
  repo: RepoMapRepoInfo;
  /** モノレポなら、選べるフォルダ。そうでなければ null。 */
  monorepo: RepoMapWorkspaceFolder[] | null;
  /** 深さ 2 までのフォルダ（対象のフォルダの候補）。 */
  folders: string[];
  /**
   * 「参考にしてほしいファイル」を選ぶための、読めるファイルの一覧（用語集・文書・データの形・コード。
   * {@link INSPECT_FILE_LIST_MAX} 件まで）。下見の木から作る（GitHub の追加呼び出しは無い）。
   */
  files: InspectFileView[];
  /** `files` が上限で切れたか。切れていても、手で書いたパスは確かめる（下書きの作成で）。 */
  filesTruncated: boolean;
  scan: RepoMapScan;
  usage: RepoMapUsageView;
}

/** 下見で出すファイルの一覧の上限。 */
export const INSPECT_FILE_LIST_MAX = 300;

export interface InspectFileView {
  path: string;
  kind: "glossary" | "doc" | "schema" | "code";
}

/** 要約した材料 1 件。`id`（E1…）が候補の根拠の参照になる。 */
export interface RepoMapMaterialView {
  id: string;
  kind: "glossary" | "doc" | "code" | "issue";
  /** ファイルのパス、または `#番号`（Issue）。 */
  ref: string;
  /** commit SHA で固定したリンク（Issue は番号のリンク）。 */
  url: string;
  text: string;
  /** 利用者が「参考にしてほしい」と指定したもの。 */
  pinned: boolean;
}

export interface RepoMapSummaryView {
  materials: RepoMapMaterialView[];
  /** 機械で読んだデータの形（AI は使っていない）。 */
  schema: { path: string; url: string; names: string[] }[];
  /** 読まなかった材料と理由（読めない形式・失敗など）。 */
  skipped: { ref: string; reason: string }[];
  /** 文書の要約の文字数の合計。薄いリポジトリの判定に使う。 */
  docChars: number;
}

export interface RepoMapAiUsageView {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** 用語の候補 1 件。根拠は材料の ID で持ち、パスは機械で戻して返す。 */
export interface RepoMapCandidateView {
  id: string;
  /** 日本語の表示名。 */
  name: string;
  /** 原文の名前（無ければ空）。画面では「注文（`Order`）」のように見せる。 */
  original: string;
  description: string;
  /** 根拠。要約した材料・データの形のファイルへのリンク（commit SHA で固定）。 */
  evidence: {
    id: string;
    kind: "glossary" | "doc" | "code" | "issue" | "schema";
    ref: string;
    url: string;
  }[];
  /** データの形にも現れる。AI の自己申告ではなく、名前のつき合わせで機械が付ける。 */
  fromSchema: boolean;
  /** 文書・コードには無く、データの形にだけある名前（機械で足した候補）。 */
  schemaOnly: boolean;
  /** AI が提案した種類（#322）。無い・当てはまらないときは `null`。古い下書きでは省かれる。 */
  kind?: RepoMapNodeKind | null;
}

export interface RepoMapCandidatesView {
  items: RepoMapCandidateView[];
  /** 文書が薄い（用語集・README・docs の合計が小さい）。データの形とコードを主の材料にした。 */
  thin: boolean;
  /** 作り直しで外した材料の ID。 */
  excluded: string[];
}

/** `POST /v1/repo-map-drafts/:id/candidates` が受け取るもの。 */
export const candidatesRepoMapDraftSchema = v.strictObject({
  consentVersion: v.optional(v.pipe(v.number(), v.integer())),
});

/**
 * `POST /v1/repo-map-drafts/:id/rebuild` が受け取るもの。外す材料の ID（`E1`・`S1` など）を指定して、
 * 候補だけを作り直す。要約はやり直さない（1 日 5 回までで、月の枠には数えない）。
 */
export const rebuildRepoMapDraftSchema = v.strictObject({
  consentVersion: v.optional(v.pipe(v.number(), v.integer())),
  excludeIds: v.optional(
    v.pipe(v.array(v.pipe(v.string(), v.regex(/^[ES][0-9]{1,3}$/))), v.maxLength(30)),
    [],
  ),
});
export type RebuildRepoMapDraftInput = v.InferOutput<typeof rebuildRepoMapDraftSchema>;

/**
 * `POST /v1/repo-map-drafts/:id/confirm` が受け取るもの。選んだ候補（最大 30）から、マップを作る。
 * 表示名・説明は、候補のものを直して送れる（省くと候補のまま）。題名を省くとリポジトリ名から付ける。
 */
export const confirmRepoMapDraftSchema = v.strictObject({
  consentVersion: v.optional(v.pipe(v.number(), v.integer())),
  // 保存できる長さまで。超えるものは黙って切らず、400 にする（見えたものがそのまま保存される）。
  title: v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_MAP_TITLE_LENGTH)),
  ),
  accepted: v.pipe(
    v.array(
      v.strictObject({
        id: v.pipe(v.string(), v.regex(/^C[0-9]{1,3}$/)),
        name: v.optional(
          v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_NODE_LABEL_LENGTH)),
        ),
        description: v.optional(
          v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_NODE_SUMMARY_LENGTH)),
        ),
        // 候補の種類を直したとき。`null` は「種類なし」にする。省くと候補のまま。
        kind: v.optional(v.nullable(v.picklist(REPO_MAP_NODE_KINDS))),
      }),
    ),
    v.minLength(1),
    v.maxLength(30),
  ),
});
export type ConfirmRepoMapDraftInput = v.InferOutput<typeof confirmRepoMapDraftSchema>;

/** `GET /v1/repo-maps/:mapId/sources` の応答。リポジトリから作ったマップの根拠。 */
export interface RepoMapSourcesResponse {
  repo: { url: string; commitSha: string };
  nodes: {
    conceptId: string;
    /** ノードの種類（#322）。種類なし・古いマップは `null`。 */
    kind: RepoMapNodeKind | null;
    sources: {
      kind: "doc" | "glossary" | "code" | "issue" | "schema";
      /** ファイルのパス。Issue は null。 */
      path: string | null;
      issueNumber: number | null;
      /** commit SHA で固定したリンク（Issue は番号のリンク）。 */
      url: string;
      summary: string;
    }[];
  }[];
}

export interface ConfirmRepoMapDraftResponse {
  /** 作った学習マップの ID（`GET /v1/learning-maps/:id`）。 */
  mapId: string;
}

/** `POST /v1/repo-map-drafts/:id/summarize` が受け取るもの。 */
export const summarizeRepoMapDraftSchema = v.strictObject({
  consentVersion: v.optional(v.pipe(v.number(), v.integer())),
});
export type SummarizeRepoMapDraftInput = v.InferOutput<typeof summarizeRepoMapDraftSchema>;

export interface RepoMapDraftView {
  id: string;
  repo: RepoMapRepoInfo;
  status: "fetched" | "summarized" | "candidates" | "failed";
  targets: { folders: string[]; files: string[]; issues: number[] };
  monorepo: RepoMapWorkspaceFolder[] | null;
  scan: RepoMapScan;
  /** AI に見せる一覧（圧縮したもの）。確認画面で、送る材料を見せるために返す。 */
  listing: string;
  /** 参考にしてほしい Issue のタイトル。 */
  issues: { number: number; title: string }[];
  /** 要約の段が終わっていれば、その結果。 */
  summary: RepoMapSummaryView | null;
  /** 候補の段が終わっていれば、その結果。 */
  candidates: RepoMapCandidatesView | null;
  /** 確定して作ったマップ。確定済みの下書きは、材料を持たず、この ID だけを持つ。 */
  confirmedMapId: string | null;
  /** 要約の段が途中で止まっている。もう一度 summarize を呼ぶと続きから進む。 */
  partial: boolean;
  ai: RepoMapAiUsageView;
  /** 失敗して止まっているとき、どの段から続けるか。 */
  failure: { stage: "fetch" | "summarize" | "candidates"; code: string } | null;
  createdAt: string;
  expiresAt: string;
}

export interface CreateRepoMapDraftResponse {
  draft: RepoMapDraftView;
  usage: RepoMapUsageView;
}

export interface ListRepoMapDraftsResponse {
  drafts: RepoMapDraftView[];
  usage: RepoMapUsageView;
}
