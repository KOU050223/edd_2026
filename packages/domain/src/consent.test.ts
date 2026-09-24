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

test("AI の送信先が Copilot だけではないことを文面で示す", () => {
  // #121 で Copilot 以外の vendor（BYOK）へも送るようになった。
  // 文面が Copilot しか名指ししていないと、利用者は同意していない相手へ
  // コードが出ていることに気付けない。
  expect(CONSENT_NOTICE_DETAIL).toContain("API キー");
  expect(CONSENT_NOTICE_DETAIL).toContain("Anthropic");
  expect(CONSENT_NOTICE_DETAIL).toContain("ローカル");
});

test("クライアントごとの送信経路の違いを文面で示す", () => {
  // #174 で Desktop / Web にも同じ文面を提示するようになった。
  // Desktop の送信先は VS Code の設定した AI ではなく Managed AI（サーバー経由の
  // Gemini）なので、VS Code 前提の書き方だと同意が事実とずれる。
  // Web からは本文を送らないことも、送る側の境界として明記する。
  expect(CONSENT_NOTICE_DETAIL).toContain("VS Code に設定した AI");
  expect(CONSENT_NOTICE_DETAIL).toContain("Managed AI");
  expect(CONSENT_NOTICE_DETAIL).toContain("Gemini");
  expect(CONSENT_NOTICE_DETAIL).toContain("サーバーを経由して");
  expect(CONSENT_NOTICE_DETAIL).toContain("Web 版からはコードや質問文を AI へ送りません");
});

test("送信先ごとに、送るものと保存されるものを文面で示す", () => {
  expect(CONSENT_NOTICE_DETAIL).toContain("選択したコード・テキスト本文");
  expect(CONSENT_NOTICE_DETAIL).toContain("参照した他ファイルの");
  expect(CONSENT_NOTICE_DETAIL).toContain("ファイルパス・シンボル名");
  expect(CONSENT_NOTICE_DETAIL).toContain("学習記録として保存することはありません");
  expect(CONSENT_NOTICE_DETAIL).toContain("取り消");
});
