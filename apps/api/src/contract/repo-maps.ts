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
  scan: RepoMapScan;
  usage: RepoMapUsageView;
}

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
