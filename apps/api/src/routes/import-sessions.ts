/**
 * 外部 AI 履歴からの学習引き継ぎ（Issue #157）の API。
 *
 * - `POST /v1/import-sessions`: 正規化済み Evidence を Import Session として保存。
 * - `GET /v1/import-sessions`: 自分の Import の一覧（ソース管理画面）。
 * - `GET /v1/import-sessions/:id`: 詳細。Evidence と unmapped 候補を含む。
 * - `DELETE /v1/import-sessions/:id`: Undo。Evidence を消し undone にする。
 * - `GET /v1/learning-evidence`: 自分の Evidence の一覧（「なぜ」の根拠）。
 * - `GET /v1/learning-evidence:export`: Session と Evidence のエクスポート。
 * - `DELETE /v1/learning-evidence?provider=...`: 履歴ソース単位の削除。
 *
 * 会話本文は受け取らない。Normalizer（packages/domain の evidence.ts）を
 * 通した Evidence だけが HTTP を越える。
 */

import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import * as v from "valibot";
import type { HistoryProviderId, LearningEvidence } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import type {
  AuditLogRepository,
  IdentityRepository,
  ImportSessionRepository,
  LearningEvidenceRepository,
} from "../repository/types.js";
import {
  MAX_UNMAPPED_CANDIDATES,
  createImportSessionSchema,
  type CreateImportSessionResponse,
  type DeleteLearningEvidenceResponse,
  type ImportSessionDetail,
  type LearningEvidenceExport,
  type ListLearningEvidenceResponse,
  type UndoImportSessionResponse,
} from "../contract/history-import.js";

export interface ImportDeps {
  identity: IdentityRepository;
  sessions: ImportSessionRepository;
  evidence: LearningEvidenceRepository;
  /** 監査ログ（Issue #122）。エクスポートと削除を記録する。 */
  audit: AuditLogRepository;
  /** 現在時刻を ISO 8601 で返す。テストで固定できるよう注入する。 */
  nowIso: () => string;
  nowMs: () => number;
}

/** {@link SyncDepsResolver} と同じ理由で、依存はリクエスト時に解決する。 */
export type ImportDepsResolver = (env: CloudflareBindings) => ImportDeps;

const PROVIDERS = [
  "codex",
  "chatgpt",
  "claude-code",
  "claude",
  "copilot",
  "cursor",
  "gemini",
  "vscode",
] as const;

const deleteEvidenceQuerySchema = v.object({
  provider: v.picklist(PROVIDERS),
});

export function createImportSessionsRoute(resolve: ImportDepsResolver) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  app.post("/import-sessions", vValidator("json", createImportSessionSchema), async (c) => {
    const body = c.req.valid("json");
    const userId = c.get("user").userId;
    const deps = resolve(c.env);

    // Evidence の importSessionId は Normalizer が埋める。Session の ID と
    // 食い違う Evidence を受けると Undo の単位が壊れるため、境界で検査する。
    const mismatched = body.evidence.some(
      (item) => item.importSessionId !== undefined && item.importSessionId !== body.id,
    );
    if (mismatched) {
      return c.json({ error: "evidence.importSessionId does not match the session id" }, 400);
    }
    // Evidence ID は `${sessionId}:${provider}:${sourceId}` で決定的に作る
    // 契約（docs/concepts.md）。別の規則で採番された ID を通すと
    // Undo・重複排除・「何の Import に属するか」の追跡が壊れる。
    const badId = body.evidence.some(
      (item) => !item.id.startsWith(`${body.id}:${item.source.provider}:`),
    );
    if (badId) {
      return c.json({ error: 'evidence.id must start with "<sessionId>:<provider>:"' }, 400);
    }
    // Evidence 内の provider は Session の providers に含まれているはず。
    // 含まれない組を通すと、ソース管理画面の集計と中身が食い違う。
    const declared = new Set<string>(body.providers);
    if (body.evidence.some((item) => !declared.has(item.source.provider))) {
      return c.json({ error: "evidence contains a provider not listed in providers" }, 400);
    }

    await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });

    const now = deps.nowIso();
    const conceptIds = new Set<string>();
    for (const item of body.evidence) {
      for (const conceptId of item.conceptIds) conceptIds.add(conceptId);
    }

    const { alreadyExisted } = await deps.sessions.createWithEvidence(
      userId,
      {
        id: body.id,
        importedBy: body.importedBy,
        providers: body.providers,
        conversationCount: body.conversationCount,
        ignoredCount: body.ignoredCount ?? 0,
        unmappedCandidates: (body.unmappedCandidates ?? []).slice(0, MAX_UNMAPPED_CANDIDATES),
        evidenceCount: body.evidence.length,
        conceptCount: conceptIds.size,
        createdAt: now,
        updatedAt: now,
      },
      body.evidence as LearningEvidence[],
    );

    // 再送なら保存済みの行をそのまま返す。新規に採番した値を返すと、
    // 初回の応答と再送の応答で食い違う。
    const stored = await deps.sessions.getById(userId, body.id);
    if (stored === null) {
      // createWithEvidence が成功して直後に読めないのはリポジトリの不整合。
      // 成功のふりをせず落とす（RULE-004）。
      throw new Error("import session was not stored");
    }

    const response: CreateImportSessionResponse = { ...stored.session, alreadyExisted };
    return c.json(response);
  });

  app.get("/import-sessions", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    return c.json({ sessions: await deps.sessions.listByUser(userId) });
  });

  app.get("/import-sessions/:id", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const id = c.req.param("id");
    const stored = await deps.sessions.getById(userId, id);
    if (stored === null) {
      return c.json({ error: "import session not found" }, 404);
    }
    const evidence = await deps.evidence.listBySession(userId, id);
    const detail: ImportSessionDetail = {
      ...stored.session,
      evidence,
      unmappedCandidates: stored.unmappedCandidates,
    };
    return c.json(detail);
  });

  app.delete("/import-sessions/:id", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const id = c.req.param("id");

    const result = await deps.sessions.undo(userId, id, deps.nowIso());
    if (result === null) {
      return c.json({ error: "import session not found" }, 404);
    }
    if (result.status !== "undone") {
      // applied でも undone でもない状態を黙って消さない。
      // 状態機械で undone へ進めないものは、状態を添えて 409 を返す。
      return c.json({ error: "import session cannot be undone", status: result.status }, 409);
    }
    if (result.deletedEvidenceCount > 0) {
      await deps.audit.record({
        userId,
        action: "learning_evidence.deleted",
        occurredAtMs: deps.nowMs(),
        detail: { sessionId: id, deletedCount: result.deletedEvidenceCount },
      });
    }
    const response: UndoImportSessionResponse = {
      id,
      status: "undone",
      deletedEvidenceCount: result.deletedEvidenceCount,
    };
    return c.json(response);
  });

  app.get("/learning-evidence", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const response: ListLearningEvidenceResponse = {
      evidence: await deps.evidence.listByUser(userId),
    };
    return c.json(response);
  });

  app.get("/learning-evidence:export", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);

    // audit_log.user_id は users(id) を参照する。learning-data.ts と同じく、
    // 一度も同期していない利用者でも記録できるよう先に行を用意する。
    await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });
    const [sessions, evidence] = await Promise.all([
      deps.sessions.listByUser(userId),
      deps.evidence.listByUser(userId),
    ]);
    await deps.audit.record({
      userId,
      action: "learning_evidence.exported",
      occurredAtMs: deps.nowMs(),
      detail: { sessionCount: sessions.length, evidenceCount: evidence.length },
    });
    const response: LearningEvidenceExport = {
      version: 1,
      exportedAt: deps.nowIso(),
      sessions,
      evidence,
    };
    return c.json(response, 200, { "cache-control": "no-store" });
  });

  app.delete("/learning-evidence", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);

    // provider 以外での削除経路は持たない。query が無い・値が未知なら 400 にし、
    // 「全部消す」つもりの呼び出しが黙って何もしない状況を作らない。
    const parsed = v.safeParse(deleteEvidenceQuerySchema, {
      provider: c.req.query("provider"),
    });
    if (!parsed.success) {
      return c.json(
        { error: "provider query parameter is required and must be a known source" },
        400,
      );
    }

    await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });
    const { deletedCount, sessionsMarkedUndone } = await deps.evidence.deleteByProvider(
      userId,
      parsed.output.provider as HistoryProviderId,
      deps.nowIso(),
    );
    await deps.audit.record({
      userId,
      action: "learning_evidence.deleted",
      occurredAtMs: deps.nowMs(),
      detail: { provider: parsed.output.provider, deletedCount },
    });
    const response: DeleteLearningEvidenceResponse = { deletedCount, sessionsMarkedUndone };
    return c.json(response);
  });

  return app;
}
