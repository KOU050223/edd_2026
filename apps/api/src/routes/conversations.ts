/**
 * `/v1/conversations`（Issue #204）。質問履歴の保存・閲覧・削除。
 *
 * 質問文・選択テキスト・AI の回答の本文を保存するため、二重のゲートを置く
 * （docs/conversation-history.md）。クライアントが送信前にオプトインを
 * 確認するのに加えて、ここでも `saveConversationHistory` を読んでから
 * 書き込む。クライアント側のキャッシュが古くても、オプトイン無しの
 * 本文は保存されない。
 *
 * 対象のユーザーは `c.get("user").userId` だけから決める。パスにもボディにも
 * userId を取らない（routes/account.ts と同じ規律）。
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as v from "valibot";
import type { AuthVariables } from "../auth/middleware.js";
import {
  CONVERSATIONS_DEFAULT_LIMIT,
  CONVERSATIONS_MAX_LIMIT,
  conversationSchema,
  encodeConversationCursor,
  parseConversationCursor,
  type ConversationExport,
  type DeleteConversationsResponse,
  type ListConversationsResponse,
  type PutConversationResponse,
} from "../contract/conversations.js";
import type {
  AuditLogRepository,
  ConversationRepository,
  IdentityRepository,
  UserSettingsRepository,
} from "../repository/types.js";

export interface ConversationsDeps {
  identity: IdentityRepository;
  conversations: ConversationRepository;
  /**
   * 書き込みの可否判定に使う。`saveConversationHistory` が無効なら
   * 本文は保存しない。
   */
  settings: UserSettingsRepository;
  audit: AuditLogRepository;
  nowIso: () => string;
  nowMs: () => number;
}

export type ConversationsDepsResolver = (env: CloudflareBindings) => ConversationsDeps;

/** 一覧の limit クエリの検証。解釈できない値は既定値へ丸めず 400 にする。 */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return CONVERSATIONS_DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > CONVERSATIONS_MAX_LIMIT) {
    throw new HTTPException(400, {
      message: `limit must be an integer between 1 and ${CONVERSATIONS_MAX_LIMIT}`,
    });
  }
  return limit;
}

export function createConversationsRoute(resolve: ConversationsDepsResolver) {
  const app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();

  app.put("/conversations/:id", async (c) => {
    const userId = c.get("user").userId;
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "invalid request body" });
    }
    const parsed = v.safeParse(conversationSchema, payload);
    if (!parsed.success) {
      // 拒否の理由に入力値を載せない。本文を含むリクエストの内容が
      // エラーメッセージ経由で応答・ログへ漏れないようにするため、
      // issue.message（こちらが書いた定型文）とパスだけを返す。
      const issue = parsed.issues[0];
      const path = issue?.path?.map((entry) => String(entry.key)).join(".");
      throw new HTTPException(400, {
        message: path ? `${path}: ${issue?.message}` : (issue?.message ?? "invalid conversation"),
      });
    }
    const conversation = parsed.output;
    if (conversation.id !== c.req.param("id")) {
      throw new HTTPException(400, { message: "path id and body id must match" });
    }

    const deps = resolve(c.env);
    // サーバー側のゲート。設定行が無い（=一度も保存していない）なら
    // 既定値の false と同じく拒否する。
    const settings = await deps.settings.get(userId);
    if (settings?.saveConversationHistory !== true) {
      throw new HTTPException(403, { message: "conversation_history_disabled" });
    }

    // conversations.user_id は users(id) を参照する。
    await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });
    const { saved } = await deps.conversations.upsert(userId, conversation, deps.nowMs());
    const body: PutConversationResponse = saved
      ? { saved: true }
      : { saved: false, reason: "newer_exists" };
    return c.json(body, 200);
  });

  app.get("/conversations", async (c) => {
    const userId = c.get("user").userId;
    const limit = parseLimit(c.req.query("limit"));
    const rawCursor = c.req.query("cursor");
    const cursor =
      rawCursor === undefined ? undefined : (parseConversationCursor(rawCursor) ?? undefined);
    if (rawCursor !== undefined && cursor === undefined) {
      throw new HTTPException(400, { message: "invalid cursor" });
    }

    const deps = resolve(c.env);
    // 次頁の有無を判定するため、表示件数+1件読む。
    const rows = await deps.conversations.listByUser(userId, { limit: limit + 1, cursor });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const body: ListConversationsResponse = {
      conversations: page,
      nextCursor: rows.length > limit && last !== undefined ? encodeConversationCursor(last) : null,
    };
    // 本文のメタ情報を中間キャッシュに残さない。
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  app.get("/conversations:export", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    // audit_log.user_id は users(id) を参照する。一度も同期していない
    // 利用者でも記録できるよう、先に行を用意する（learning-events と同じ）。
    await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });
    const conversations = await deps.conversations.listAllByUser(userId);
    await deps.audit.record({
      userId,
      action: "conversations.exported",
      occurredAtMs: deps.nowMs(),
      detail: { conversationCount: conversations.length },
    });
    const body: ConversationExport = {
      version: 1,
      exportedAt: deps.nowIso(),
      conversations,
    };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  app.get("/conversations/:id", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    const conversation = await deps.conversations.getById(userId, c.req.param("id"));
    if (conversation === null) {
      throw new HTTPException(404, { message: "conversation not found" });
    }
    return c.json(conversation, 200, { "cache-control": "no-store" });
  });

  app.delete("/conversations/:id", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });
    const deletedCount = await deps.conversations.deleteById(userId, c.req.param("id"));
    await deps.audit.record({
      userId,
      action: "conversations.deleted",
      occurredAtMs: deps.nowMs(),
      detail: { deletedCount },
    });
    const body: DeleteConversationsResponse = { deletedCount };
    return c.json(body, 200);
  });

  app.delete("/conversations", async (c) => {
    const userId = c.get("user").userId;
    const deps = resolve(c.env);
    await deps.identity.ensureUser({ userId, nowMs: deps.nowMs() });
    const deletedCount = await deps.conversations.deleteAllByUser(userId);
    // 不可逆な操作なので件数を記録する。本文は detail に入れない。
    await deps.audit.record({
      userId,
      action: "conversations.deleted",
      occurredAtMs: deps.nowMs(),
      detail: { deletedCount },
    });
    const body: DeleteConversationsResponse = { deletedCount };
    return c.json(body, 200);
  });

  return app;
}
