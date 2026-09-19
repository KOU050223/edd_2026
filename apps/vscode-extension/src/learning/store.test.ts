import { expect, test, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { createEmptyProfile, type LearnerProfile } from "@gakushu-sochi/domain";
import { getOrCreateClientId, loadProfile } from "./store";
import type * as vscode from "vscode";

const CURRENT_KEY = "gakushuSochi.learnerProfile";
const LEGACY_KEY = "codeCompanion.learnerProfile";
const CLIENT_ID_KEY = "gakushuSochi.clientId";

/** globalState だけを持つ最小の ExtensionContext を組む。 */
function contextWith(values: Record<string, unknown>): vscode.ExtensionContext {
  return {
    globalState: {
      get: (key: string) => values[key],
    },
  } as unknown as vscode.ExtensionContext;
}

function profileWith(conceptId: string): LearnerProfile {
  const profile = createEmptyProfile("2026-09-05T00:00:00.000Z");
  profile.mastery[conceptId] = {
    conceptId,
    status: "learning",
    score: 0.25,
    evidence: {
      questionCount: 0,
      hintCount: 0,
      answerViewCount: 0,
      solvedIndependentlyCount: 1,
      errorRecurrenceCount: 0,
      checkPassedCount: 0,
      checkFailedCount: 0,
      recentTypes: ["solved_independently"],
    },
  };
  return profile;
}

test("新しいキーの値を読む", () => {
  const stored = profileWith("go.defer");

  const loaded = loadProfile(contextWith({ [CURRENT_KEY]: stored }));

  expect(loaded.mastery["go.defer"]?.score).toBe(0.25);
});

test("新しいキーが空なら旧キーの学習履歴を引き継ぐ", () => {
  // 学習履歴は再取得できない。キーを変えただけで読めなくなる状態にしない
  // （docs/concepts.md「古いデータを黙って捨てない」）。
  const stored = profileWith("go.slice");

  const loaded = loadProfile(contextWith({ [LEGACY_KEY]: stored }));

  expect(loaded.mastery["go.slice"]?.score).toBe(0.25);
});

test("両方にあれば新しいキーを優先する", () => {
  const loaded = loadProfile(
    contextWith({
      [CURRENT_KEY]: profileWith("go.new"),
      [LEGACY_KEY]: profileWith("go.old"),
    }),
  );

  expect(loaded.mastery["go.new"]).toBeDefined();
  expect(loaded.mastery["go.old"]).toBeUndefined();
});

test("どちらも無ければ空のプロファイルを返す", () => {
  const loaded = loadProfile(contextWith({}));

  expect(loaded.mastery).toEqual({});
  expect(loaded.events).toEqual([]);
});

test("新しいキーが壊れていても旧キーから復帰する", () => {
  const loaded = loadProfile(
    contextWith({
      [CURRENT_KEY]: { version: 999 },
      [LEGACY_KEY]: profileWith("go.defer"),
    }),
  );

  expect(loaded.mastery["go.defer"]).toBeDefined();
});

test("旧キーも壊れていれば空のプロファイルを返す", () => {
  const loaded = loadProfile(contextWith({ [LEGACY_KEY]: { version: 999 } }));

  expect(loaded.mastery).toEqual({});
});

test("読み込みでは globalState を書き換えない", () => {
  // 起動直後に副作用を走らせると、失敗したときに握りつぶすか起動を止めるかの
  // 二択になる。移行は次の保存で自然に完了する。
  const update = vi.fn();
  const context = {
    globalState: {
      get: (key: string) => (key === LEGACY_KEY ? profileWith("go.defer") : undefined),
      update,
    },
  } as unknown as vscode.ExtensionContext;

  loadProfile(context);

  expect(update).not.toHaveBeenCalled();
});

/** version は現在値だが、applyEvent が必要とする形を満たさない保存値。 */
const VERSION_CURRENT_BUT_BROKEN = {
  version: 1,
  updatedAt: "2026-09-05T00:00:00.000Z",
  mastery: {},
  // events が無い
};

test("versionが現在値でもeventsが無ければ使わない", () => {
  // applyEvent は profile.events を展開するため、そのまま返すと
  // イベント記録時に TypeError で落ちる。読み込み時点で弾く。
  const loaded = loadProfile(contextWith({ [CURRENT_KEY]: VERSION_CURRENT_BUT_BROKEN }));

  expect(loaded.events).toEqual([]);
  expect(loaded.updatedAt).not.toBe("2026-09-05T00:00:00.000Z");
});

test("旧キーがversion現在値でも壊れていれば使わない", () => {
  const loaded = loadProfile(contextWith({ [LEGACY_KEY]: VERSION_CURRENT_BUT_BROKEN }));

  expect(loaded.events).toEqual([]);
  expect(loaded.mastery).toEqual({});
});

test("eventsが配列でなければ使わない", () => {
  const loaded = loadProfile(
    contextWith({
      [CURRENT_KEY]: { ...VERSION_CURRENT_BUT_BROKEN, events: "not-an-array" },
    }),
  );

  expect(loaded.events).toEqual([]);
});

test("masteryが欠けていれば使わない", () => {
  const loaded = loadProfile(
    contextWith({
      [CURRENT_KEY]: { version: 1, updatedAt: "2026-09-05T00:00:00.000Z", events: [] },
    }),
  );

  expect(loaded.mastery).toEqual({});
  expect(loaded.updatedAt).not.toBe("2026-09-05T00:00:00.000Z");
});

test("新しいキーが壊れていて旧キーが正常なら旧キーを使う", () => {
  const loaded = loadProfile(
    contextWith({
      [CURRENT_KEY]: VERSION_CURRENT_BUT_BROKEN,
      [LEGACY_KEY]: profileWith("go.defer"),
    }),
  );

  expect(loaded.mastery["go.defer"]).toBeDefined();
});

/** get/update の両方を持つ、書き込み可能な globalState を組む。 */
function mutableContext(initial: Record<string, unknown> = {}): vscode.ExtensionContext {
  const store: Record<string, unknown> = { ...initial };
  return {
    globalState: {
      get: (key: string) => store[key],
      update: async (key: string, value: unknown) => {
        store[key] = value;
      },
    },
  } as unknown as vscode.ExtensionContext;
}

test("clientIdが無ければ新しく作って保存する", async () => {
  const context = mutableContext();

  const clientId = await getOrCreateClientId(context);

  expect(clientId.length).toBeGreaterThan(0);
  expect(context.globalState.get(CLIENT_ID_KEY)).toBe(clientId);
});

test("既にあるclientIdを使い続ける", async () => {
  const context = mutableContext({ [CLIENT_ID_KEY]: "existing-client-id" });

  const clientId = await getOrCreateClientId(context);

  expect(clientId).toBe("existing-client-id");
});

test("2回呼んでも同じclientIdを返す", async () => {
  const context = mutableContext();

  const first = await getOrCreateClientId(context);
  const second = await getOrCreateClientId(context);

  expect(second).toBe(first);
});
