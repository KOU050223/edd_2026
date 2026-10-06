import type { PersonalConceptCheck } from "@gakushu-sochi/domain";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "./api.js";
import {
  allObjectivesUnderstood,
  CHECKS_GENERATE_PATH,
  CheckConsentRequiredError,
  CheckGenerationError,
  changeGenerationConsent,
  checkErrorText,
  checkSetKey,
  checkTally,
  defaultObjectiveSelection,
  fetchSavedChecks,
  generateCheck,
  generationTargets,
  gradeCheck,
  isPersonalConceptCheck,
  nextCheckIndex,
  orderedChecks,
  recommendedLevel,
  upsertCheck,
} from "./check.js";

const CHECK: PersonalConceptCheck = {
  conceptId: "go.defer",
  overview: {
    prompt: "defer の説明として正しいものは？",
    choices: [
      "関数を抜けるときに実行する",
      "すぐに実行する",
      "別の goroutine で実行する",
      "実行しない",
    ],
    answerIndex: 0,
    explanation: "defer は囲んでいる関数から戻るときに実行される。",
  },
  practice: {
    prompt: "出力は？",
    code: 'defer fmt.Println("a")\nfmt.Println("b")',
    choices: ["a b", "b a", "a", "b"],
    answerIndex: 1,
    explanation: "defer した呼び出しは関数の終わりに回る。",
  },
  scope: "objective",
  objectiveId: "go.defer:execution_timing",
  level: "basic",
  model: "gemini",
  generatedAt: "2026-10-04T00:00:00.000Z",
};

const REQUEST = {
  conceptId: "go.defer",
  scope: "objective",
  level: "basic",
  objectiveId: "go.defer:execution_timing",
  consentVersion: 1,
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

test("2問とも答えたときだけ採点する", () => {
  expect(gradeCheck(CHECK, {})).toBeNull();
  expect(gradeCheck(CHECK, { overview: 0 })).toBeNull();
  expect(gradeCheck(CHECK, { practice: 1 })).toBeNull();
  expect(gradeCheck(CHECK, { overview: 0, practice: 1 })).toEqual({
    overview: true,
    practice: true,
  });
  expect(gradeCheck(CHECK, { overview: 2, practice: 1 })).toEqual({
    overview: false,
    practice: true,
  });
});

test("利用者ごとの2問1組だけを問題として受け入れる", () => {
  expect(isPersonalConceptCheck(CHECK, "go.defer")).toBe(true);
  expect(isPersonalConceptCheck(CHECK, "go.goroutine")).toBe(false);
  expect(
    isPersonalConceptCheck(
      { ...CHECK, practice: { ...CHECK.practice, code: undefined } },
      "go.defer",
    ),
  ).toBe(false);
  expect(
    isPersonalConceptCheck(
      { ...CHECK, overview: { ...CHECK.overview, answerIndex: 4 } },
      "go.defer",
    ),
  ).toBe(false);
  expect(isPersonalConceptCheck({ ...CHECK, level: "expert" }, "go.defer")).toBe(false);
  // 項目を狙う組は項目 ID を、それ以外は持たない。
  expect(isPersonalConceptCheck({ ...CHECK, objectiveId: undefined }, "go.defer")).toBe(false);
  expect(isPersonalConceptCheck({ ...CHECK, scope: "concept" }, "go.defer")).toBe(false);
  expect(isPersonalConceptCheck({ ...CHECK, scope: "summary" }, "go.defer")).toBe(false);
});

test("保存済みの組を読み、形が違えば失敗にする", async () => {
  const ok = vi.fn(async () => Response.json({ checks: [CHECK] }));
  await expect(fetchSavedChecks("go.defer", ok)).resolves.toEqual([CHECK]);
  expect(ok).toHaveBeenCalledWith("/api/v1/checks?conceptId=go.defer", expect.anything());

  vi.spyOn(console, "error").mockImplementation(() => {});
  const broken = vi.fn(async () => Response.json({ checks: [{ ...CHECK, scope: "all" }] }));
  await expect(fetchSavedChecks("go.defer", broken)).rejects.toEqual(new ApiError("unavailable"));
});

test("生成は選んだ範囲・レベル・項目・同意の版を送り、締め切りを付ける", async () => {
  let sent: { url: unknown; init?: RequestInit } | undefined;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    sent = { url, init };
    return Response.json(CHECK);
  });

  await expect(generateCheck(REQUEST, fetcher)).resolves.toEqual(CHECK);
  expect(sent?.url).toBe(CHECKS_GENERATE_PATH);
  expect(sent?.init?.method).toBe("POST");
  expect(JSON.parse(String(sent?.init?.body))).toEqual(REQUEST);
  // 締め切りを付ける（RULE-001）。
  expect(sent?.init?.signal).toBeInstanceOf(AbortSignal);
});

test("生成の失敗と回数の上限は API が返した文面で伝える", async () => {
  const message = "今日の AI 利用上限（15 回）に達したため、問題を作れません。";
  const fetcher = vi.fn(async () =>
    Response.json({ error: "ai usage limit reached", message }, { status: 429 }),
  );

  const error = await generateCheck(REQUEST, fetcher).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(CheckGenerationError);
  expect(checkErrorText(error)).toBe(message);
});

test("生成への同意が無いと API が止めたら、同意の取り直しとして伝える", async () => {
  const fetcher = vi.fn(async () =>
    Response.json(
      { error: "check generation consent required", message: "同意してください", version: 2 },
      { status: 403 },
    ),
  );

  const error = await generateCheck(REQUEST, fetcher).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(CheckConsentRequiredError);
  expect((error as CheckConsentRequiredError).version).toBe(2);
});

test("送信の同意やログインの失敗は共通の種別へ分ける", async () => {
  const fetcher = vi.fn(async () => Response.json({ error: "consent_required" }, { status: 403 }));

  const error = await generateCheck(REQUEST, fetcher).catch((value: unknown) => value);
  expect(error).toEqual(new ApiError("consent_required"));
  expect(error).not.toBeInstanceOf(CheckGenerationError);
});

test("本文の無い失敗は確認問題向けの文面にする", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ error: "AI service is not configured" }, { status: 503 }),
  );

  const error = await generateCheck(REQUEST, fetcher).catch((value: unknown) => value);
  expect(checkErrorText(error)).toBe(
    "確認問題を用意できませんでした。時間をおいて、もう一度お試しください。",
  );
});

test("「今後表示しない」を今の版で記録し、取り消せる", async () => {
  const calls: RequestInit[] = [];
  const fetcher = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    return Response.json(
      init?.method === "PUT"
        ? { version: 1, granted: true, grantedAt: "2026-10-04T00:00:00.000Z" }
        : { version: 1, granted: false },
    );
  });

  await expect(changeGenerationConsent({ grant: 1 }, fetcher)).resolves.toMatchObject({
    granted: true,
  });
  await expect(changeGenerationConsent("revoke", fetcher)).resolves.toMatchObject({
    granted: false,
  });
  expect(calls.map((init) => init.method)).toEqual(["PUT", "DELETE"]);
  expect(JSON.parse(String(calls[0]?.body))).toEqual({ version: 1 });
});

test("古い文面への同意は、読み込み直しを促す失敗にする", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ error: "consent_outdated", message: "更新されました" }, { status: 409 }),
  );

  await expect(changeGenerationConsent({ grant: 1 }, fetcher)).rejects.toEqual(
    new ApiError("consent_outdated"),
  );
});

test.each([
  [0, 9, "intro"],
  [2, 9, "intro"],
  [3, 9, "basic"],
  [5, 9, "basic"],
  [6, 9, "advanced"],
  [9, 9, "advanced"],
] as const)("領域で確認済みが %i / %i なら推奨は %s", (confirmed, total, level) => {
  const statuses = Array.from({ length: total }, (_, index) =>
    index < confirmed ? ("confirmed" as const) : ("learning" as const),
  );
  expect(recommendedLevel(statuses)).toEqual({ level, confirmed, total });
});

test("最初から選ぶのは、満点でなく作成済みでもない項目", () => {
  const objectives = [
    { id: "a", label: "A", value: 1 },
    { id: "b", label: "B", value: 0.5 },
    { id: "c", label: "C", value: null },
    { id: "d", label: "D", value: 0.25 },
  ];

  expect(defaultObjectiveSelection(objectives, new Set(["d"]))).toEqual(["b", "c"]);
});

const OBJECTIVES = [
  { id: "a", label: "A", value: 1 },
  { id: "b", label: "B", value: 0.5 },
  { id: "c", label: "C", value: null },
];

test("理解すること単位では、選んだ項目ごとに1組作る", () => {
  expect(generationTargets("objective", OBJECTIVES, ["a", "b"], new Set())).toEqual([
    { scope: "objective", objectiveId: "a" },
    { scope: "objective", objectiveId: "b" },
  ]);
  expect(generationTargets("objective", OBJECTIVES, [], new Set())).toEqual([]);
});

test("Concept 単位では、まだ 1.0 でなく作成済みでもない項目を自動ですべて1組ずつ作る", () => {
  expect(generationTargets("concept", OBJECTIVES, [], new Set(["c"]))).toEqual([
    { scope: "objective", objectiveId: "b" },
  ]);
  // 選択の状態に引きずられない。
  expect(generationTargets("concept", OBJECTIVES, ["a"], new Set())).toEqual([
    { scope: "objective", objectiveId: "b" },
    { scope: "objective", objectiveId: "c" },
  ]);
});

test("項目を持たない Concept の Concept 単位は、まだ作っていなければ1組", () => {
  expect(generationTargets("concept", [], [], new Set())).toEqual([{ scope: "concept" }]);
  expect(generationTargets("concept", [], [], new Set(["concept"]))).toEqual([]);
});

test("すべての項目が 1.0 のときだけ理解済みとして扱う", () => {
  expect(allObjectivesUnderstood(OBJECTIVES)).toBe(false);
  expect(allObjectivesUnderstood([{ id: "a", label: "A", value: 1 }])).toBe(true);
  // 項目が無い Concept は「理解済み」と言わない（復習ボタンにしない）。
  expect(allObjectivesUnderstood([])).toBe(false);
});

test("作り直した組は同じ狙いの古い組と置き換えて先頭に置く", () => {
  const other = { ...CHECK, objectiveId: "go.defer:lifo" };
  const regenerated = { ...CHECK, level: "advanced" as const, generatedAt: "2026-10-05T00:00:00Z" };

  expect(upsertCheck([other, CHECK], regenerated)).toEqual([regenerated, other]);
});

test("組は作った日時の新しい順に出す", () => {
  const older = { ...CHECK, objectiveId: "go.defer:lifo", generatedAt: "2026-10-03T00:00:00Z" };
  const newer = { ...CHECK, objectiveId: "go.defer:args", generatedAt: "2026-10-05T00:00:00.000Z" };
  const checks = [older, CHECK, newer];

  expect(orderedChecks(checks)).toEqual([newer, CHECK, older]);
  // 元の一覧は並べ替えない。
  expect(checks).toEqual([older, CHECK, newer]);
});

test("組の鍵は作り直し・解き直しで変わる", () => {
  const regenerated = { ...CHECK, generatedAt: "2026-10-05T00:00:00Z" };

  expect(checkSetKey(CHECK, 0)).not.toBe(checkSetKey(regenerated, 0));
  expect(checkSetKey(CHECK, 0)).not.toBe(checkSetKey(CHECK, 1));
  expect(checkSetKey(CHECK, 0)).toBe(checkSetKey({ ...CHECK }, 0));
});

test("まとめは、採点して2問とも正解した組だけを正解に数える", () => {
  const failed = { ...CHECK, objectiveId: "go.defer:lifo" };
  const skipped = { ...CHECK, objectiveId: "go.defer:args" };
  const results = new Map([
    [checkSetKey(CHECK, 1), true],
    [checkSetKey(failed, 1), false],
  ]);

  expect(checkTally([CHECK, failed, skipped], 1, results)).toEqual({ total: 3, passed: 1 });
  // 解き直すと前の回の結果は数えない。
  expect(checkTally([CHECK, failed, skipped], 2, results)).toEqual({ total: 3, passed: 0 });
});

test("次の組は、後ろのまだ終えていない組。無ければ前から探す", () => {
  expect(nextCheckIndex([true, true, true], 0)).toBe(1);
  // 終えた組は飛ばす。
  expect(nextCheckIndex([true, false, true], 0)).toBe(2);
  // 作っている間に前（Q1 側）へ増えた組を、出さないまままとめへ進まない。
  expect(nextCheckIndex([true, false], 1)).toBe(0);
  // 今の組は数えない。
  expect(nextCheckIndex([false, true], 1)).toBeUndefined();
  expect(nextCheckIndex([false, false, false], 2)).toBeUndefined();
});
