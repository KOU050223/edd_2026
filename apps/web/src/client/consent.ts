/**
 * 送信同意の記録の読み書き（#174）。
 *
 * 記録の正本は Worker が KV に持つ（`worker/consent.ts`）。ここはその窓口で、
 * 文面の版はクライアントが同梱する `@gakushu-sochi/domain` のものを送る。
 * Worker の版とずれたときは `consent_outdated` が返る —— 見せた文面と違う版の
 * 同意を記録しないための仕掛けである。
 */

import { CONSENT_NOTICE_VERSION } from "@gakushu-sochi/domain";
import { ApiError, requestJson } from "./api.js";

const CONSENT_PATH = "/consent";
/** 単発リクエストなので締め切りを設ける（.agents/rules/rules.md RULE-001）。 */
const CONSENT_TIMEOUT_MS = 10_000;

export interface ConsentStatus {
  granted: boolean;
  grantedAt?: string;
}

/** 2xx でも形が違えば失敗として扱う（RULE-004）。 */
export function isConsentStatus(value: unknown): value is ConsentStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { granted?: unknown; grantedAt?: unknown };
  return (
    typeof candidate.granted === "boolean" &&
    (candidate.grantedAt === undefined || typeof candidate.grantedAt === "string")
  );
}

export async function fetchConsentStatus(
  fetcher: typeof fetch = fetch,
  sessionRetries: boolean | number = false,
): Promise<ConsentStatus> {
  const value = await requestJson<unknown>(CONSENT_PATH, fetcher, sessionRetries);
  if (!isConsentStatus(value)) throw new ApiError("unavailable");
  return value;
}

async function writeConsent(
  method: "PUT" | "DELETE",
  payload: unknown,
  fetcher: typeof fetch,
): Promise<ConsentStatus> {
  let response: Response;
  try {
    response = await fetcher(CONSENT_PATH, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(CONSENT_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError("unavailable");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (body.error === "session_expired") throw new ApiError("session_expired");
    if (body.error === "consent_notice_outdated") throw new ApiError("consent_outdated");
    throw new ApiError("unavailable");
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (!isConsentStatus(value)) throw new ApiError("unavailable");
  return value;
}

/** 利用者が見ている文面の版を送り、Worker と一致したときだけ記録される。 */
export function grantConsent(fetcher: typeof fetch = fetch): Promise<ConsentStatus> {
  return writeConsent("PUT", { version: CONSENT_NOTICE_VERSION }, fetcher);
}

export function revokeConsent(fetcher: typeof fetch = fetch): Promise<ConsentStatus> {
  return writeConsent("DELETE", {}, fetcher);
}
