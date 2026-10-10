/**
 * `/v1/repo-maps:inspect` と `/v1/repo-map-drafts`（Issue #249 / マップ v3）。
 *
 * 契約は `contract/repo-maps.ts`。対象のユーザーは `c.get("user").userId` だけから決める
 * （routes/account.ts と同じ規律）。他人の下書きは存在しないのと同じ 404 にする。
 *
 * GitHub の失敗は、利用者の入力のせいか（404・400）、GitHub 側か（502・503）、運営の設定か（503）を
 * 区別して返す。トークンの欠落・失効は 503 にして記録する（利用者の再試行では直らない）。
 */

import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthVariables } from "../auth/middleware.js";
import {
  confirmRepoMapDraftSchema,
  type ConfirmRepoMapDraftResponse,
  type RepoMapSourcesResponse,
  candidatesRepoMapDraftSchema,
  rebuildRepoMapDraftSchema,
  createRepoMapDraftSchema,
  inspectRepoSchema,
  summarizeRepoMapDraftSchema,
  type CreateRepoMapDraftResponse,
  type ListRepoMapDraftsResponse,
} from "../contract/repo-maps.js";
import { AiStageFailure } from "../repo-maps/ai.js";
import { GitHubError } from "../repo-maps/github.js";
import { buildCandidates } from "../repo-maps/candidates.js";
import { issueLink, parseRepoUrl, permalink } from "../repo-maps/url.js";
import { confirmDraft } from "../repo-maps/confirm.js";
import { summarizeDraft } from "../repo-maps/summarize.js";
import type { GitHubErrorKind } from "../repo-maps/github.js";
import {
  createDraft,
  currentUsage,
  draftView,
  inspectRepo,
  RepoMapRefusal,
  type RepoMapDeps,
} from "../repo-maps/service.js";
import { parseBody } from "./learning-maps.js";

export type RepoMapsDepsResolver = (env: CloudflareBindings) => RepoMapDeps;

const NO_STORE = { "cache-control": "no-store" } as const;

const REFUSAL_STATUS: Record<RepoMapRefusal["code"], 400 | 403 | 404 | 409 | 429> = {
  not_found: 404,
  conflict: 409,
  invalid_url: 400,
  invalid_target: 400,
  invalid_issue: 400,
  consent_required: 403,
  quota_exceeded: 429,
};

/** GitHub の失敗を、利用者に見せる応答へ写す。運営側の問題は記録する。 */
function githubFailure(error: GitHubError, path: string) {
  const byKind: Record<
    GitHubErrorKind,
    { status: 404 | 422 | 502 | 503; error: string; message: string }
  > = {
    "not-found": {
      status: 404,
      error: "repo_not_found",
      message: "リポジトリが見つかりません。公開されているか、URL を確かめてください。",
    },
    moved: {
      status: 404,
      error: "repo_moved",
      message:
        "リポジトリが移動したか、名前が変わった可能性があります。新しい URL を入れてください。",
    },
    "too-large": {
      status: 422,
      error: "repo_too_large",
      message: "リポジトリが大きすぎて、ファイルの一覧を全部は取得できません。",
    },
    "rate-limited": {
      status: 503,
      error: "github_rate_limited",
      message: "GitHub の利用上限に達しています。しばらくしてからもう一度お試しください。",
    },
    timeout: {
      status: 502,
      error: "github_unavailable",
      message: "GitHub から時間内に応答がありませんでした。もう一度お試しください。",
    },
    unreachable: {
      status: 502,
      error: "github_unavailable",
      message: "GitHub へ接続できませんでした。もう一度お試しください。",
    },
    unavailable: {
      status: 502,
      error: "github_unavailable",
      message: "GitHub がエラーを返しました。しばらくしてからもう一度お試しください。",
    },
    unreadable: {
      status: 502,
      error: "github_unavailable",
      message: "GitHub の応答を読めませんでした。もう一度お試しください。",
    },
    unauthorized: {
      status: 503,
      error: "github_not_configured",
      message: "リポジトリを読む設定が整っていません。運営へお知らせください。",
    },
  };
  const out = byKind[error.kind];
  if (error.kind === "unauthorized" || error.kind === "unreadable") {
    console.error("github request failed", { path, kind: error.kind, detail: error.message });
  }
  return out;
}

type Env = { Bindings: CloudflareBindings; Variables: AuthVariables };

export function createRepoMapsRoute(resolve: RepoMapsDepsResolver) {
  const app = new Hono<Env>();

  /** サービスの失敗を HTTP の応答にする。それ以外の例外はそのまま投げる（500）。 */
  function respondFailure(c: Context<Env>, error: unknown) {
    if (error instanceof RepoMapRefusal) {
      return c.json(
        { error: error.code, message: error.message, ...error.detail },
        REFUSAL_STATUS[error.code],
        NO_STORE,
      );
    }
    if (error instanceof AiStageFailure) {
      return c.json(error.body, error.status, NO_STORE);
    }
    if (error instanceof GitHubError) {
      const failure = githubFailure(error, c.req.path);
      return c.json({ error: failure.error, message: failure.message }, failure.status, NO_STORE);
    }
    throw error;
  }

  app.post("/repo-maps:inspect", async (c) => {
    const userId = c.get("user").userId;
    const input = await parseBody(c, inspectRepoSchema);
    try {
      const body = await inspectRepo(resolve(c.env), userId, input.url);
      return c.json(body, 200, NO_STORE);
    } catch (error) {
      return respondFailure(c, error);
    }
  });

  app.post("/repo-map-drafts", async (c) => {
    const userId = c.get("user").userId;
    const input = await parseBody(c, createRepoMapDraftSchema);
    try {
      const body: CreateRepoMapDraftResponse = await createDraft(resolve(c.env), userId, input);
      return c.json(body, 201, NO_STORE);
    } catch (error) {
      return respondFailure(c, error);
    }
  });

  app.post("/repo-map-drafts/:id/summarize", async (c) => {
    const userId = c.get("user").userId;
    const input = await parseBody(c, summarizeRepoMapDraftSchema);
    try {
      const body = await summarizeDraft(resolve(c.env), userId, c.req.param("id"), input);
      return c.json(body, 200, NO_STORE);
    } catch (error) {
      return respondFailure(c, error);
    }
  });

  app.post("/repo-map-drafts/:id/candidates", async (c) => {
    const userId = c.get("user").userId;
    const input = await parseBody(c, candidatesRepoMapDraftSchema);
    try {
      const body = await buildCandidates(resolve(c.env), userId, c.req.param("id"), {
        consentVersion: input.consentVersion,
        excludeIds: [],
        rebuild: false,
      });
      return c.json(body, 200, NO_STORE);
    } catch (error) {
      return respondFailure(c, error);
    }
  });

  app.post("/repo-map-drafts/:id/confirm", async (c) => {
    const userId = c.get("user").userId;
    const input = await parseBody(c, confirmRepoMapDraftSchema);
    try {
      const body: ConfirmRepoMapDraftResponse = await confirmDraft(
        resolve(c.env),
        userId,
        c.req.param("id"),
        input,
      );
      return c.json(body, 201, NO_STORE);
    } catch (error) {
      return respondFailure(c, error);
    }
  });

  app.post("/repo-map-drafts/:id/rebuild", async (c) => {
    const userId = c.get("user").userId;
    const input = await parseBody(c, rebuildRepoMapDraftSchema);
    try {
      const body = await buildCandidates(resolve(c.env), userId, c.req.param("id"), {
        consentVersion: input.consentVersion,
        excludeIds: input.excludeIds,
        rebuild: true,
      });
      return c.json(body, 200, NO_STORE);
    } catch (error) {
      return respondFailure(c, error);
    }
  });

  app.get("/repo-maps/:mapId/sources", async (c) => {
    const userId = c.get("user").userId;
    const found = await resolve(c.env).maps?.getRepoSource(userId, c.req.param("mapId"));
    if (found === undefined) {
      throw new HTTPException(503, { message: "maps are not configured" });
    }
    // 他人のマップ・リポジトリから作っていないマップは、存在しないのと同じ 404。
    if (found === null) throw new HTTPException(404, { message: "repo map source not found" });
    const ref = parseRepoUrl(found.url);
    if (ref === null) throw new Error(`stored repo url is invalid: ${found.url}`);
    const byNode = new Map<string, RepoMapSourcesResponse["nodes"][number]["sources"]>();
    for (const s of found.nodeSources) {
      const list = byNode.get(s.conceptId) ?? [];
      list.push({
        kind: s.kind,
        path: s.path,
        issueNumber: s.issueNumber,
        url:
          s.kind === "issue" && s.issueNumber !== null
            ? issueLink(ref, s.issueNumber)
            : permalink(ref, found.commitSha, s.path ?? ""),
        summary: s.summary,
      });
      byNode.set(s.conceptId, list);
    }
    const body: RepoMapSourcesResponse = {
      repo: { url: found.url, commitSha: found.commitSha },
      nodes: [...byNode].map(([conceptId, sources]) => ({ conceptId, sources })),
    };
    return c.json(body, 200, NO_STORE);
  });

  app.get("/repo-map-drafts", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const nowIso = deps.now().toISOString();
    const [drafts, usage] = await Promise.all([
      deps.drafts.list(userId, nowIso),
      currentUsage(deps, userId),
    ]);
    const body: ListRepoMapDraftsResponse = { drafts: drafts.map(draftView), usage };
    return c.json(body, 200, NO_STORE);
  });

  app.get("/repo-map-drafts/:id", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const draft = await deps.drafts.get(userId, c.req.param("id"));
    // 期限切れは、他人のものと同じく存在しないものとして扱う。
    if (draft === null || draft.expiresAt <= deps.now().toISOString()) {
      throw new HTTPException(404, { message: "repo map draft not found" });
    }
    return c.json(draftView(draft), 200, NO_STORE);
  });

  app.delete("/repo-map-drafts/:id", async (c) => {
    const userId = c.get("user").userId;
    const deleted = await resolve(c.env).drafts.delete(userId, c.req.param("id"));
    if (!deleted) throw new HTTPException(404, { message: "repo map draft not found" });
    return c.body(null, 204);
  });

  return app;
}
