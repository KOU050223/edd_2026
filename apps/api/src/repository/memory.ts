/**
 * `LearningEventRepository` のインメモリ実装。テスト用。
 *
 * `test:unit` は素の vitest で Worker ランタイムを持たないため、
 * ハンドラのテストはこの実装を挿して動かす。D1 実装との差異が出ないよう、
 * 冪等性の単位（ユーザーごと）と並び順（発生時刻の昇順、同時刻は ID 昇順）を
 * SQL 側と一致させてある。
 */

import type {
  Conversation,
  HistoryProviderId,
  LearningEvent,
  LearningEvidence,
  UnmappedCandidate,
} from "@gakushu-sochi/domain";
import type { ImportSessionView } from "../contract/history-import.js";
import type { ConversationSummary } from "../contract/conversations.js";
import { ACCOUNT_DELETION_TOMBSTONE_TTL_MS } from "./types.js";
import type {
  AppendResult,
  AuditLogEntry,
  AuditLogRepository,
  ConversationListParams,
  ConversationRepository,
  IdentityRepository,
  ImportSessionRepository,
  LearningEventRepository,
  LearningEvidenceRepository,
  StoredEventInput,
  StoredImportSessionInput,
} from "./types.js";

export interface InMemoryRepositoryStore {
  readonly users: Map<string, { createdAtMs: number }>;
  readonly devicesByUser: Map<string, Map<string, { lastSeenAtMs: number }>>;
  readonly eventsByUser: Map<string, Map<string, LearningEvent>>;
  readonly deletingUsers: Map<string, number>;
  /** userId -> 最後に履歴を削除した時刻。D1 の learning_history_resets に対応する。 */
  readonly historyResets: Map<string, number>;
  /** D1 の audit_log に対応する。追記のみ。 */
  readonly auditLog: AuditLogEntry[];
  /** userId -> (evidenceId -> evidence)。D1 の learning_evidence に対応する。 */
  readonly evidenceByUser: Map<string, Map<string, LearningEvidence>>;
  /**
   * userId -> (sessionId -> session)。
   * D1 の import_sessions に対応する。view に session の入力をそのまま持ち、
   * unmappedCandidates は view に含まれないため別途持つ。
   */
  readonly importSessionsByUser: Map<
    string,
    Map<string, { session: ImportSessionView; unmappedCandidates: UnmappedCandidate[] }>
  >;
  /** userId -> (conversationId -> conversation)。D1 の conversations に対応する。 */
  readonly conversationsByUser: Map<string, Map<string, Conversation>>;
}

export function createInMemoryRepositoryStore(): InMemoryRepositoryStore {
  return {
    users: new Map(),
    devicesByUser: new Map(),
    eventsByUser: new Map(),
    deletingUsers: new Map(),
    historyResets: new Map(),
    auditLog: [],
    evidenceByUser: new Map(),
    importSessionsByUser: new Map(),
    conversationsByUser: new Map(),
  };
}

function isDeletionActive(store: InMemoryRepositoryStore, userId: string, nowMs: number): boolean {
  const startedAtMs = store.deletingUsers.get(userId);
  return startedAtMs !== undefined && startedAtMs > nowMs - ACCOUNT_DELETION_TOMBSTONE_TTL_MS;
}

export class InMemoryLearningEventRepository implements LearningEventRepository {
  /** userId -> (eventId -> event)。ユーザー単位で冪等にするための入れ子。 */
  private readonly byUser: Map<string, Map<string, LearningEvent>>;

  constructor(private readonly store = createInMemoryRepositoryStore()) {
    this.byUser = store.eventsByUser;
  }

  append(userId: string, inputs: readonly StoredEventInput[]): Promise<AppendResult[]> {
    if (isDeletionActive(this.store, userId, Date.now())) {
      return Promise.reject(new Error("user deletion is in progress"));
    }
    let events = this.byUser.get(userId);
    if (events === undefined) {
      events = new Map();
      this.byUser.set(userId, events);
    }

    const resetAtMs = this.store.historyResets.get(userId);
    const results = inputs.map(({ event, receivedAtMs }) => {
      // 履歴の削除より前に受け取ったイベントは書かず、受理として返す（D1 実装と同じ）。
      if (resetAtMs !== undefined && resetAtMs >= receivedAtMs) {
        return { id: event.id, duplicate: false, droppedByReset: true };
      }
      if (events.has(event.id)) {
        // 既存を上書きしない。イベントは追記のみで、あとから書き換えない。
        return { id: event.id, duplicate: true, droppedByReset: false };
      }
      events.set(event.id, event);
      return { id: event.id, duplicate: false, droppedByReset: false };
    });

    return Promise.resolve(results);
  }

  listByUser(userId: string): Promise<LearningEvent[]> {
    const events = [...(this.byUser.get(userId)?.values() ?? [])];
    events.sort((a, b) => {
      const timeDiff = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return Promise.resolve(events);
  }

  countByUser(userId: string): Promise<number> {
    return Promise.resolve(this.byUser.get(userId)?.size ?? 0);
  }

  deleteByUser(userId: string, resetAtMs: number): Promise<number> {
    const previous = this.store.historyResets.get(userId);
    this.store.historyResets.set(userId, Math.max(previous ?? resetAtMs, resetAtMs));
    const count = this.byUser.get(userId)?.size ?? 0;
    this.byUser.delete(userId);
    return Promise.resolve(count);
  }

  latestResetAtMs(userId: string): Promise<number | null> {
    return Promise.resolve(this.store.historyResets.get(userId) ?? null);
  }

  deleteUser(userId: string): void {
    this.byUser.delete(userId);
  }
}

/**
 * `IdentityRepository` のインメモリ実装。テスト用。
 *
 * D1 実装と違い外部キーは無いが、ハンドラが登録を呼び忘れていないかを
 * テストで確かめられるよう、登録済みの組を記録しておく。
 */
export class InMemoryIdentityRepository implements IdentityRepository {
  readonly users: Map<string, { createdAtMs: number }>;

  /**
   * userId -> (clientId -> 端末)。
   *
   * `${userId}:${clientId}` のような連結した1つのキーにしない。連結は一意な
   * エンコードではなく、(userId="a:b", clientId="c") と
   * (userId="a", clientId="b:c") が同じキーになる。D1 側は複合主キーで
   * この衝突が起きないため、連結したままだとテスト実装だけが実際と違う
   * ふるまいをして、DB 制約の問題を見逃す。
   */
  private readonly devicesByUser: Map<string, Map<string, { lastSeenAtMs: number }>>;

  constructor(private readonly store = createInMemoryRepositoryStore()) {
    this.users = store.users;
    this.devicesByUser = store.devicesByUser;
  }

  ensureUser(params: { userId: string; nowMs: number }): Promise<void> {
    if (isDeletionActive(this.store, params.userId, params.nowMs)) {
      return Promise.reject(new Error("user deletion is in progress"));
    }
    if (!this.users.has(params.userId)) {
      this.users.set(params.userId, { createdAtMs: params.nowMs });
    }
    return Promise.resolve();
  }

  ensureUserAndDevice(params: { userId: string; clientId: string; nowMs: number }): Promise<void> {
    const { userId, clientId, nowMs } = params;

    if (isDeletionActive(this.store, userId, nowMs)) {
      return Promise.reject(new Error("user deletion is in progress"));
    }

    void this.ensureUser({ userId, nowMs });

    let devices = this.devicesByUser.get(userId);
    if (devices === undefined) {
      devices = new Map();
      this.devicesByUser.set(userId, devices);
    }

    const existing = devices.get(clientId);
    if (existing === undefined) {
      devices.set(clientId, { lastSeenAtMs: nowMs });
    } else {
      existing.lastSeenAtMs = nowMs;
    }

    return Promise.resolve();
  }

  startUserDeletion(userId: string, startedAtMs: number): Promise<void> {
    this.store.deletingUsers.set(userId, startedAtMs);
    return Promise.resolve();
  }

  /**
   * ユーザーと端末を消す。D1 側の `ON DELETE CASCADE` に対応する。
   *
   * イベントは別の実装（`InMemoryLearningEventRepository`）が持つため、
   * ここでは消せない。D1 では1文で両方消えるという差があるので、
   * 退会をまたいでイベントを確かめるテストは D1 と同じ形にならない点に注意する。
   */
  deleteUser(userId: string): Promise<void> {
    this.users.delete(userId);
    this.devicesByUser.delete(userId);
    this.store.eventsByUser.delete(userId);
    this.store.historyResets.delete(userId);
    // learning_evidence / import_sessions / conversations も users(id) を
    // CASCADE で参照する。
    this.store.evidenceByUser.delete(userId);
    this.store.importSessionsByUser.delete(userId);
    this.store.conversationsByUser.delete(userId);
    // D1 の audit_log は users(id) を ON DELETE CASCADE で参照している。
    // 退会で監査ログも消えるという実際の振る舞いに合わせる。
    for (let i = this.store.auditLog.length - 1; i >= 0; i--) {
      if (this.store.auditLog[i]?.userId === userId) {
        this.store.auditLog.splice(i, 1);
      }
    }
    return Promise.resolve();
  }

  /** テストから端末を参照するための補助。 */
  getDevice(userId: string, clientId: string): { lastSeenAtMs: number } | undefined {
    return this.devicesByUser.get(userId)?.get(clientId);
  }

  /** 登録済みの端末の総数。 */
  get deviceCount(): number {
    let total = 0;
    for (const devices of this.devicesByUser.values()) {
      total += devices.size;
    }
    return total;
  }
}

/**
 * `AuditLogRepository` のインメモリ実装。テスト用。
 *
 * 記録はストアの `auditLog` に追記される。テストはそこを直接読んで
 * 「何が記録されたか」を確かめる。
 */
export class InMemoryAuditLogRepository implements AuditLogRepository {
  constructor(private readonly store = createInMemoryRepositoryStore()) {}

  record(entry: AuditLogEntry): Promise<void> {
    this.store.auditLog.push(entry);
    return Promise.resolve();
  }
}

/**
 * `LearningEvidenceRepository` のインメモリ実装。テスト用。
 *
 * D1 実装と同じく、セッション単位・ソース単位・全件の削除を持つ。
 */
export class InMemoryLearningEvidenceRepository implements LearningEvidenceRepository {
  private readonly byUser: Map<string, Map<string, LearningEvidence>>;

  constructor(private readonly store = createInMemoryRepositoryStore()) {
    this.byUser = store.evidenceByUser;
  }

  listByUser(userId: string): Promise<LearningEvidence[]> {
    const items = [...(this.byUser.get(userId)?.values() ?? [])];
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return Promise.resolve(items);
  }

  listBySession(userId: string, sessionId: string): Promise<LearningEvidence[]> {
    const items = [...(this.byUser.get(userId)?.values() ?? [])]
      .filter((item) => item.importSessionId === sessionId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return Promise.resolve(items);
  }

  deleteByProvider(
    userId: string,
    provider: HistoryProviderId,
    updatedAt: string,
  ): Promise<{ deletedCount: number; sessionsMarkedUndone: number }> {
    const items = this.byUser.get(userId);
    let deletedCount = 0;
    if (items !== undefined) {
      for (const [id, item] of items) {
        if (item.source.provider === provider) {
          items.delete(id);
          deletedCount += 1;
        }
      }
    }
    // D1 と同じく、Evidence が残らなくなった applied の Session を undone に倒す。
    let sessionsMarkedUndone = 0;
    const sessions = this.store.importSessionsByUser.get(userId);
    if (sessions !== undefined) {
      for (const [sessionId, record] of sessions) {
        if (record.session.status !== "applied") continue;
        const remaining = [...(this.byUser.get(userId)?.values() ?? [])].some(
          (item) => item.importSessionId === sessionId,
        );
        if (!remaining) {
          record.session = { ...record.session, status: "undone", updatedAt };
          sessionsMarkedUndone += 1;
        }
      }
    }
    return Promise.resolve({ deletedCount, sessionsMarkedUndone });
  }

  deleteAllByUser(userId: string): Promise<number> {
    const count = this.byUser.get(userId)?.size ?? 0;
    this.byUser.delete(userId);
    return Promise.resolve(count);
  }
}

/**
 * `ConversationRepository` のインメモリ実装。テスト用（Issue #204）。
 *
 * D1 実装との差異が出ないよう、upsert の「既存のほうが新しければ
 * 書き換えない」判定と、一覧の並び順（更新時刻の降順・同時刻は ID 昇順）、
 * カーソルの切り方を SQL 側と一致させてある。
 */
export class InMemoryConversationRepository implements ConversationRepository {
  private readonly byUser: Map<string, Map<string, Conversation>>;

  constructor(private readonly store = createInMemoryRepositoryStore()) {
    this.byUser = store.conversationsByUser;
  }

  upsert(
    userId: string,
    conversation: Conversation,
    receivedAtMs: number,
  ): Promise<{ saved: boolean }> {
    // 受信時刻を「今」としてトゥームストーンを判定する（ルート側で nowMs を渡す）。
    if (isDeletionActive(this.store, userId, receivedAtMs)) {
      return Promise.reject(new Error("user deletion is in progress"));
    }
    let items = this.byUser.get(userId);
    if (items === undefined) {
      items = new Map();
      this.byUser.set(userId, items);
    }

    const existing = items.get(conversation.id);
    // 既存のほうが新しい会話を古いスナップショットで巻き戻さない。
    // 同時刻は書き換える（同じ内容の再送は冪等）。
    if (
      existing !== undefined &&
      Date.parse(existing.updatedAt) > Date.parse(conversation.updatedAt)
    ) {
      return Promise.resolve({ saved: false });
    }
    items.set(conversation.id, conversation);
    return Promise.resolve({ saved: true });
  }

  listByUser(userId: string, params: ConversationListParams): Promise<ConversationSummary[]> {
    const sorted = sortedConversations(this.byUser.get(userId));
    const filtered = params.cursor
      ? sorted.filter((conversation) => {
          const updatedAtMs = Date.parse(conversation.updatedAt);
          if (updatedAtMs !== params.cursor!.updatedAtMs) {
            return updatedAtMs < params.cursor!.updatedAtMs;
          }
          return conversation.id > params.cursor!.id;
        })
      : sorted;
    return Promise.resolve(filtered.slice(0, params.limit).map(toSummary));
  }

  getById(userId: string, id: string): Promise<Conversation | null> {
    return Promise.resolve(this.byUser.get(userId)?.get(id) ?? null);
  }

  deleteById(userId: string, id: string): Promise<number> {
    return Promise.resolve(this.byUser.get(userId)?.delete(id) ? 1 : 0);
  }

  deleteAllByUser(userId: string): Promise<number> {
    const count = this.byUser.get(userId)?.size ?? 0;
    this.byUser.delete(userId);
    return Promise.resolve(count);
  }

  listAllByUser(userId: string): Promise<Conversation[]> {
    return Promise.resolve(sortedConversations(this.byUser.get(userId)));
  }
}

/** 一覧・エクスポート共通の並び順。D1 側の ORDER BY updated_at_ms DESC, id ASC と一致させる。 */
function sortedConversations(items: Map<string, Conversation> | undefined): Conversation[] {
  const conversations = [...(items?.values() ?? [])];
  conversations.sort((a, b) => {
    const timeDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (timeDiff !== 0) return timeDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return conversations;
}

function toSummary(conversation: Conversation): ConversationSummary {
  return {
    id: conversation.id,
    origin: conversation.origin,
    ...(conversation.clientId === undefined ? {} : { clientId: conversation.clientId }),
    ...(conversation.title === undefined ? {} : { title: conversation.title }),
    ...(conversation.language === undefined ? {} : { language: conversation.language }),
    ...(conversation.fileName === undefined ? {} : { fileName: conversation.fileName }),
    occurredAt: conversation.occurredAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    complete: conversation.complete,
  };
}

/**
 * `ImportSessionRepository` のインメモリ実装。テスト用。
 */
export class InMemoryImportSessionRepository implements ImportSessionRepository {
  private readonly byUser: Map<
    string,
    Map<string, { session: ImportSessionView; unmappedCandidates: UnmappedCandidate[] }>
  >;

  constructor(private readonly store = createInMemoryRepositoryStore()) {
    this.byUser = store.importSessionsByUser;
  }

  createWithEvidence(
    userId: string,
    session: StoredImportSessionInput,
    evidence: readonly LearningEvidence[],
  ): Promise<{ alreadyExisted: boolean }> {
    if (isDeletionActive(this.store, userId, Date.now())) {
      return Promise.reject(new Error("user deletion is in progress"));
    }
    let sessions = this.byUser.get(userId);
    if (sessions === undefined) {
      sessions = new Map();
      this.byUser.set(userId, sessions);
    }
    if (sessions.has(session.id)) {
      // 再送の正常系。D1 の ON CONFLICT DO NOTHING と同じく何も書き足さない。
      return Promise.resolve({ alreadyExisted: true });
    }

    const view: ImportSessionView = {
      id: session.id,
      status: "applied",
      importedBy: session.importedBy as ImportSessionView["importedBy"],
      providers: session.providers as ImportSessionView["providers"],
      conversationCount: session.conversationCount,
      ignoredCount: session.ignoredCount,
      evidenceCount: session.evidenceCount,
      conceptCount: session.conceptCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
    sessions.set(session.id, {
      session: view,
      unmappedCandidates: [...session.unmappedCandidates],
    });

    let items = this.store.evidenceByUser.get(userId);
    if (items === undefined) {
      items = new Map();
      this.store.evidenceByUser.set(userId, items);
    }
    for (const item of evidence) {
      // Evidence も (user_id, id) で冪等。既存を上書きしない。
      if (!items.has(item.id)) items.set(item.id, item);
    }
    return Promise.resolve({ alreadyExisted: false });
  }

  listByUser(userId: string): Promise<ImportSessionView[]> {
    const sessions = [...(this.byUser.get(userId)?.values() ?? [])].map((record) => record.session);
    // D1 側の ORDER BY created_at DESC, id ASC に合わせる。
    sessions.sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return Promise.resolve(sessions);
  }

  getById(
    userId: string,
    id: string,
  ): Promise<{ session: ImportSessionView; unmappedCandidates: UnmappedCandidate[] } | null> {
    const record = this.byUser.get(userId)?.get(id);
    return Promise.resolve(record ?? null);
  }

  undo(
    userId: string,
    sessionId: string,
    updatedAt: string,
  ): Promise<{ status: string; deletedEvidenceCount: number } | null> {
    const record = this.byUser.get(userId)?.get(sessionId);
    if (record === undefined) return Promise.resolve(null);
    if (record.session.status === "undone") {
      return Promise.resolve({ status: "undone", deletedEvidenceCount: 0 });
    }
    if (record.session.status !== "applied") {
      return Promise.resolve({ status: record.session.status, deletedEvidenceCount: 0 });
    }

    const items = this.store.evidenceByUser.get(userId);
    let deletedEvidenceCount = 0;
    if (items !== undefined) {
      for (const [id, item] of items) {
        if (item.importSessionId === sessionId) {
          items.delete(id);
          deletedEvidenceCount += 1;
        }
      }
    }
    record.session = { ...record.session, status: "undone", updatedAt };
    return Promise.resolve({ status: "undone", deletedEvidenceCount });
  }

  deleteAllByUser(userId: string): Promise<number> {
    const count = this.byUser.get(userId)?.size ?? 0;
    this.byUser.delete(userId);
    return Promise.resolve(count);
  }
}
