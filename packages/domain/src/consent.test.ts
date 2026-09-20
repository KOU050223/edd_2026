import { expect, test } from "vitest";
import {
  CONSENT_NOTICE_DETAIL,
  CONSENT_NOTICE_VERSION,
  createConsentRecord,
  isConsentGranted,
} from "./consent.js";

test("現在の版への同意だけを有効な記録として扱う", () => {
  expect(isConsentGranted(createConsentRecord("2026-09-21T00:00:00.000Z"))).toBe(true);
});

test("記録が無ければ同意していないものとして扱う", () => {
  expect(isConsentGranted(undefined)).toBe(false);
  expect(isConsentGranted(null)).toBe(false);
});

test("文面の版が古い同意では送信を許さない", () => {
  expect(
    isConsentGranted({
      version: CONSENT_NOTICE_VERSION - 1,
      grantedAt: "2026-09-21T00:00:00.000Z",
    }),
  ).toBe(false);
});

test("壊れた記録を同意として読み替えない", () => {
  expect(isConsentGranted({ version: CONSENT_NOTICE_VERSION })).toBe(false);
  expect(isConsentGranted({ version: CONSENT_NOTICE_VERSION, grantedAt: "" })).toBe(false);
  expect(isConsentGranted({ version: "1", grantedAt: "2026-09-21T00:00:00.000Z" })).toBe(false);
  expect(isConsentGranted("granted")).toBe(false);
  expect(isConsentGranted(true)).toBe(false);
});

test("送信先ごとに、送るものと保存されるものを文面で示す", () => {
  expect(CONSENT_NOTICE_DETAIL).toContain("選択したコード本文");
  expect(CONSENT_NOTICE_DETAIL).toContain("参照した他ファイルの定義コード");
  expect(CONSENT_NOTICE_DETAIL).toContain("ファイルパス・シンボル名");
  expect(CONSENT_NOTICE_DETAIL).toContain("コード本文・質問文・AIの回答は送りません");
  expect(CONSENT_NOTICE_DETAIL).toContain("取り消");
});
