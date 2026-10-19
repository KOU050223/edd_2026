/**
 * リポジトリから作ったマップの確認問題に渡すコード（#326）。
 *
 * ノードの根拠になったファイルを、マップの commit で固定して読み、関係する行だけを機械で抜き出す
 * （AI は使わない）。**読んだ本文は D1 に保存しない。** Workers の Cache API（{@link RepoFileCache}）に
 * 一時的に置くだけで、消えていても GitHub から読み直せる（SHA で固定した本文は変わらない）。
 * 読めなかったファイルは失敗にせず、根拠の要約だけを渡す。
 */

import { GitHubError, type GitHubClient } from "../repo-maps/github.js";
import { parseRepoUrl, type RepoRef } from "../repo-maps/url.js";
import type { LearningMapRepository, RepoMapNodeSource } from "../repository/types.js";
import type { RepoCodeMaterial, RepoCodeSource } from "./prompt.js";

/** 本文を読むファイルの数の上限。 */
export const REPO_CODE_MAX_FILES = 3;
/** 1ファイルから読む（キャッシュに置く）先頭のバイト数。抜き出す前の量で、AI へはこのまま渡さない。 */
export const REPO_CODE_READ_BYTES = 64 * 1024;
/** 抜き出したコードの合計の上限（UTF-8 のバイト数）。 */
export const REPO_CODE_BUDGET_BYTES = 6_000;
/** 一致した行の前後に添える行数。 */
const CONTEXT_LINES = 3;
/** 1行の長さの上限（文字）。圧縮済みのコードの1行で予算を使い切らない。 */
const MAX_LINE_CHARS = 200;
/** 探す言葉の数の上限。 */
const MAX_KEYWORDS = 40;
/** 要約の長さの上限（文字）。 */
const SUMMARY_MAX_CHARS = 300;
/** キャッシュに置く期間。SHA で固定した本文は変わらないので、長くてよい。 */
const CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * 読んだ本文の一時的な置き場に使う最小の窓口（`auth/verifier.ts` の `JwksCache` と同じ理由）。
 *
 * Workers の Cache API（`caches.default`）をそのまま要求すると、`caches` を持たない Node で
 * `test:unit` が動かない。必要な操作だけを型にして注入可能にする。
 */
export interface RepoFileCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** どこにも置かないキャッシュ。テストと、Cache API が無い環境の既定。 */
export const noopRepoFileCache: RepoFileCache = {
  match: () => Promise.resolve(undefined),
  put: () => Promise.resolve(),
};

/** Workers の Cache API を置き場にする。持たない環境では undefined。 */
export function cacheApiRepoFileCache(): RepoFileCache | undefined {
  if (typeof caches === "undefined") return undefined;
  // `caches.default` は Workers 固有で、tsconfig の `lib` が持つ標準の `CacheStorage` には無い。
  const store = (caches as unknown as { default: Cache }).default;
  return {
    match: (key: string) => store.match(key),
    put: (key: string, response: Response) => store.put(key, response),
  };
}

/** コードを読むのに使う依存。無ければコードを読まない（今までと同じ問題を作る）。 */
export interface RepoCodeDeps {
  /** `getRepo` は、読む前に今も公開かを確かめるのに使う。 */
  github: Pick<GitHubClient, "getFileText" | "getRepo">;
  /** 省略は置かない（毎回 GitHub から読む）。 */
  cache?: RepoFileCache;
}

/** 対象のノードの根拠と、読む先のリポジトリ。 */
export interface RepoNodeSources {
  repo: RepoRef;
  /** `github.com/owner/repo`。 */
  url: string;
  commitSha: string;
  /** そのノードの根拠（並び順）。 */
  sources: RepoMapNodeSource[];
}

/**
 * 対象がリポジトリから作った自分のマップのノードなら、その根拠を返す。
 *
 * 取り込んだマップ・手で作ったマップ・AI で作ったマップ・根拠の無いノードは `null`
 * （今までと同じ問題を作る）。
 */
export async function repoNodeSourcesFor(
  maps: Pick<LearningMapRepository, "getRepoSource">,
  userId: string,
  mapId: string,
  conceptId: string,
): Promise<RepoNodeSources | null> {
  const found = await maps.getRepoSource(userId, mapId);
  if (found === null) return null;
  const sources = found.nodeSources
    .filter((source) => source.conceptId === conceptId)
    .sort((a, b) => a.position - b.position);
  if (sources.length === 0) return null;
  const repo = parseRepoUrl(found.url);
  if (repo === null) {
    // 確定のときに検証した値なので、ここで崩れているのは保存の不備である。
    console.error("stored repo url is invalid; skipping repo code", { mapId });
    return null;
  }
  return { repo, url: found.url, commitSha: found.commitSha, sources };
}

/** 本文を読む根拠か（Issue はパスを持たない）。 */
export function hasReadablePath(
  source: RepoMapNodeSource,
): source is RepoMapNodeSource & { path: string } {
  return source.kind !== "issue" && source.path !== null;
}

/**
 * 根拠を、プロンプトへ載せる材料にする。本文を読めたファイルは関係する行を抜き出して添える。
 *
 * **読む前に、リポジトリが今も公開かを GitHub に確かめる。** マップを作った後に非公開になっても、
 * 運営のトークンでは読めてしまう。置き場に残った本文も、確かめられなければ使わない。
 * 確かめられないとき（非公開・消えた・上限など）は要約だけにする。
 *
 * @param hints 探す言葉の元（表示名・概要・「理解すること」など）。根拠の要約とパスも足す。
 * @param budgetBytes 抜き出したコードの合計の上限（区切りの印を置き換えた後のバイト数）。
 */
export async function repoCodeMaterialFor(
  deps: RepoCodeDeps,
  node: RepoNodeSources,
  hints: readonly string[],
  budgetBytes: number,
): Promise<RepoCodeMaterial> {
  const readable = node.sources.filter(hasReadablePath).slice(0, REPO_CODE_MAX_FILES);
  if (readable.length === 0 || !(await isPublic(deps, node.repo))) return repoSummariesOf(node);
  const texts = await Promise.all(
    readable.map((source) => readFile(deps, node.repo, node.commitSha, source.path)),
  );
  const keywords = keywordsOf([
    ...hints,
    ...node.sources.map((source) => source.summary),
    ...readable.map((source) => fileStem(source.path)),
  ]);
  const excerpts = allocateExcerpts(texts, keywords, budgetBytes);

  const sources = node.sources.map((source) => {
    const index = hasReadablePath(source) ? readable.indexOf(source) : -1;
    const excerpt = index === -1 ? undefined : excerpts[index];
    return {
      ...sourceOf(source),
      ...(excerpt === undefined || excerpt === null ? {} : { excerpt }),
    };
  });
  return { repo: node.url, sources };
}

/** 根拠の要約だけの材料（本文は読まない）。コードの予算を決める前の大きさを測るのに使う。 */
export function repoSummariesOf(node: RepoNodeSources): RepoCodeMaterial {
  return { repo: node.url, sources: node.sources.map(sourceOf) };
}

function sourceOf(source: RepoMapNodeSource): RepoCodeSource {
  return {
    kind: source.kind,
    ref: escapeFence(
      source.kind === "issue" ? `#${String(source.issueNumber)}` : (source.path ?? ""),
    ),
    summary: escapeFence(source.summary.slice(0, SUMMARY_MAX_CHARS)),
  };
}

/**
 * 資料の区切りの印（`<<<` `>>>`）を全角に置き換える。置き換えると長くなるので、
 * 大きさを測る前（材料を作るとき）に済ませる。プロンプトの側でも同じ置き換えをするが、
 * 置き換え済みの文字列は変わらない。
 */
export function escapeFence(text: string): string {
  return text.replaceAll("<<<", "＜＜＜").replaceAll(">>>", "＞＞＞");
}

/** リポジトリが今も公開か。`getRepo` は非公開を not-found にする。確かめられなければ false。 */
async function isPublic(deps: RepoCodeDeps, repo: RepoRef): Promise<boolean> {
  try {
    await deps.github.getRepo(repo);
    return true;
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    const detail = { repo: `${repo.owner}/${repo.name}`, kind: error.kind };
    if (error.kind === "unauthorized") {
      console.error("repo visibility could not be checked; github is not configured", detail);
    } else {
      console.warn("repo is not readable as public; using summaries only", detail);
    }
    return false;
  }
}

/** 読んだ本文のキャッシュの鍵。リポジトリ・SHA・パス・読んだ量で決まる。 */
export function repoFileCacheKey(repo: RepoRef, commitSha: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return (
    `https://repo-files.gakushu-sochi.invalid/${encodeURIComponent(repo.owner)}/` +
    `${encodeURIComponent(repo.name)}/${commitSha}/${encoded}?bytes=${String(REPO_CODE_READ_BYTES)}`
  );
}

/**
 * 本文を読む。置き場にあればそれを使い、無ければ GitHub から読んで置く。
 *
 * 読めなければ `null`（要約だけを渡す）。置き場の失敗は、置き場に無かったのと同じに扱う。
 */
async function readFile(
  deps: RepoCodeDeps,
  repo: RepoRef,
  commitSha: string,
  path: string,
): Promise<string | null> {
  const cache = deps.cache ?? noopRepoFileCache;
  const key = repoFileCacheKey(repo, commitSha, path);
  try {
    const hit = await cache.match(key);
    if (hit !== undefined) return await hit.text();
  } catch (error) {
    console.warn("repo file cache could not be read", { path, error: String(error) });
  }

  let text: string;
  try {
    ({ text } = await deps.github.getFileText(repo, commitSha, path, REPO_CODE_READ_BYTES));
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    const detail = { repo: `${repo.owner}/${repo.name}`, path, kind: error.kind };
    // トークンが無い・拒否されたのは運営側の設定の問題。ほかは相手側の事情なので警告に留める。
    if (error.kind === "unauthorized") {
      console.error("repo file could not be read; github is not configured", detail);
    } else {
      console.warn("repo file could not be read; using its summary only", detail);
    }
    return null;
  }

  try {
    await cache.put(
      key,
      new Response(text, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": `max-age=${String(CACHE_MAX_AGE_SECONDS)}`,
        },
      }),
    );
  } catch (error) {
    console.warn("repo file cache could not be written", { path, error: String(error) });
  }
  return text;
}

/** 識別子として探さない、よくある英単語とキーワード。 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "are",
  "not",
  "you",
  "can",
  "use",
  "uses",
  "used",
  "its",
  "has",
  "have",
  "all",
  "any",
  "new",
  "get",
  "set",
  "var",
  "let",
  "const",
  "function",
  "return",
  "true",
  "false",
  "null",
  "undefined",
  "string",
  "number",
  "import",
  "export",
  "default",
  "class",
  "type",
  "interface",
  "public",
  "private",
  "static",
  "void",
  "async",
  "await",
  "api",
  "http",
  "https",
  "www",
  "com",
  "github",
  "readme",
  "docs",
  "src",
  "lib",
  "index",
  "main",
  "test",
  "tests",
]);

/**
 * 文章から、コードの中で探す言葉（英数字の識別子）を拾う。小文字にそろえ、重複を除く。
 *
 * 日本語の表示名からはほとんど取れない。根拠の要約に関数名・型名が書かれていることが多い。
 */
export function keywordsOf(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
      const word = match[0].toLowerCase();
      if (STOPWORDS.has(word)) continue;
      found.add(word);
      if (found.size >= MAX_KEYWORDS) return [...found];
    }
  }
  return [...found];
}

/** `src/order-service.ts` → `order-service`。 */
function fileStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.indexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 宣言の行（関数・型・表など）。一致が少ないときの目次に使う。言語をまたいで大まかに見る。 */
const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\(\w+\))?\s+)?(?:async\s+)?(?:abstract\s+)?(?:(?:public|private|protected|static|final)\s+)*(?:function|class|interface|type|enum|struct|trait|impl|def|func|fn|module|namespace|record|message|service|create\s+table)\b/i;

const encoder = new TextEncoder();
const bytesOf = (text: string) => encoder.encode(text).length;
/** 省いた行の印。 */
const GAP = "…";

/**
 * 1ファイルから、探す言葉に一致した行とその前後を抜き出す。行番号を付け、省いた行は `…` にする。
 *
 * 一致した行は**珍しい言葉に一致した行から**取る（{@link lineScores}）。ファイル名の語のように
 * ほとんどの行に出る言葉で先頭から埋まり、肝心の定義が落ちるのを防ぐ。
 * 一致した行（前後を含む）を先に、宣言の行を後に、`maxBytes` に収まる分だけ取る。
 * どちらも無ければ先頭から取る。出力は元の行の順に並べる。
 *
 * @returns 抜き出したコード。何も取れなければ空文字。
 */
export function excerptOf(text: string, keywords: readonly string[], maxBytes: number): string {
  const lines = text.split(/\r?\n/);
  const scores = lineScores(lines, keywords);
  const matches = lines
    .map((_, index) => index)
    .filter((index) => (scores[index] ?? 0) > 0)
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b);

  // 取る順。前後を含む一致（点の高い順。一致した行から近い順に前後を足す）→ 宣言 → 先頭。
  const priority: number[] = [];
  for (const index of matches) {
    priority.push(index);
    for (let distance = 1; distance <= CONTEXT_LINES; distance += 1) {
      if (index - distance >= 0) priority.push(index - distance);
      if (index + distance < lines.length) priority.push(index + distance);
    }
  }
  lines.forEach((line, index) => {
    if (DECLARATION.test(line)) priority.push(index);
  });
  if (priority.length === 0) lines.forEach((_, index) => priority.push(index));

  const chosen = new Set<number>();
  let used = 0;
  for (const index of priority) {
    if (chosen.has(index)) continue;
    // 省いた行の印が入りうる分も見込んで数え、描いた結果が必ず上限に収まるようにする。
    const cost = bytesOf(renderLine(lines, index)) + 1 + bytesOf(GAP) + 1;
    if (used + cost > maxBytes) continue;
    chosen.add(index);
    used += cost;
  }

  const ordered = [...chosen].sort((a, b) => a - b);
  const out: string[] = [];
  let previous = -1;
  for (const index of ordered) {
    if (index !== previous + 1) out.push(GAP);
    out.push(renderLine(lines, index));
    previous = index;
  }
  if (ordered.length > 0 && previous !== lines.length - 1) out.push(GAP);
  return ordered.length === 0 ? "" : out.join("\n");
}

/**
 * 行ごとの点。言葉ごとに「その言葉を含む行の数」の逆数を持たせ、行が含む言葉の分を足す。
 *
 * 1行にしか出ない言葉（定義の名前など）は 1 点、100 行に出る言葉は 0.01 点になる。
 * ファイル全体の合計は、そのファイルに出てくる言葉の種類の数になる。
 */
function lineScores(lines: readonly string[], keywords: readonly string[]): number[] {
  const lowered = lines.map((line) => line.toLowerCase());
  const scores = lines.map(() => 0);
  for (const keyword of keywords) {
    const hits = lowered.flatMap((line, index) => (line.includes(keyword) ? [index] : []));
    for (const index of hits) scores[index] = (scores[index] ?? 0) + 1 / hits.length;
  }
  return scores;
}

function renderLine(lines: readonly string[], index: number): string {
  const line = lines[index] ?? "";
  const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
  // 置き換えた後の長さで予算を数える（置き換えると 1 文字 1 バイトが 3 バイトになる）。
  return `${String(index + 1)}: ${escapeFence(clipped)}`;
}

/**
 * 読めたファイルに予算を分ける。探す言葉が多く出てくるファイルから順に、残りを残りのファイル数で
 * 等分した分を渡し、使わなかった分は次へ回す。読めなかったファイルは `null` のまま。
 */
function allocateExcerpts(
  texts: readonly (string | null)[],
  keywords: readonly string[],
  budgetBytes: number,
): (string | null)[] {
  const order = texts
    .flatMap((text, index) => {
      if (text === null) return [];
      const score = lineScores(text.split(/\r?\n/), keywords).reduce((sum, s) => sum + s, 0);
      return [{ index, text, score }];
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const out: (string | null)[] = texts.map(() => null);
  let remaining = budgetBytes;
  order.forEach((entry, position) => {
    const share = Math.floor(remaining / (order.length - position));
    const excerpt = excerptOf(entry.text, keywords, share);
    out[entry.index] = excerpt.length > 0 ? excerpt : null;
    remaining -= bytesOf(excerpt);
  });
  return out;
}
