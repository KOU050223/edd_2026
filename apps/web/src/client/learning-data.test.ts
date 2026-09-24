import { expect, test } from "vitest";
import { ApiError } from "./api.js";
import {
  deleteLearningData,
  exportFileName,
  fetchLearningDataExport,
  isLearnerProfileShape,
} from "./learning-data.js";

const validProfile = {
  version: 1,
  updatedAt: "2026-09-25T00:00:00.000Z",
  mastery: {},
  events: [],
};

test("エクスポート応答が LearnerProfile の形なら受け入れる", () => {
  expect(isLearnerProfileShape(validProfile)).toBe(true);
});

test("将来のバージョンのエクスポートも受け入れる", () => {
  expect(isLearnerProfileShape({ ...validProfile, version: 2 })).toBe(true);
});

test.each([
  ["null", null],
  ["配列", []],
  ["version が文字列", { ...validProfile, version: "1" }],
  ["events が無い", { version: 1, updatedAt: "2026-09-25T00:00:00.000Z", mastery: {} }],
  ["mastery が無い", { version: 1, updatedAt: "2026-09-25T00:00:00.000Z", events: [] }],
  ["mastery が null", { ...validProfile, mastery: null }],
])("エクスポート応答が %s なら拒否する", (_, value) => {
  expect(isLearnerProfileShape(value)).toBe(false);
});

test("エクスポートは契約どおりの応答をそのまま返す", async () => {
  await expect(
    fetchLearningDataExport(async () => Response.json(validProfile), 0),
  ).resolves.toEqual(validProfile);
});

test("エクスポートで 2xx でも形が違えば失敗として扱う", async () => {
  await expect(fetchLearningDataExport(async () => Response.json({ ok: true }), 0)).rejects.toEqual(
    new ApiError("unavailable"),
  );
});

test("エクスポートの 401 理由を利用者が取れるエラー種別へ写像する", async () => {
  await expect(
    fetchLearningDataExport(
      async () => Response.json({ error: "session_expired" }, { status: 401 }),
      0,
    ),
  ).rejects.toEqual(new ApiError("session_expired"));
});

test("削除は DELETE メソッドで学習イベントの API を呼ぶ", async () => {
  let requested: unknown;
  let method: unknown;
  await deleteLearningData(async (input, init) => {
    requested = input;
    method = init?.method;
    return Response.json({ deletedCount: 3, resetAtMs: 1000 });
  });

  expect(requested).toBe("/api/v1/learning-events");
  expect(method).toBe("DELETE");
});

test("削除は消えた件数と削除時刻を返す", async () => {
  await expect(
    deleteLearningData(async () => Response.json({ deletedCount: 3, resetAtMs: 1000 })),
  ).resolves.toEqual({ deletedCount: 3, resetAtMs: 1000 });
});

test("削除で 2xx でも応答の形が違えば失敗として扱う", async () => {
  await expect(deleteLearningData(async () => Response.json({ deleted: true }))).rejects.toEqual(
    new ApiError("unavailable"),
  );
});

test("削除が 401 で拒まれた理由を利用者が取れるエラー種別へ写像する", async () => {
  await expect(
    deleteLearningData(async () => Response.json({ error: "session_expired" }, { status: 401 })),
  ).rejects.toEqual(new ApiError("session_expired"));
});

test("削除の応答が返らないまま待ち続けないよう締め切りを設ける", async () => {
  let signal: AbortSignal | undefined;
  await deleteLearningData(async (_input, init) => {
    signal = init?.signal as AbortSignal;
    return Response.json({ deletedCount: 0, resetAtMs: 1000 });
  });

  expect(signal).toBeInstanceOf(AbortSignal);
});

test("ダウンロードのファイル名は日付を含む", () => {
  expect(exportFileName(new Date("2026-09-25T12:34:56.000Z"))).toBe(
    "gakushu-sochi-learning-data-2026-09-25.json",
  );
});
