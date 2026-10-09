/**
 * `LearningEventRepository` のインメモリ実装。テスト用。
 *
 * `test:unit` は素の vitest で Worker ランタイムを持たないため、
 * ハンドラのテストはこの実装を挿して動かす。D1 実装との差異が出ないよう、
 * 冪等性の単位（ユーザーごと）と並び順（発生時刻の昇順、同時刻は ID 昇順）を
 * SQL 側と一致させてある。
 */

import {
  checkTargetOf,
  type CheckLevel,
  type ConsentRecord,
  type PersonalConceptCheck,
} from "@gakushu-sochi/domain";
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
  CheckGenerationConsentRepository,
  ConceptCheckRepository,
  ConversationListParams,
  ConversationRepository,
  IdentityRepository,
  ImportSessionRepository,
  LearningEventRepository,
  LearningEvidenceRepository,
  LearningMapRepository,
  PersonalCheckRepository,
  StoredConceptCheck,
  StoredEventInput,
  StoredImportSessionInput,
  StoredLearningMap,
  CheckOrigin,
  StoredLearningObjective,
  StoredMapContent,
  StoredMapVersion,
  StoredOwnMapNode,
  StoredSharedMap,
} from "./types.js";
import type {
  LearningMapSummary,
  LearningObjectiveSource,
  MapVersionMeta,
  MapVersionSummary,
  SharedMapSummary,
  ShareScope,
} from "../contract/learning-maps.js";

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
  /**
   * conceptId -> 確認問題。D1 の concept_checks に対応する。
   *
   * 利用者に紐づかない共有コンテンツだが、ストアに同居させる。退会や履歴の削除が
   * これを巻き込まないことを、同じストアを共有したテストで確かめるため（#185）。
   */
  readonly conceptChecks: Map<string, StoredConceptCheck>;
  /** userId -> (`conceptId` + 狙い -> 確認問題)。D1 の user_concept_checks に対応する。 */
  readonly personalChecksByUser: Map<string, Map<string, PersonalConceptCheck>>;
  /**
   * userId -> マップを作るときに作った組のキー（`personalChecksByUser` と同じキー）。
   * D1 の user_concept_checks.origin = 'map_creation' に対応する（#247）。
   */
  readonly mapCreationCheckKeys: Map<string, Set<string>>;
  /** userId -> 生成への同意。D1 の check_generation_consents に対応する。 */
  readonly checkGenerationConsents: Map<string, ConsentRecord>;
  /** userId -> 学習マップの AI 生成への同意。D1 の map_generation_consents に対応する。 */
  readonly mapGenerationConsents: Map<string, ConsentRecord>;
  /** mapId -> マップ（ノード・線・項目込み）。D1 の learning_maps とその下の表に対応する。 */
  readonly learningMaps: Map<string, InMemoryLearningMap>;
  /**
   * 固定の Concept の「理解すること」。D1 の learning_objectives のうち map_id が NULL の行
   * （migrations/0017_fixed_objectives.sql）に対応する。既定は空。テストが要る分を入れる
   * （マイグレーションの Go の項目は `maps/test-fixed-objectives.ts`）。
   */
  readonly fixedObjectives: StoredLearningObjective[];
  /** conceptId -> 版。D1 の fixed_objective_revisions に対応する。 */
  readonly fixedObjectiveRevisions: Map<string, string>;
}

/** インメモリのマップ1件。 */
export interface InMemoryLearningMap extends StoredLearningMap {
  ownerUserId: string;
  updatedAtMs: number;
  /** 共有の版（#244）。古い版から。D1 の learning_map_versions に対応する。 */
  versions: (StoredMapVersion & { createdAtMs: number })[];
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
    conceptChecks: new Map(),
    personalChecksByUser: new Map(),
    mapCreationCheckKeys: new Map(),
    checkGenerationConsents: new Map(),
    mapGenerationConsents: new Map(),
    learningMaps: new Map(),
    fixedObjectives: [],
    fixedObjectiveRevisions: new Map(),
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
    // user_concept_checks / check_generation_consents も CASCADE で参照する（#236）。
    this.store.personalChecksByUser.delete(userId);
    this.store.mapCreationCheckKeys.delete(userId);
    this.store.checkGenerationConsents.delete(userId);
    this.store.mapGenerationConsents.delete(userId);
    // learning_maps も CASCADE で参照し、ノード・線・項目はマップから CASCADE で消える（#242）。
    for (const [mapId, map] of this.store.learningMaps) {
      if (map.ownerUserId === userId) this.store.learningMaps.delete(mapId);
    }
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

/** `ConceptCheckRepository` のインメモリ実装。テスト用。 */
export class InMemoryConceptCheckRepository implements ConceptCheckRepository {
  constructor(private readonly store: InMemoryRepositoryStore = createInMemoryRepositoryStore()) {}

  get(conceptId: string): Promise<StoredConceptCheck | null> {
    // D1 実装が JSON を読み戻すのと同じく、呼び出し側に保存済みの参照を渡さない。
    const stored = this.store.conceptChecks.get(conceptId);
    return Promise.resolve(stored === undefined ? null : structuredClone(stored));
  }

  put(stored: StoredConceptCheck): Promise<void> {
    this.store.conceptChecks.set(stored.check.conceptId, structuredClone(stored));
    return Promise.resolve();
  }
}

/**
 * `PersonalCheckRepository` のインメモリ実装。テスト用。
 *
 * キーは Concept ID と狙いの組（D1 の複合主キー）。区切り文字で連結すると一意にならないので、
 * `JSON.stringify` した配列をキーにする。
 */
export class InMemoryPersonalCheckRepository implements PersonalCheckRepository {
  constructor(private readonly store: InMemoryRepositoryStore = createInMemoryRepositoryStore()) {}

  listByConcept(userId: string, conceptId: string): Promise<PersonalConceptCheck[]> {
    const checks = [...(this.store.personalChecksByUser.get(userId)?.values() ?? [])]
      .filter((check) => check.conceptId === conceptId)
      .sort(
        (a, b) =>
          b.generatedAt.localeCompare(a.generatedAt) ||
          checkTargetOf(a).localeCompare(checkTargetOf(b)),
      );
    return Promise.resolve(structuredClone(checks));
  }

  put(
    userId: string,
    check: PersonalConceptCheck,
    startedAtMs: number,
    target?: { mapId: string; origin?: CheckOrigin },
  ): Promise<{ saved: true } | { saved: false; reason: "reset" | "target-removed" }> {
    // D1 実装と同じく、生成を始めたあとに学習データが削除されていたら書かない。
    const resetAtMs = this.store.historyResets.get(userId);
    if (resetAtMs !== undefined && resetAtMs >= startedAtMs) {
      return Promise.resolve({ saved: false, reason: "reset" });
    }
    // 手で作ったマップのノードなら、ノードと狙った項目がまだあるときだけ書く（#242）。
    if (target !== undefined) {
      const map = this.store.learningMaps.get(target.mapId);
      const node = map?.nodes.find((candidate) => candidate.conceptId === check.conceptId);
      const objectiveKept =
        check.objectiveId === undefined ||
        (map?.objectives.get(check.conceptId) ?? []).some(
          (objective) => objective.id === check.objectiveId,
        );
      if (map?.ownerUserId !== userId || node?.kind !== "own" || !objectiveKept) {
        return Promise.resolve({ saved: false, reason: "target-removed" });
      }
    } else if (
      check.objectiveId !== undefined &&
      !this.store.fixedObjectives.some(
        (objective) =>
          objective.id === check.objectiveId && objective.conceptId === check.conceptId,
      )
    ) {
      // 固定の Concept の項目を狙った組は、その項目がまだあるときだけ書く（#245。D1 と同じ）。
      return Promise.resolve({ saved: false, reason: "target-removed" });
    }
    let checks = this.store.personalChecksByUser.get(userId);
    if (checks === undefined) {
      checks = new Map();
      this.store.personalChecksByUser.set(userId, checks);
    }
    const key = JSON.stringify([check.conceptId, checkTargetOf(check)]);
    checks.set(key, structuredClone(check));
    let creationKeys = this.store.mapCreationCheckKeys.get(userId);
    if (creationKeys === undefined) {
      creationKeys = new Set();
      this.store.mapCreationCheckKeys.set(userId, creationKeys);
    }
    // 作り直すと書いた側の値で上書きされる（D1 の ON CONFLICT と同じ）。
    if (target?.origin === "map_creation") creationKeys.add(key);
    else creationKeys.delete(key);
    return Promise.resolve({ saved: true as const });
  }

  listMapCreationChecks(userId: string): Promise<PersonalConceptCheck[]> {
    const keys = this.store.mapCreationCheckKeys.get(userId) ?? new Set<string>();
    // 消された組のキーが残っていても、今ある組だけを返す。
    const checks = [...(this.store.personalChecksByUser.get(userId) ?? [])]
      .filter(([key]) => keys.has(key))
      .map(([, check]) => check)
      .sort(
        (a, b) =>
          a.conceptId.localeCompare(b.conceptId) ||
          checkTargetOf(a).localeCompare(checkTargetOf(b)),
      );
    return Promise.resolve(structuredClone(checks));
  }

  listAllByUser(userId: string): Promise<PersonalConceptCheck[]> {
    const checks = [...(this.store.personalChecksByUser.get(userId)?.values() ?? [])].sort(
      (a, b) =>
        a.conceptId.localeCompare(b.conceptId) || checkTargetOf(a).localeCompare(checkTargetOf(b)),
    );
    return Promise.resolve(structuredClone(checks));
  }

  deleteAllByUser(userId: string): Promise<number> {
    const count = this.store.personalChecksByUser.get(userId)?.size ?? 0;
    this.store.personalChecksByUser.delete(userId);
    this.store.mapCreationCheckKeys.delete(userId);
    return Promise.resolve(count);
  }
}

/** `CheckGenerationConsentRepository` のインメモリ実装。テスト用。 */
export class InMemoryCheckGenerationConsentRepository implements CheckGenerationConsentRepository {
  constructor(
    private readonly store: InMemoryRepositoryStore = createInMemoryRepositoryStore(),
    private readonly kind:
      "checkGenerationConsents" | "mapGenerationConsents" = "checkGenerationConsents",
  ) {}

  get(userId: string): Promise<ConsentRecord | null> {
    const record = this.store[this.kind].get(userId);
    return Promise.resolve(record === undefined ? null : { ...record });
  }

  put(userId: string, record: ConsentRecord): Promise<void> {
    this.store[this.kind].set(userId, { ...record });
    return Promise.resolve();
  }

  delete(userId: string): Promise<void> {
    this.store[this.kind].delete(userId);
    return Promise.resolve();
  }
}

/** 学習マップの AI 生成の同意。形は確認問題の同意と同じで、記録の置き場所だけが違う。 */
export class InMemoryMapGenerationConsentRepository extends InMemoryCheckGenerationConsentRepository {
  constructor(store: InMemoryRepositoryStore = createInMemoryRepositoryStore()) {
    super(store, "mapGenerationConsents");
  }
}

/**
 * `LearningMapRepository` のインメモリ実装。テスト用。
 *
 * 並び（一覧は更新の新しい順・同時刻は ID の昇順、ノードは保存した順）と、
 * 置き換えで残したノードの項目を消さないことを D1 実装と揃えてある。
 * 返す値は複製し、呼び出し側が書き換えてもストアに響かないようにする。
 */
export class InMemoryLearningMapRepository implements LearningMapRepository {
  constructor(private readonly store: InMemoryRepositoryStore = createInMemoryRepositoryStore()) {}

  create(
    ownerUserId: string,
    params: {
      id: string;
      content: StoredMapContent;
      objectives?: readonly StoredLearningObjective[];
      creationChecksLevel?: CheckLevel;
      nowIso: string;
      nowMs: number;
      maxMaps: number;
    },
  ): Promise<{ created: boolean }> {
    if (this.ownedMaps(ownerUserId).length >= params.maxMaps) {
      return Promise.resolve({ created: false });
    }
    // D1 では項目がノードを外部キーで参照し、無いノードを指すと batch ごと失敗する。
    const ownIds = new Set(
      params.content.nodes.filter((node) => node.kind === "own").map((node) => node.conceptId),
    );
    const objectives = new Map<string, StoredLearningObjective[]>();
    for (const objective of params.objectives ?? []) {
      if (!ownIds.has(objective.conceptId)) {
        return Promise.reject(
          new Error(`objective points to a node not in this map: ${objective.conceptId}`),
        );
      }
      objectives.set(objective.conceptId, [
        ...(objectives.get(objective.conceptId) ?? []),
        { ...objective },
      ]);
    }
    this.store.learningMaps.set(params.id, {
      ...structuredClone(params.content),
      id: params.id,
      ownerUserId,
      visibility: "private",
      latestVersion: null,
      revision: 0,
      versions: [],
      createdAt: params.nowIso,
      updatedAt: params.nowIso,
      updatedAtMs: params.nowMs,
      objectives,
      creationChecks:
        params.creationChecksLevel === undefined
          ? null
          : { level: params.creationChecksLevel, attempts: 0, doneAt: null, startedAtMs: null },
    });
    return Promise.resolve({ created: true });
  }

  claimCreationChecks(
    ownerUserId: string,
    mapId: string,
    params: { maxAttempts: number; nowMs: number; leaseMs: number },
  ): Promise<CheckLevel | null> {
    const state = this.owned(ownerUserId, mapId)?.creationChecks;
    if (
      state == null ||
      state.doneAt !== null ||
      state.attempts >= params.maxAttempts ||
      (state.startedAtMs !== null && state.startedAtMs > params.nowMs - params.leaseMs)
    ) {
      return Promise.resolve(null);
    }
    state.attempts += 1;
    state.startedAtMs = params.nowMs;
    return Promise.resolve(state.level);
  }

  releaseCreationChecks(
    ownerUserId: string,
    mapId: string,
    params: { refundAttempt: boolean },
  ): Promise<void> {
    const state = this.owned(ownerUserId, mapId)?.creationChecks;
    if (state != null) {
      state.startedAtMs = null;
      if (params.refundAttempt) state.attempts = Math.max(0, state.attempts - 1);
    }
    return Promise.resolve();
  }

  completeCreationChecks(ownerUserId: string, mapId: string, nowIso: string): Promise<boolean> {
    const state = this.owned(ownerUserId, mapId)?.creationChecks;
    if (state === undefined) return Promise.resolve(false);
    if (state !== null) {
      state.doneAt = nowIso;
      state.startedAtMs = null;
    }
    return Promise.resolve(true);
  }

  listByOwner(ownerUserId: string): Promise<LearningMapSummary[]> {
    return Promise.resolve(
      this.ownedMaps(ownerUserId).map((map) => ({
        id: map.id,
        title: map.title,
        description: map.description,
        visibility: map.visibility,
        latestVersion: map.latestVersion,
        nodeCount: map.nodes.length,
        createdAt: map.createdAt,
        updatedAt: map.updatedAt,
      })),
    );
  }

  get(ownerUserId: string, mapId: string): Promise<StoredLearningMap | null> {
    const map = this.owned(ownerUserId, mapId);
    if (map === undefined) return Promise.resolve(null);
    const copy = structuredClone(map);
    return Promise.resolve({
      id: copy.id,
      title: copy.title,
      description: copy.description,
      visibility: copy.visibility,
      latestVersion: copy.latestVersion,
      revision: copy.revision,
      createdAt: copy.createdAt,
      updatedAt: copy.updatedAt,
      nodes: copy.nodes,
      edges: copy.edges,
      objectives: copy.objectives,
      creationChecks: copy.creationChecks,
    });
  }

  replace(
    ownerUserId: string,
    mapId: string,
    content: StoredMapContent,
    now: { nowIso: string; nowMs: number },
  ): Promise<boolean> {
    const map = this.owned(ownerUserId, mapId);
    if (map === undefined) return Promise.resolve(false);
    const { title, description, nodes, edges } = structuredClone(content);
    // 残したノード（参照ではないもの）の項目は残し、消えたノードの項目は消す（D1 の CASCADE）。
    const kept = new Set(nodes.filter((node) => node.kind === "own").map((node) => node.conceptId));
    for (const conceptId of map.objectives.keys()) {
      if (!kept.has(conceptId)) map.objectives.delete(conceptId);
    }
    // 外したノードの確認問題も消す（#242、2026-10-07 の決定）。
    const removed = new Set(
      map.nodes
        .filter((node) => node.kind === "own" && !kept.has(node.conceptId))
        .map((node) => node.conceptId),
    );
    this.dropChecks(ownerUserId, (check) => removed.has(check.conceptId));
    Object.assign(map, {
      title,
      description,
      nodes,
      edges,
      updatedAt: now.nowIso,
      updatedAtMs: now.nowMs,
      revision: map.revision + 1,
    });
    return Promise.resolve(true);
  }

  publishVersion(
    ownerUserId: string,
    mapId: string,
    params: {
      expectedLatest: number | null;
      expectedRevision: number;
      scope: ShareScope;
      content: string;
      contentHash: string;
      checksIncluded: boolean;
      summary: MapVersionSummary;
      nowIso: string;
      nowMs: number;
    },
  ): Promise<boolean> {
    const map = this.owned(ownerUserId, mapId);
    if (
      map === undefined ||
      map.latestVersion !== params.expectedLatest ||
      map.revision !== params.expectedRevision
    ) {
      return Promise.resolve(false);
    }
    const version = (params.expectedLatest ?? 0) + 1;
    map.versions.push({
      version,
      content: params.content,
      contentHash: params.contentHash,
      authorUserId: ownerUserId,
      restoredFrom: null,
      checksIncluded: params.checksIncluded,
      summary: structuredClone(params.summary),
      createdAt: params.nowIso,
      createdAtMs: params.nowMs,
    });
    map.latestVersion = version;
    map.visibility = params.scope;
    return Promise.resolve(true);
  }

  setShareScope(ownerUserId: string, mapId: string, scope: ShareScope | null): Promise<boolean> {
    const map = this.owned(ownerUserId, mapId);
    if (map === undefined || (scope !== null && map.latestVersion === null)) {
      return Promise.resolve(false);
    }
    map.visibility = scope ?? "private";
    return Promise.resolve(true);
  }

  listVersions(ownerUserId: string, mapId: string): Promise<MapVersionMeta[] | null> {
    const map = this.owned(ownerUserId, mapId);
    if (map === undefined) return Promise.resolve(null);
    return Promise.resolve(
      [...map.versions].reverse().map((version) => toVersionMeta(structuredClone(version))),
    );
  }

  getVersion(
    ownerUserId: string,
    mapId: string,
    version: number,
  ): Promise<StoredMapVersion | null> {
    const found = this.owned(ownerUserId, mapId)?.versions.find(
      (candidate) => candidate.version === version,
    );
    return Promise.resolve(found === undefined ? null : toStoredVersion(found));
  }

  async restoreVersion(
    ownerUserId: string,
    mapId: string,
    params: {
      fromVersion: number;
      expectedLatest: number;
      expectedRevision: number;
      content: StoredMapContent;
      objectives: readonly StoredLearningObjective[];
      summary: MapVersionSummary;
      nowIso: string;
      nowMs: number;
    },
  ): Promise<boolean> {
    const map = this.owned(ownerUserId, mapId);
    const from = map?.versions.find((candidate) => candidate.version === params.fromVersion);
    if (
      map === undefined ||
      from === undefined ||
      map.latestVersion !== params.expectedLatest ||
      map.revision !== params.expectedRevision
    ) {
      return false;
    }
    await this.replace(ownerUserId, mapId, params.content, params);
    // 項目を全部置き換える。外す項目を狙った確認問題は消す（replaceObjectives と同じ）。
    const keptIds = new Set(params.objectives.map((objective) => objective.id));
    const ownIds = new Set(
      params.content.nodes.filter((node) => node.kind === "own").map((node) => node.conceptId),
    );
    this.dropChecks(
      ownerUserId,
      (check) =>
        ownIds.has(check.conceptId) &&
        check.objectiveId !== undefined &&
        !keptIds.has(check.objectiveId),
    );
    map.objectives = new Map();
    for (const objective of params.objectives) {
      map.objectives.set(objective.conceptId, [
        ...(map.objectives.get(objective.conceptId) ?? []),
        { ...objective },
      ]);
    }
    const version = params.expectedLatest + 1;
    map.versions.push({
      ...structuredClone(from),
      version,
      authorUserId: ownerUserId,
      restoredFrom: params.fromVersion,
      summary: structuredClone(params.summary),
      createdAt: params.nowIso,
      createdAtMs: params.nowMs,
    });
    map.latestVersion = version;
    return true;
  }

  getShared(mapId: string): Promise<StoredSharedMap | null> {
    const map = this.store.learningMaps.get(mapId);
    if (map === undefined) return Promise.resolve(null);
    const latest = map.versions.at(-1);
    return Promise.resolve({
      id: map.id,
      ownerUserId: map.ownerUserId,
      visibility: map.visibility,
      latest: latest === undefined ? null : toStoredVersion(latest),
    });
  }

  /** D1 の ORDER BY v.created_at_ms DESC, m.id ASC と一致させる。 */
  listPublic(limit: number): Promise<SharedMapSummary[]> {
    const listed = [...this.store.learningMaps.values()].flatMap((map) => {
      const latest = map.versions.at(-1);
      if (map.visibility !== "public" || latest === undefined) return [];
      const content = JSON.parse(latest.content) as {
        title: string;
        description: string;
        nodes: unknown[];
      };
      return [
        {
          summary: {
            id: map.id,
            title: content.title,
            description: content.description,
            nodeCount: content.nodes.length,
            version: latest.version,
            publishedAt: latest.createdAt,
          },
          at: latest.createdAtMs,
        },
      ];
    });
    listed.sort(
      (a, b) =>
        b.at - a.at || (a.summary.id < b.summary.id ? -1 : a.summary.id > b.summary.id ? 1 : 0),
    );
    return Promise.resolve(listed.slice(0, limit).map((entry) => entry.summary));
  }

  delete(ownerUserId: string, mapId: string): Promise<boolean> {
    const map = this.owned(ownerUserId, mapId);
    if (map === undefined) return Promise.resolve(false);
    // そのマップのノードの確認問題も消す（#242、2026-10-07 の決定）。
    const own = new Set(
      map.nodes.filter((node) => node.kind === "own").map((node) => node.conceptId),
    );
    this.dropChecks(ownerUserId, (check) => own.has(check.conceptId));
    this.store.learningMaps.delete(mapId);
    return Promise.resolve(true);
  }

  replaceObjectives(
    ownerUserId: string,
    params: {
      mapId: string;
      conceptId: string;
      objectives: readonly { id: string; label: string; source: LearningObjectiveSource }[];
      nowIso: string;
      nowMs: number;
    },
  ): Promise<boolean> {
    const map = this.owned(ownerUserId, params.mapId);
    const node = map?.nodes.find((candidate) => candidate.conceptId === params.conceptId);
    if (map === undefined || node?.kind !== "own") return Promise.resolve(false);
    // 外す項目を狙った確認問題を消す（#242、2026-10-07 の決定）。
    const keptIds = new Set(params.objectives.map((objective) => objective.id));
    this.dropChecks(
      ownerUserId,
      (check) =>
        check.conceptId === params.conceptId &&
        check.objectiveId !== undefined &&
        !keptIds.has(check.objectiveId),
    );
    if (params.objectives.length === 0) map.objectives.delete(params.conceptId);
    else
      map.objectives.set(
        params.conceptId,
        params.objectives.map((objective) => ({ ...objective, conceptId: params.conceptId })),
      );
    map.updatedAt = params.nowIso;
    map.updatedAtMs = params.nowMs;
    map.revision += 1;
    return Promise.resolve(true);
  }

  getFixedObjectives(
    conceptId: string,
  ): Promise<{ objectives: StoredLearningObjective[]; revision: string | null }> {
    return Promise.resolve({
      objectives: structuredClone(
        this.store.fixedObjectives.filter((objective) => objective.conceptId === conceptId),
      ),
      revision: this.store.fixedObjectiveRevisions.get(conceptId) ?? null,
    });
  }

  replaceFixedObjectives(params: {
    conceptId: string;
    expectedRevision: string | null;
    revision: string;
    objectives: readonly { id: string; label: string; source: LearningObjectiveSource }[];
    nowIso: string;
  }): Promise<boolean> {
    const { conceptId } = params;
    // 読んだあとに別の置き換えが入っていたら書かない（D1 と同じ）。
    if ((this.store.fixedObjectiveRevisions.get(conceptId) ?? null) !== params.expectedRevision) {
      return Promise.resolve(false);
    }
    this.store.fixedObjectiveRevisions.set(conceptId, params.revision);
    // 外す項目を狙った確認問題を、全利用者の分消す（D1 と同じ）。
    const keptIds = new Set(params.objectives.map((objective) => objective.id));
    for (const userId of this.store.personalChecksByUser.keys()) {
      this.dropChecks(
        userId,
        (check) =>
          check.conceptId === conceptId &&
          check.objectiveId !== undefined &&
          !keptIds.has(check.objectiveId),
      );
    }
    const others = this.store.fixedObjectives.filter(
      (objective) => objective.conceptId !== conceptId,
    );
    this.store.fixedObjectives.splice(
      0,
      this.store.fixedObjectives.length,
      ...others,
      ...params.objectives.map((objective) => ({ ...objective, conceptId })),
    );
    return Promise.resolve(true);
  }

  findOwnNodes(ownerUserId: string, conceptIds: readonly string[]): Promise<StoredOwnMapNode[]> {
    const wanted = new Set(conceptIds);
    return Promise.resolve(
      this.allOwnNodes(ownerUserId).filter((node) => wanted.has(node.conceptId)),
    );
  }

  listOwnNodes(ownerUserId: string, limit: number): Promise<StoredOwnMapNode[]> {
    return Promise.resolve(this.allOwnNodes(ownerUserId).slice(0, limit));
  }

  /** D1 の ORDER BY concept_id, position と一致させる（sort は安定なので Concept の中の並びは保つ）。 */
  listFixedObjectives(): Promise<StoredLearningObjective[]> {
    return Promise.resolve(
      structuredClone(this.store.fixedObjectives).sort((a, b) =>
        a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0,
      ),
    );
  }

  /** D1 の user_concept_checks から、条件に合う行を消す。 */
  private dropChecks(userId: string, matches: (check: PersonalConceptCheck) => boolean): void {
    const checks = this.store.personalChecksByUser.get(userId);
    if (checks === undefined) return;
    for (const [key, check] of checks) {
      if (matches(check)) checks.delete(key);
    }
  }

  private owned(ownerUserId: string, mapId: string): InMemoryLearningMap | undefined {
    const map = this.store.learningMaps.get(mapId);
    return map?.ownerUserId === ownerUserId ? map : undefined;
  }

  /** D1 の ORDER BY updated_at_ms DESC, id ASC と一致させる。 */
  private ownedMaps(ownerUserId: string): InMemoryLearningMap[] {
    return [...this.store.learningMaps.values()]
      .filter((map) => map.ownerUserId === ownerUserId)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private allOwnNodes(ownerUserId: string): StoredOwnMapNode[] {
    return this.ownedMaps(ownerUserId).flatMap((map) =>
      map.nodes.flatMap((node) =>
        node.kind === "own"
          ? [
              {
                conceptId: node.conceptId,
                label: node.label,
                summary: node.summary,
                mapId: map.id,
                mapTitle: map.title,
                prerequisites: map.edges
                  .filter((edge) => edge.to === node.conceptId)
                  .map((edge) => edge.from),
                objectives: structuredClone(map.objectives.get(node.conceptId) ?? []),
              },
            ]
          : [],
      ),
    );
  }
}

function toVersionMeta(version: StoredMapVersion): MapVersionMeta {
  return {
    version: version.version,
    createdAt: version.createdAt,
    authorUserId: version.authorUserId,
    restoredFrom: version.restoredFrom,
    checksIncluded: version.checksIncluded,
    summary: version.summary,
  };
}

function toStoredVersion(version: StoredMapVersion): StoredMapVersion {
  const copy = structuredClone(version);
  return { ...toVersionMeta(copy), content: copy.content, contentHash: copy.contentHash };
}
