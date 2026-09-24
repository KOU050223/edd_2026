import { expect, test, vi } from "vitest";
import { CONSENT_NOTICE_VERSION } from "@gakushu-sochi/domain";
import { ApiError } from "./api.js";
import { fetchConsentStatus, grantConsent, isConsentStatus, revokeConsent } from "./consent.js";

test("同意の状態を Worker から読める", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ granted: true, grantedAt: "2026-09-25T00:00:00Z" })),
  );

  const status = await fetchConsentStatus(fetcher);

  expect(status).toEqual({ granted: true, grantedAt: "2026-09-25T00:00:00Z" });
});

test("同意の状態が読めない形なら失敗として扱う", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true })));

  await expect(fetchConsentStatus(fetcher)).rejects.toMatchObject({ kind: "unavailable" });
});

test("同意するとき、画面が提示した文面の版を送る", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ granted: true })));

  await grantConsent(fetcher);

  const init = fetcher.mock.calls[0]?.[1];
  expect(fetcher.mock.calls[0]?.[0]).toBe("/consent");
  expect(init?.method).toBe("PUT");
  expect(JSON.parse(String(init?.body))).toEqual({ version: CONSENT_NOTICE_VERSION });
  // 単発リクエストなので締め切りがある（RULE-001）。
  expect(init?.signal).toBeTruthy();
});

test("文面の版が Worker とずれたら、再読み込みを促せる失敗として返す", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ error: "consent_notice_outdated" }), { status: 409 }),
  );

  await expect(grantConsent(fetcher)).rejects.toMatchObject({ kind: "consent_outdated" });
});

test("同意の取り消しは DELETE で送る", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ granted: false })));

  const status = await revokeConsent(fetcher);

  expect(fetcher.mock.calls[0]?.[1]?.method).toBe("DELETE");
  expect(status.granted).toBe(false);
});

test("セッション切れは同意の操作でも session_expired として判別できる", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ error: "session_expired" }), { status: 401 }),
  );

  await expect(grantConsent(fetcher)).rejects.toBeInstanceOf(ApiError);
  await expect(grantConsent(fetcher)).rejects.toMatchObject({ kind: "session_expired" });
});

test("isConsentStatus は形の違う応答を受理しない", () => {
  expect(isConsentStatus({ granted: true })).toBe(true);
  expect(isConsentStatus({ granted: false, grantedAt: "2026-09-25T00:00:00Z" })).toBe(true);
  expect(isConsentStatus({ granted: "yes" })).toBe(false);
  expect(isConsentStatus({})).toBe(false);
  expect(isConsentStatus(null)).toBe(false);
});
