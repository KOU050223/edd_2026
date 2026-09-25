import type { HistoryProviderId, LearningEvidence, UnmappedCandidate } from "@gakushu-sochi/domain";

import { describeApiFailure } from "../api-error.js";

/**
 * 履歴インポート系 API のクライアント（Issue #157）。
 *
 * 契約は `apps/api/src/contract/history-import.ts`。あちらは API 側の
 * 正本なのでここで再定義しない。必要な応答の形だけをここに書く。
 *
 * すべての呼び出しで認証トークンを載せるため `redirect: "error"` と
 * タイムアウトを必須にする（RULE-001 / RULE-002）。
 */

export interface HistoryApiDeps {
  /** `${apiBaseUrl}/v1` まで。末尾スラッシュは呼び出し側で除く。 */
  baseUrl: string;
  getAccessToken: () => Promise<string>;
  fetch: typeof fetch;
  /** テスト差し替え用。既定 30 秒。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class HistoryApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HistoryApiError";
    this.status = status;
  }
}

async function request<T>(
  deps: HistoryApiDeps,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const token = await deps.getAccessToken();
  const response = await deps.fetch(`${deps.baseUrl}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    // 2xx で本文が読めないのは失敗（RULE-004）。
    throw new HistoryApiError(
      response.status,
      `API 応答を解析できませんでした (${String(response.status)})。`,
    );
  }
  if (!response.ok) {
    throw new HistoryApiError(response.status, describeApiFailure(response.status, parsed));
  }
  return parsed as T;
}

export interface ImportSessionView {
  id: string;
  status: string;
  importedBy: string;
  providers: HistoryProviderId[];
  conversationCount: number;
  ignoredCount: number;
  evidenceCount: number;
  conceptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateImportSessionBody {
  id: string;
  importedBy: "desktop" | "agent" | "file" | "connector";
  providers: HistoryProviderId[];
  conversationCount: number;
  ignoredCount?: number;
  unmappedCandidates?: UnmappedCandidate[];
  evidence: LearningEvidence[];
}

export interface CreateImportSessionResult extends ImportSessionView {
  alreadyExisted: boolean;
}

export function createImportSession(
  deps: HistoryApiDeps,
  body: CreateImportSessionBody,
): Promise<CreateImportSessionResult> {
  return request(deps, "/import-sessions", { method: "POST", body });
}

export function listImportSessions(
  deps: HistoryApiDeps,
): Promise<{ sessions: ImportSessionView[] }> {
  return request(deps, "/import-sessions", { method: "GET" });
}

export function undoImportSession(
  deps: HistoryApiDeps,
  id: string,
): Promise<{ id: string; status: "undone"; deletedEvidenceCount: number }> {
  return request(deps, `/import-sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function deleteEvidenceByProvider(
  deps: HistoryApiDeps,
  provider: HistoryProviderId,
): Promise<{ deletedCount: number; sessionsMarkedUndone: number }> {
  return request(deps, `/learning-evidence?provider=${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
}
