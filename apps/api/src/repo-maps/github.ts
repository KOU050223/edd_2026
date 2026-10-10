/**
 * GitHub の読み取り（#249）。公開リポジトリだけを、運営の読み取り専用トークンで読む。
 *
 * 利用者の身元や資格情報は GitHub へ送らない。失敗は {@link GitHubError} の種類で返し、
 * 呼び出し側が利用者への文面を決める（黙って空にしない）。
 *
 * Workers では `redirect: "error"` を渡すと fetch が送信前に例外を投げるので `"manual"` にし、
 * 3xx は失敗として扱う（RULE-002）。
 */

import type { RepoRef } from "./url.js";

const API_ORIGIN = "https://api.github.com";
/** 単発リクエストの期限（RULE-001）。 */
export const GITHUB_TIMEOUT_MS = 10_000;

export type GitHubErrorKind =
  /** 存在しない・非公開・権限なし。利用者へは区別せず同じ文面にする。 */
  | "not-found"
  /** 別の場所へ移っている（3xx）。 */
  | "moved"
  | "rate-limited"
  | "timeout"
  | "unreachable"
  | "unavailable"
  /** 2xx なのに本文を読めない。 */
  | "unreadable"
  /** 取得できる大きさを超えている（ツリーが切り詰められた）。 */
  | "too-large";

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export type TreeEntry = {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

export type RepoInfo = { defaultBranch: string };

export type IssueSummary = {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  updatedAt: string;
};

export type IssueDetail = IssueSummary & { body: string; isPullRequest: boolean };

export type BlobText = {
  text: string;
  /** 全体のバイト数。 */
  size: number;
  /** 上限で先頭だけ読んだ。 */
  truncated: boolean;
};

export type GitHubClientOptions = {
  token: string | undefined;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unreadable(what: string): GitHubError {
  return new GitHubError("unreadable", `GitHub の応答を読めませんでした（${what}）`);
}

function toIssue(raw: unknown): IssueDetail {
  if (
    !isObject(raw) ||
    typeof raw.number !== "number" ||
    typeof raw.title !== "string" ||
    (raw.state !== "open" && raw.state !== "closed") ||
    typeof raw.updated_at !== "string"
  ) {
    throw unreadable("issue");
  }
  const labels = Array.isArray(raw.labels)
    ? raw.labels.flatMap((l: unknown) => {
        if (typeof l === "string") return [l];
        return isObject(l) && typeof l.name === "string" ? [l.name] : [];
      })
    : [];
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    labels,
    updatedAt: raw.updated_at,
    body: typeof raw.body === "string" ? raw.body : "",
    isPullRequest: raw.pull_request !== undefined && raw.pull_request !== null,
  };
}

export function createGitHubClient(options: GitHubClientOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS;

  async function request(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchFn(`${API_ORIGIN}${path}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "gakushu-sochi",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new GitHubError(
        timedOut ? "timeout" : "unreachable",
        timedOut ? "GitHub の応答が時間内に返りませんでした" : "GitHub へ接続できませんでした",
      );
    }
    if (res.status >= 300 && res.status < 400) {
      throw new GitHubError("moved", `GitHub が別の場所を返しました（${res.status}）`);
    }
    if (res.status === 404) throw new GitHubError("not-found", "リポジトリが見つかりません");
    if (
      res.status === 429 ||
      (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
    ) {
      throw new GitHubError("rate-limited", "GitHub の利用上限に達しています");
    }
    if (res.status === 403 || res.status === 451) {
      // 権限なし・法的理由での遮断。存在の有無を区別して見せない。
      throw new GitHubError("not-found", "リポジトリが見つかりません");
    }
    if (!res.ok) {
      throw new GitHubError("unavailable", `GitHub がエラーを返しました（${res.status}）`);
    }
    try {
      return await res.json();
    } catch {
      throw unreadable(path);
    }
  }

  return {
    /** 非公開は読まない。トークンで見えてしまっても not-found にする（存在を区別しない）。 */
    async getRepo(ref: RepoRef): Promise<RepoInfo> {
      const body = await request(`/repos/${ref.owner}/${ref.name}`);
      if (
        !isObject(body) ||
        typeof body.default_branch !== "string" ||
        typeof body.private !== "boolean"
      ) {
        throw unreadable("repo");
      }
      if (body.private) throw new GitHubError("not-found", "リポジトリが見つかりません");
      return { defaultBranch: body.default_branch };
    },

    /** 既定のブランチの先頭 commit SHA。根拠のリンクをこの SHA で固定する。 */
    async getHeadSha(ref: RepoRef, branch: string): Promise<string> {
      const body = await request(
        `/repos/${ref.owner}/${ref.name}/commits/${encodeURIComponent(branch)}`,
      );
      if (!isObject(body) || typeof body.sha !== "string" || !/^[0-9a-f]{40}$/.test(body.sha)) {
        throw unreadable("commit");
      }
      return body.sha;
    },

    /** 全ファイルの path / size / sha（1 リクエスト）。切り詰められたら失敗にする。 */
    async getTree(ref: RepoRef, commitSha: string): Promise<TreeEntry[]> {
      const body = await request(
        `/repos/${ref.owner}/${ref.name}/git/trees/${commitSha}?recursive=1`,
      );
      if (!isObject(body) || !Array.isArray(body.tree)) throw unreadable("tree");
      if (body.truncated === true) {
        throw new GitHubError(
          "too-large",
          "リポジトリが大きすぎて、ファイルの一覧を全部は取得できません",
        );
      }
      const entries: TreeEntry[] = [];
      for (const raw of body.tree) {
        if (
          !isObject(raw) ||
          typeof raw.path !== "string" ||
          typeof raw.sha !== "string" ||
          (raw.type !== "blob" && raw.type !== "tree" && raw.type !== "commit")
        ) {
          throw unreadable("tree entry");
        }
        entries.push({
          path: raw.path,
          type: raw.type,
          sha: raw.sha,
          ...(typeof raw.size === "number" ? { size: raw.size } : {}),
        });
      }
      return entries;
    },

    /** ファイルの先頭 `maxBytes` バイトを文字列で返す。バイナリ（NUL を含む）は失敗にする。 */
    async getBlobText(ref: RepoRef, blobSha: string, maxBytes: number): Promise<BlobText> {
      const body = await request(`/repos/${ref.owner}/${ref.name}/git/blobs/${blobSha}`);
      if (
        !isObject(body) ||
        body.encoding !== "base64" ||
        typeof body.content !== "string" ||
        typeof body.size !== "number"
      ) {
        throw unreadable("blob");
      }
      let bytes: Uint8Array;
      try {
        const binary = atob(body.content.replace(/\s/g, ""));
        bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      } catch {
        throw unreadable("blob content");
      }
      const truncated = bytes.length > maxBytes;
      const head = truncated ? bytes.subarray(0, maxBytes) : bytes;
      if (head.includes(0)) throw unreadable("binary file");
      let text = new TextDecoder("utf-8").decode(head);
      // 先頭で切ると多バイト文字の途中で終わりうる。壊れた末尾 1 文字だけ落とす。
      if (truncated && text.endsWith("�")) text = text.slice(0, -1);
      return { text, size: body.size, truncated };
    },

    /** 更新の新しい順。PR は除く（Issues API は PR も返す）。open と closed の両方。 */
    async listIssues(ref: RepoRef, limit: number): Promise<IssueSummary[]> {
      const perPage = Math.min(100, limit * 2);
      const body = await request(
        `/repos/${ref.owner}/${ref.name}/issues?state=all&sort=updated&direction=desc&per_page=${perPage}`,
      );
      if (!Array.isArray(body)) throw unreadable("issues");
      const out: IssueSummary[] = [];
      for (const raw of body) {
        const issue = toIssue(raw);
        if (issue.isPullRequest) continue;
        out.push({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels,
          updatedAt: issue.updatedAt,
        });
        if (out.length >= limit) break;
      }
      return out;
    },

    /** 1 件。指定された番号が PR でないかの検証にも使う（`isPullRequest`）。 */
    async getIssue(ref: RepoRef, number: number): Promise<IssueDetail> {
      return toIssue(await request(`/repos/${ref.owner}/${ref.name}/issues/${number}`));
    },
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
