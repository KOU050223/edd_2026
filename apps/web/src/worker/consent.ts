/**
 * 送信同意の記録（#174）。
 *
 * Web の同意は `consent:{sub}` として Workers KV に、**ユーザー単位で**置く。
 * セッションに紐づけるとログイン（最長 7 日）のたびに取り直すことになり、
 * 「この製品が何を外へ出すか」への一度きりの合意という他クライアントの扱いと
 * ずれるため、セッションとは別のキーにする。
 *
 * Cookie や localStorage には置かない。ブラウザ側から値を書き換えられる場所に
 * 同意を置くと改ざんできるため（RULE-006）。書き込みは `/consent` 経路だけが担い、
 * 記録はサーバー側の KV にしか存在しない。
 *
 * 文面と版は `@gakushu-sochi/domain` の consent.ts が正本で、
 * VS Code 拡張・Desktop と同じ内容を提示する。
 */

import { createConsentRecord, isConsentGranted, type ConsentRecord } from "@gakushu-sochi/domain";

const CONSENT_PREFIX = "consent:";

/**
 * 同意の記録を読む。
 *
 * 値が壊れている・版が古い場合は `undefined` を返す。これは握りつぶしではなく
 * 「同意していない」という判定そのものである（`isConsentGranted` の仕様）。
 * JSON として読めない場合だけは記録を残す。
 */
export async function readConsent(
  sessions: KVNamespace,
  sub: string,
): Promise<ConsentRecord | undefined> {
  const raw = await sessions.get(`${CONSENT_PREFIX}${sub}`);
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    console.error("consent record is not valid JSON", { sub });
    return undefined;
  }
  return isConsentGranted(value) ? value : undefined;
}

export async function writeConsent(
  sessions: KVNamespace,
  sub: string,
  grantedAt: string,
): Promise<ConsentRecord> {
  const record = createConsentRecord(grantedAt);
  // TTL は付けない。切れると同意が消えて書き込みが止まる。セッションより
  // 長く生きる記録なので、セッションの TTL に引きずられないようにする。
  await sessions.put(`${CONSENT_PREFIX}${sub}`, JSON.stringify(record));
  return record;
}

export async function deleteConsent(sessions: KVNamespace, sub: string): Promise<void> {
  await sessions.delete(`${CONSENT_PREFIX}${sub}`);
}
