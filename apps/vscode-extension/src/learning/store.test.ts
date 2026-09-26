import { expect, test, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { createEmptyProfile, type LearnerProfile, type LearningEvent } from "@gakushu-sochi/domain";
import {
  clearLocalLearningData,
  getAppliedHistoryResetAtMs,
  getOrCreateClientId,
  loadExplainedErrors,
  loadProfile,
  markHistoryResetApplied,
  recordEvent,
  saveExplainedErrors,
} from "./store";
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

// --- recordEvent（MVP/02 #23 の完了条件） -----------------------------------

function eventWith(conceptId: string): LearningEvent {
  return {
    id: "event-1",
    occurredAt: "2026-09-21T00:00:00.000Z",
    type: "answer_viewed",
    origin: "vscode",
    conceptIds: [conceptId],
    language: "go",
  };
}

test("記録したイベントは読み直しても残る", async () => {
  // 「Extension を再起動しても記録が残る」の確認。プロセスの再起動そのものは
  // 再現できないため、保存した globalState を loadProfile で読み直して代える。
  const context = mutableContext();

  const updated = await recordEvent(context, loadProfile(context), eventWith("go.defer"));

  expect(updated.events).toHaveLength(1);
  // 同じ globalState を読み直す = 次回起動時に loadProfile が見る値。
  expect(loadProfile(context).events).toEqual(updated.events);
});

test("保存に失敗しても例外を外へ出さず、更新後のプロファイルを返す", async () => {
  // 「保存失敗時も質問フローを止めない」の確認。update が reject しても
  // 呼び出し側（extension.ts の persistEvent）へ例外を伝播させない。
  const failure = new Error("globalState への書き込みに失敗しました");
  const context = {
    globalState: {
      get: () => undefined,
      update: async () => {
        throw failure;
      },
    },
  } as unknown as vscode.ExtensionContext;
  const onError = vi.fn();

  const updated = await recordEvent(
    context,
    createEmptyProfile("2026-09-21T00:00:00.000Z"),
    eventWith("go.slice"),
    onError,
  );

  // 失敗を握りつぶさず onError へ通知したうえで、今セッション分は反映された値を返す。
  expect(onError).toHaveBeenCalledWith(failure);
  expect(updated.events).toHaveLength(1);
});

// --- 解説済みエラー（診断/02 #76） ----------------------------------------------

const EXPLAINED_ERRORS_KEY = "gakushuSochi.explainedErrors";

test("保存した解説済みエラーを読み直せる", async () => {
  const context = mutableContext();
  const explained = {
    "code:ts:2345": {
      explainedAt: "2026-09-21T00:00:00.000Z",
      conceptIds: ["ts.type_annotation"],
    },
  };

  await saveExplainedErrors(context, explained);

  expect(loadExplainedErrors(context)).toEqual(explained);
});

test("解説済みエラーが無ければ空を返し、失敗として通知しない", () => {
  const onError = vi.fn();

  expect(loadExplainedErrors(contextWith({}), onError)).toEqual({});
  expect(onError).not.toHaveBeenCalled();
});

test("解説済みエラーが壊れていれば空から始め、黙って捨てずに通知する", () => {
  const onError = vi.fn();

  const loaded = loadExplainedErrors(
    contextWith({ [EXPLAINED_ERRORS_KEY]: { "code:ts:2345": { explainedAt: "broken" } } }),
    onError,
  );

  expect(loaded).toEqual({});
  expect(onError).toHaveBeenCalledWith(expect.any(TypeError));
});

test("解説済みエラーの保存に失敗しても例外を外へ出さず通知する", async () => {
  const failure = new Error("globalState への書き込みに失敗しました");
  const context = {
    globalState: {
      get: () => undefined,
      update: async () => {
        throw failure;
      },
    },
  } as unknown as vscode.ExtensionContext;
  const onError = vi.fn();

  await saveExplainedErrors(context, {}, onError);

  expect(onError).toHaveBeenCalledWith(failure);
});

// --- #124: ローカルの学習データコピーの削除 -------------------------------------

const CONSENT_KEY = "gakushuSochi.consent";
const APPLIED_RESET_KEY = "gakushuSochi.appliedHistoryResetAtMs";

test("学習データのコピーは全キー消え、学習データでないキーは残る", async () => {
  const context = mutableContext({
    [CURRENT_KEY]: profileWith("go.defer"),
    [LEGACY_KEY]: profileWith("go.slice"),
    [EXPLAINED_ERRORS_KEY]: { "code:ts:2345": { explainedAt: "x", conceptIds: [] } },
    // 学習データではないもの。clientId は端末の識別子、同意は設定の記録、
    // appliedHistoryResetAtMs は同期状態。これらは削除の対象外（Issue #124）。
    [CLIENT_ID_KEY]: "client-1",
    [CONSENT_KEY]: { version: 3, grantedAt: "2026-09-21T00:00:00.000Z" },
    [APPLIED_RESET_KEY]: 1_000,
  });

  await clearLocalLearningData(context);

  expect(context.globalState.get(CURRENT_KEY)).toBeUndefined();
  expect(context.globalState.get(LEGACY_KEY)).toBeUndefined();
  expect(context.globalState.get(EXPLAINED_ERRORS_KEY)).toBeUndefined();
  expect(context.globalState.get(CLIENT_ID_KEY)).toBe("client-1");
  expect(context.globalState.get(CONSENT_KEY)).toBeDefined();
  expect(context.globalState.get(APPLIED_RESET_KEY)).toBe(1_000);
});

test("一部のキーの削除に失敗しても残りは消し、失敗を投げる", async () => {
  // 「消せた」と伝えるのは全部消えたときだけ。失敗を握りつぶすと、
  // 消えたつもりのコピーが残る（RULE-004）。
  const store: Record<string, unknown> = {
    [CURRENT_KEY]: profileWith("go.defer"),
    [EXPLAINED_ERRORS_KEY]: {},
  };
  const context = {
    globalState: {
      get: (key: string) => store[key],
      update: async (key: string, value: unknown) => {
        if (key === CURRENT_KEY) throw new Error("write failed");
        store[key] = value;
      },
    },
  } as unknown as vscode.ExtensionContext;

  await expect(clearLocalLearningData(context)).rejects.toThrow("学習データの削除に失敗");

  expect(store[EXPLAINED_ERRORS_KEY]).toBeUndefined();
});

test("適用済みの削除時刻は無ければ0、壊れていても0を返す", () => {
  // 0 に丸めると「実際より古い」と判定される方向にだけ倒れる。
  // 起きうるのは既に空のコピーをもう一度消す冗長な追従だけである。
  expect(getAppliedHistoryResetAtMs(contextWith({}))).toBe(0);
  expect(getAppliedHistoryResetAtMs(contextWith({ [APPLIED_RESET_KEY]: "broken" }))).toBe(0);
});

test("適用済みの削除時刻は記録でき、古い値で巻き戻らない", async () => {
  // 遅れて届いた古い削除応答で境界を後退させない。
  const context = mutableContext({ [APPLIED_RESET_KEY]: 2_000 });

  await markHistoryResetApplied(context, 1_500);
  expect(getAppliedHistoryResetAtMs(context)).toBe(2_000);

  await markHistoryResetApplied(context, 3_000);
  expect(getAppliedHistoryResetAtMs(context)).toBe(3_000);
});
