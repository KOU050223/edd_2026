import type { HistoryProviderId, LearningEvidence, UnmappedCandidate } from "@gakushu-sochi/domain";

import { authedApiRequest, type AuthedApiDeps } from "../api-request.js";

/**
 * 履歴インポート系 API のクライアント（Issue #157）。
 *
 * 契約は `apps/api/src/contract/history-import.ts`。あちらは API 側の
 * 正本なのでここで再定義しない。必要な応答の形だけをここに書く。
 *
 * すべての呼び出しで認証トークンを載せるため `redirect: "error"` と
 * タイムアウトを必須にする（RULE-001 / RULE-002、api-request.ts）。
 * 失敗は `ApiRequestError` で返る。
 */

export type HistoryApiDeps = AuthedApiDeps;

const request = authedApiRequest;

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
