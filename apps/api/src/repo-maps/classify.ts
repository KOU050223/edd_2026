/**
 * ファイルの一覧を機械で絞る（#249 の ①分類 ②捨てる ③一覧の圧縮）。AI は使わない。
 *
 * パス・ファイル名・拡張子・サイズだけを見て、中身は読まない。同じ入力なら毎回同じ結果になるので、
 * テストで固定でき、キャッシュも効く。規則は 4 つの公開リポジトリでのスパイクで固めた。
 */

import type { TreeEntry } from "./github.js";

export type FileClass = "glossary" | "doc" | "schema" | "code" | "other";

/** 捨てた理由。表示の文面は画面側が持つ。 */
export type DropReason =
  "dependency_dir" | "lock_or_generated" | "binary" | "unreadable_doc" | "too_large" | "duplicate";

export type KeptFile = {
  path: string;
  sha: string;
  size: number;
  cls: FileClass;
  /** 利用者が「参考にしてほしいファイル」に指定した。捨てる規則を通していない。 */
  pinned: boolean;
};

export type Analysis = {
  kept: KeptFile[];
  dropped: Partial<Record<DropReason, number>>;
  blobTotal: number;
};

/** これを超えるファイルは、指定されたものでも読まない（Trees API の size で、開く前に判定する）。 */
export const MAX_FILE_BYTES = 200_000;
/** AI に見せる一覧の予算（バイト）。指示文の分を除いた値。 */
export const LISTING_BUDGET_BYTES = 4_500;
/** 「参考にしてほしいファイル・Issue」の個数の上限。 */
export const MAX_HINTS = 5;

const DEPENDENCY_DIR = /(^|\/)(node_modules|vendor|third_party|\.godot)(\/|$)/;
const GENERATED_DIR =
  /(^|\/)(dist|build|out|target|bin|obj|\.git|\.github|\.next|\.nuxt|coverage|__pycache__|\.venv|venv|Pods|\.gradle|\.idea|\.vscode|\.import)(\/|$)/;
const LOCK_OR_GENERATED_FILE =
  /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Gemfile\.lock|poetry\.lock|go\.sum|Cargo\.lock|composer\.lock|\.min\.(js|css)|\.map|\.snap|\.generated\.[a-z]+|\.d\.ts)$/;
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|svg|bmp|psd|ttf|otf|woff2?|mp3|wav|ogg|mp4|mov|zip|gz|tar|7z|jar|exe|dll|so|wasm|glb|gltf|fbx|obj|blend|tscn|tres|import|res|ctex|pck|pdf)$/i;
const DESIGN_DOC_BINARY = /\.(pdf|png|jpe?g|gif|webp|svg)$/i;
const DOC_DIR = /(^|\/)(docs?|adr|documentation|wiki)(\/|$)/i;
const NOISE_DOC =
  /(^|\/)(skill\.md|agents\.md|claude\.md|gemini\.md|contributing\.md|code_of_conduct\.md|changelog\.md|license(\.md)?|security\.md|pull_request_template\.md|issue_template|\.claude|\.agents|\.cursor|\.github)(\/|$)/;

/** 分類（パス・名前・拡張子だけ）。 */
export function classify(path: string): FileClass {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (NOISE_DOC.test(lower)) return "other";
  if (
    /(^|\/)(glossary|ubiquitous[-_]?language)(\.[a-z]+)?(\/|$)/.test(lower) ||
    base.startsWith("glossary")
  ) {
    return "glossary";
  }
  if (
    /(^|\/)(schema\.prisma|schema\.rb|structure\.sql|schema\.sql)$/.test(lower) ||
    /(^|\/)openapi\.(ya?ml|json)$/.test(lower) ||
    /\.proto$/.test(lower)
  ) {
    return "schema";
  }
  if (base.startsWith("readme")) return "doc";
  if (/\.(md|mdx|rst|adoc)$/.test(lower)) return "doc";
  if (/\.txt$/.test(lower) && DOC_DIR.test(lower)) return "doc";
  if (/\.(rb|py|go|js|jsx|ts|tsx|java|kt|cs|php|rs|swift|gd|scala|ex|exs)$/.test(lower)) {
    return "code";
  }
  return "other";
}

/** コード候補の点数。ドメインそのものに近いほど高く、テスト・設定・深い階層は低い。 */
export function codeScore(path: string): number {
  const l = path.toLowerCase();
  let s = 0;
  if (/(^|\/)(domain|domains|model|models|entity|entities|aggregate|aggregates)(\/|\.|$)/.test(l)) {
    s += 5;
  }
  if (/(^|\/)(service|services|usecase|usecases|use_cases|command|commands)(\/|\.|$)/.test(l)) {
    s += 3;
  }
  if (/app\/models\//.test(l) || /(^|\/)models\.py$/.test(l)) s += 3;
  if (/(^|\/)(types?|schema|schemas)\.(ts|py|go|rb)$/.test(l)) s += 3;
  if (/(^|\/)domains?\/[^/]+\/(lib|src)\//.test(l)) s += 3;
  if (/application_record\.rb$|(^|\/)(index|main|app)\.(ts|js|tsx|jsx)$/.test(l)) s -= 4;
  if (
    /\.(config|conf)\.[a-z]+$|(^|\/)(vite|webpack|babel|metro|jest|eslint|tsconfig)[^/]*$/.test(l)
  ) {
    s -= 6;
  }
  if (/(^|\/)(video|videos|promo|slides|landing|storybook|stories)(\/|$)/.test(l)) s -= 6;
  s -= Math.max(0, l.split("/").length - 4);
  if (
    /(^|\/)(test|tests|spec|specs|__tests__|__snapshots__|mock|mocks|fixture|fixtures|example|examples|e2e)(\/|$)/.test(
      l,
    ) ||
    /(_test|\.test|\.spec)\.[a-z]+$/.test(l)
  ) {
    s -= 8;
  }
  if (
    /(^|\/)(utils?|helpers?|config|configs|lib|scripts?|migrations?|db\/migrate)(\/|\.|$)/.test(l)
  ) {
    s -= 3;
  }
  return s;
}

/** 選んだフォルダの下だけに絞る。空なら全体。 */
export function filterByFolders(entries: TreeEntry[], folders: readonly string[]): TreeEntry[] {
  if (folders.length === 0) return entries;
  return entries.filter((e) => folders.some((f) => e.path === f || e.path.startsWith(`${f}/`)));
}

/**
 * 分類して、読まないものを捨てる。
 *
 * - 文書・用語集・スキーマは、サイズやディレクトリでは捨てない（大きな文書は先頭だけ読む）。
 *   ただし依存ディレクトリの中（`node_modules` の README など）は捨てる。
 * - `pinned`（利用者が指定したファイル）は捨てる規則を通さない。サイズの上限だけ効かせる。
 */
export function analyzeTree(
  entries: TreeEntry[],
  pinned: ReadonlySet<string> = new Set(),
): Analysis {
  const kept: KeptFile[] = [];
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (reason: DropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const seen = new Set<string>();
  let blobTotal = 0;

  for (const e of entries) {
    if (e.type !== "blob") continue;
    blobTotal += 1;
    const size = e.size ?? 0;
    const cls = classify(e.path);
    const isPinned = pinned.has(e.path);

    if (isPinned) {
      if (size > MAX_FILE_BYTES) drop("too_large");
      else kept.push({ path: e.path, sha: e.sha, size, cls, pinned: true });
      continue;
    }
    if (DEPENDENCY_DIR.test(e.path)) {
      drop("dependency_dir");
      continue;
    }
    if (cls !== "other" && seen.has(e.sha)) {
      drop("duplicate");
      continue;
    }
    seen.add(e.sha);
    if (cls === "doc" || cls === "glossary" || cls === "schema") {
      kept.push({ path: e.path, sha: e.sha, size, cls, pinned: false });
      continue;
    }
    if (DOC_DIR.test(e.path) && DESIGN_DOC_BINARY.test(e.path)) {
      // 設計書の PDF・画像。読めないので外し、「読めない形式」として数える。
      drop("unreadable_doc");
      continue;
    }
    if (GENERATED_DIR.test(e.path)) drop("dependency_dir");
    else if (LOCK_OR_GENERATED_FILE.test(e.path)) drop("lock_or_generated");
    else if (BINARY_EXT.test(e.path)) drop("binary");
    else if (size > MAX_FILE_BYTES) drop("too_large");
    else kept.push({ path: e.path, sha: e.sha, size, cls, pinned: false });
  }
  return { kept, dropped, blobTotal };
}

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

/**
 * AI に見せる一覧の圧縮。機械的に行う（AI に圧縮させると全一覧を渡すことになり入力上限を超える）。
 * 一覧は「重要なコードを選ばせる」ためだけに使う。
 *
 * 1. 深さ 2 までのディレクトリ名とファイル数  2. 分類ごとの件数（捨てた件数も）
 * 3. 文書・コード候補のパスとサイズを、予算が尽きるまで並べる  4. 入りきらない分は「ほか N 件」
 */
export function compressListing(analysis: Analysis, budget: number = LISTING_BUDGET_BYTES): string {
  const { kept, dropped } = analysis;
  const lines: string[] = [];
  let used = 0;
  /** 予算に収まるときだけ 1 行足す。`reserve` は、この行のあとに必ず残しておくバイト数。 */
  const tryAdd = (line: string, reserve = 0): boolean => {
    const cost = byteLength(line) + (lines.length > 0 ? 1 : 0);
    if (used + cost + reserve > budget) return false;
    lines.push(line);
    used += cost;
    return true;
  };
  /** 要素を区切りで連ねた 1 行を、収まる分だけ作る（先頭の `head` は必ず含める）。 */
  const joinWithin = (head: string, parts: string[], sep: string): string | null => {
    const room = budget - used - (lines.length > 0 ? 1 : 0);
    let line = head;
    if (byteLength(line) > room) return null;
    for (const p of parts) {
      const next = line === head ? head + p : line + sep + p;
      if (byteLength(next) > room) break;
      line = next;
    }
    return line;
  };

  const dirCount = new Map<string, number>();
  for (const f of kept) {
    const parts = f.path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join("/") : ".";
    dirCount.set(dir, (dirCount.get(dir) ?? 0) + 1);
  }
  const dirs = [...dirCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 25);
  // 見出しも行も、予算に収まる分だけ。収まらなければ省く（上限を超えるより、情報が減るほうを選ぶ）。
  if (tryAdd("## ディレクトリ（深さ2まで・ファイル数）")) {
    const line = joinWithin(
      "",
      dirs.map(([d, n]) => `${d} (${n})`),
      "  ",
    );
    if (line !== null && line !== "") tryAdd(line);
  }

  const counts = new Map<FileClass, number>();
  for (const f of kept) counts.set(f.cls, (counts.get(f.cls) ?? 0) + 1);
  const droppedEntries = Object.entries(dropped);
  if (tryAdd("## 分類の件数")) {
    const countText = [...counts.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
    const droppedText =
      droppedEntries.length > 0
        ? `  捨てた: ${droppedEntries.map(([k, v]) => `${k} ${v}`).join(", ")}`
        : "";
    // 捨てた件数が収まらなければ、分類の件数だけにする。それも収まらなければ行ごと省く。
    if (!tryAdd(countText + droppedText)) tryAdd(countText);
  }

  const section = (title: string, items: KeptFile[]) => {
    if (items.length === 0) return;
    // 入りきらないときの「ほか N 件」の分を、先に取っておく。
    const summaryBytes = byteLength(`…ほか ${items.length} 件`) + 1;
    if (!tryAdd(`## ${title}`, summaryBytes)) return;
    let shown = 0;
    for (const [i, f] of items.entries()) {
      const isLast = i === items.length - 1;
      if (!tryAdd(`${f.path} (${f.size}B)`, isLast ? 0 : summaryBytes)) break;
      shown += 1;
    }
    if (shown < items.length) tryAdd(`…ほか ${items.length - shown} 件`);
  };

  const byClass = (cls: FileClass) => kept.filter((f) => f.cls === cls);
  const depth = (p: string) => p.split("/").length;
  section("用語集", byClass("glossary"));
  section("データの形", byClass("schema"));
  section(
    "文書",
    byClass("doc").sort(
      (a, b) => depth(a.path) - depth(b.path) || b.size - a.size || a.path.localeCompare(b.path),
    ),
  );
  section(
    "コード候補（点数順）",
    byClass("code")
      .filter((f) => f.size >= 150)
      .map((f) => ({ f, score: codeScore(f.path) }))
      .sort((a, b) => b.score - a.score || b.f.size - a.f.size || a.f.path.localeCompare(b.f.path))
      .map((x) => x.f),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// モノレポの検出と、利用者の指定の検証
// ---------------------------------------------------------------------------------------------

export type WorkspaceFolder = {
  path: string;
  /** 共有っぽいフォルダ（packages・shared・common・core・domain(s)）。確認画面で既定のチェックを入れる。 */
  shared: boolean;
};

const MANIFESTS = new Set([
  "package.json",
  "go.mod",
  "cargo.toml",
  "pyproject.toml",
  "gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "mix.exs",
]);
const WORKSPACE_CONTAINERS = new Set(["apps", "packages", "domains", "services", "libs"]);
const SHARED_CONTAINERS = new Set(["packages", "domains", "libs"]);
const SHARED_NAMES = new Set(["shared", "common", "core", "domain", "domains"]);

/**
 * モノレポの検出。`apps/*`・`packages/*`・`domains/*` などの直下に複数のフォルダがあり、
 * それぞれに README か manifest がある。検出したら null ではなく、選べるフォルダの一覧を返す。
 */
export function detectMonorepo(entries: TreeEntry[]): WorkspaceFolder[] | null {
  const hasMarker = new Map<string, boolean>();
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const parts = e.path.split("/");
    if (parts.length !== 3) continue;
    const [container, child, file] = parts as [string, string, string];
    if (!WORKSPACE_CONTAINERS.has(container)) continue;
    const lower = file.toLowerCase();
    if (lower.startsWith("readme") || MANIFESTS.has(lower)) {
      hasMarker.set(`${container}/${child}`, true);
    }
  }
  const folders: WorkspaceFolder[] = [...hasMarker.keys()].sort().map((path) => {
    const [container, child] = path.split("/") as [string, string];
    return { path, shared: SHARED_CONTAINERS.has(container) || SHARED_NAMES.has(child) };
  });
  // 1 つの container に複数のフォルダがあって、初めてモノレポとみなす。
  const perContainer = new Map<string, number>();
  for (const f of folders) {
    const c = f.path.split("/")[0] ?? "";
    perContainer.set(c, (perContainer.get(c) ?? 0) + 1);
  }
  if (![...perContainer.values()].some((n) => n >= 2)) return null;
  return folders;
}

export type TargetInput = {
  folders: readonly string[];
  files: readonly string[];
  issues: readonly number[];
};

export type TargetError =
  | { code: "too_many"; field: "folders" | "files" | "issues"; max: number }
  | { code: "unknown_path"; field: "folders" | "files"; path: string }
  | { code: "invalid_issue"; number: number };

/**
 * 利用者の指定（対象のフォルダ・参考にしてほしいファイル・Issue）の形を検証する。
 * パスはツリーに存在するものだけを受ける。Issue 番号が PR でないかは API の呼び出しが要るので
 * 呼び出し側が確かめる（{@link GitHubClient.getIssue} の `isPullRequest`）。
 */
export function validateTargets(entries: TreeEntry[], input: TargetInput): TargetError | null {
  const files = new Set(entries.filter((e) => e.type === "blob").map((e) => e.path));
  const dirs = new Set(entries.filter((e) => e.type === "tree").map((e) => e.path));
  if (input.folders.length > 50) return { code: "too_many", field: "folders", max: 50 };
  if (input.files.length > MAX_HINTS) return { code: "too_many", field: "files", max: MAX_HINTS };
  if (input.issues.length > MAX_HINTS) return { code: "too_many", field: "issues", max: MAX_HINTS };
  for (const f of input.folders) {
    if (!dirs.has(f)) return { code: "unknown_path", field: "folders", path: f };
  }
  for (const f of input.files) {
    if (!files.has(f)) return { code: "unknown_path", field: "files", path: f };
  }
  for (const n of input.issues) {
    if (!Number.isInteger(n) || n <= 0) return { code: "invalid_issue", number: n };
  }
  return null;
}
