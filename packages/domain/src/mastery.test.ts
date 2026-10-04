/**
 * deriveMasteryFromEvents の検証。
 *
 * applyEvent 側の検証は apps/vscode-extension/src/test/mastery.test.ts にある。
 * ここでは「サーバーがログから導出する」経路に固有の性質、すなわち
 * イベントの到着順に依存せず結果が一意に決まることを確かめる。
 */

import { expect, test } from "vitest";
import { applyEvent, deriveMasteryFromEvents, isIsoDateTime } from "./mastery.js";
import type { LearningObjective } from "./learning-objective.js";
import { createEmptyProfile, type LearningEvent } from "./profile.js";

function event(
  id: string,
  occurredAt: string,
  type: LearningEvent["type"],
  conceptIds: string[] = ["go.defer"],
): LearningEvent {
  return { id, occurredAt, type, origin: "vscode", conceptIds };
}

test("イベントが無ければ習熟度のキー自体が生まれない", () => {
  expect(deriveMasteryFromEvents([])).toEqual({});
});

test("conceptIdsが空のイベントはどのConceptの習熟度も作らない", () => {
  const events = [event("e1", "2026-09-05T00:00:00.000Z", "question_asked", [])];

  // unobserved を値として持たせず「キーが無いこと」で表すという profile.ts の
  // 契約を守っているかの検査。/v1/learning-profile もこの区別を保つ必要がある。
  expect(deriveMasteryFromEvents(events)).toEqual({});
});

test("入力の順序が変わっても導出結果は同一になる", () => {
  const events = [
    event("e1", "2026-09-05T00:00:01.000Z", "answer_viewed"),
    event("e2", "2026-09-05T00:00:02.000Z", "solved_independently"),
    event("e3", "2026-09-05T00:00:03.000Z", "error_recurred"),
    event("e4", "2026-09-05T00:00:04.000Z", "solved_independently"),
    event("e5", "2026-09-05T00:00:05.000Z", "check_passed"),
  ];

  const inOrder = deriveMasteryFromEvents(events);
  const reversed = deriveMasteryFromEvents([...events].reverse());
  const shuffled = deriveMasteryFromEvents([
    events[2]!,
    events[0]!,
    events[4]!,
    events[1]!,
    events[3]!,
  ]);

  // これが崩れると、同じイベント集合でも同期の到着順で習熟度が変わり、
  // サーバーの導出結果を「正本」と呼べなくなる。
  expect(reversed).toEqual(inOrder);
  expect(shuffled).toEqual(inOrder);
});

test("タイムゾーン表記が違っても実時刻の順で畳み込む", () => {
  // 09:00+09:00 は 00:00Z と同時刻。文字列の辞書順で比較していると
  // "2026-09-05T09:00..." が後ろに並び、順序が入れ替わる。
  const events = [
    event("e2", "2026-09-05T09:00:01+09:00", "error_recurred"),
    event("e1", "2026-09-05T00:00:00.000Z", "solved_independently"),
  ];

  const mastery = deriveMasteryFromEvents(events)["go.defer"];

  expect(mastery?.evidence.recentTypes).toEqual(["solved_independently", "error_recurred"]);
});

test("同時刻のイベントはIDの昇順で畳み込む", () => {
  const sameTime = "2026-09-05T00:00:00.000Z";
  const events = [
    event("b", sameTime, "error_recurred"),
    event("a", sameTime, "solved_independently"),
  ];

  const mastery = deriveMasteryFromEvents(events)["go.defer"];

  // ID昇順なので a(solved) → b(error_recurred) の順に畳み込まれる。
  expect(mastery?.evidence.recentTypes).toEqual(["solved_independently", "error_recurred"]);
});

test("発生順に並んだイベントではapplyEventの畳み込みと一致する", () => {
  const events = [
    event("e1", "2026-09-05T00:00:01.000Z", "answer_viewed"),
    event("e2", "2026-09-05T00:00:02.000Z", "solved_independently"),
    event("e3", "2026-09-05T00:00:03.000Z", "solved_independently"),
    event("e4", "2026-09-05T00:00:04.000Z", "check_passed"),
  ];

  let profile = createEmptyProfile("2026-09-05T00:00:00.000Z");
  for (const e of events) {
    profile = applyEvent(profile, e);
  }

  // 通常時（イベントが発生順に届く）にクライアントとサーバーが同じ習熟度を出すことの検査。
  // ここが壊れたら2つの入口が別々の規則になっており、mastery.ts 冒頭の説明が嘘になる。
  expect(deriveMasteryFromEvents(events)).toEqual(profile.mastery);
});

test("発生順と到着順が食い違うとき、導出結果は発生順に従う", () => {
  const late = event("e1", "2026-09-05T00:00:01.000Z", "solved_independently");
  const early = event("e2", "2026-09-05T00:00:03.000Z", "error_recurred");

  // 到着順（オフラインキューが後から古いイベントを届けた状況）に畳み込む。
  let arrivalOrder = createEmptyProfile("2026-09-05T00:00:00.000Z");
  arrivalOrder = applyEvent(arrivalOrder, early);
  arrivalOrder = applyEvent(arrivalOrder, late);

  const derived = deriveMasteryFromEvents([early, late]);

  // 両者が食い違うのは意図した設計であり、不具合ではない。
  // サーバーは発生時刻順に畳み込み、その結果を正本とする。
  expect(derived["go.defer"]?.evidence.recentTypes).toEqual([
    "solved_independently",
    "error_recurred",
  ]);
  expect(arrivalOrder.mastery["go.defer"]?.evidence.recentTypes).toEqual([
    "error_recurred",
    "solved_independently",
  ]);
  expect(derived).not.toEqual(arrivalOrder.mastery);
});

test("Concept ごとに独立して習熟度を導出する", () => {
  const events = [
    event("e1", "2026-09-05T00:00:01.000Z", "solved_independently", ["go.defer", "go.slice"]),
    event("e2", "2026-09-05T00:00:02.000Z", "error_recurred", ["go.slice"]),
  ];

  const mastery = deriveMasteryFromEvents(events);

  expect(mastery["go.defer"]?.evidence.errorRecurrenceCount).toBe(0);
  expect(mastery["go.slice"]?.evidence.errorRecurrenceCount).toBe(1);
});

test("occurredAtが解釈できないイベントは握りつぶさず例外にする", () => {
  const events = [event("e1", "not-a-date", "question_asked")];

  // 壊れた時刻を0や NaN へ丸めると、そのイベントが黙って先頭に並び、
  // 汚染された習熟度が正常応答として返ってしまう。同期の受理前に弾けるよう表に出す。
  expect(() => deriveMasteryFromEvents(events)).toThrow(TypeError);
});

test("タイムゾーンを持たない日時表記は受け付けない", () => {
  // Date.parse は通るが、実行環境のタイムゾーンで解釈されるため、
  // 同じ入力が開発機と Worker で別の時刻になる。
  for (const value of [
    "2026-09-05",
    "2026-09-05T00:00:00",
    "2026/09/05",
    "September 5, 2026",
    "0",
  ]) {
    expect(isIsoDateTime(value)).toBe(false);
  }
});

test("UTCとオフセット付きの日時表記を受け付ける", () => {
  for (const value of [
    "2026-09-05T00:00:00Z",
    "2026-09-05T00:00:00.000Z",
    "2026-09-05T09:00:00+09:00",
    "2026-09-05T00:00:00-05:00",
  ]) {
    expect(isIsoDateTime(value)).toBe(true);
  }
});

test("存在しない日付は繰り上げて受け付ける", () => {
  // Date.parse は 2026-02-31 を 3/3 として解釈する。暦の妥当性は検査しない。
  // 守りたいのは「意図した瞬間が一意に定まること」であり、繰り上げは一意に定まる。
  expect(isIsoDateTime("2026-02-31T00:00:00Z")).toBe(true);
});

test("タイムゾーンの無い occurredAt は導出時に例外にする", () => {
  const events = [event("e1", "2026-09-05T00:00:00", "question_asked")];

  expect(() => deriveMasteryFromEvents(events)).toThrow(TypeError);
});

test("同じConceptIdが重複していても1回だけ畳み込む", () => {
  // 除かずに畳み込むと、自力解決を1回しただけで evidence が2回分積まれ、
  // confirmed(score 0.7) へ到達してしまう。
  const events = [event("e1", "2026-09-05T00:00:01.000Z", "solved_independently")];
  events[0]!.conceptIds = ["go.defer", "go.defer"];

  const mastery = deriveMasteryFromEvents(events)["go.defer"];

  expect(mastery?.evidence.solvedIndependentlyCount).toBe(1);
  expect(mastery?.score).toBe(0.25);
  // recentTypes は confirmed の判定窓（直近5件）に使うため、ここが二重になると
  // 判定そのものが歪む。
  expect(mastery?.evidence.recentTypes).toEqual(["solved_independently"]);
  expect(mastery?.status).toBe("learning");
});

test("applyEvent でも重複したConceptIdを1回だけ畳み込む", () => {
  // 2つの入口は別々のループなので、両方を検証する。
  const e = event("e1", "2026-09-05T00:00:01.000Z", "solved_independently");
  e.conceptIds = ["go.defer", "go.defer"];

  const profile = applyEvent(createEmptyProfile("2026-09-05T00:00:00.000Z"), e);
  const mastery = profile.mastery["go.defer"];

  expect(mastery?.evidence.solvedIndependentlyCount).toBe(1);
  expect(mastery?.score).toBe(0.25);
  expect(mastery?.evidence.recentTypes).toEqual(["solved_independently"]);
});

test("重複を除いても複数のConceptは別々に畳み込む", () => {
  const e = event("e1", "2026-09-05T00:00:01.000Z", "solved_independently");
  e.conceptIds = ["go.defer", "go.slice", "go.defer"];

  const mastery = deriveMasteryFromEvents([e]);

  expect(mastery["go.defer"]?.evidence.solvedIndependentlyCount).toBe(1);
  expect(mastery["go.slice"]?.evidence.solvedIndependentlyCount).toBe(1);
});

// ---------------------------------------------------------------------------
// 「理解すること」の項目単位の理解度（設計/04 #223）
// ---------------------------------------------------------------------------

const DEFER_OBJECTIVES: LearningObjective[] = [
  { id: "go.defer:timing", conceptId: "go.defer", label: "実行タイミング" },
  { id: "go.defer:args", conceptId: "go.defer", label: "引数の評価" },
  { id: "go.defer:lifo", conceptId: "go.defer", label: "実行順" },
  { id: "go.defer:result", conceptId: "go.defer", label: "戻り値の書き換え" },
];

const SLICE_OBJECTIVES: LearningObjective[] = [
  { id: "go.slice:len_cap", conceptId: "go.slice", label: "len と cap" },
  { id: "go.slice:append", conceptId: "go.slice", label: "append" },
];

let sequence = 0;

/** 項目 ID を載せたイベント。Concept は項目 ID から取る。発生時刻は呼んだ順に進める。 */
function objectiveEvent(type: LearningEvent["type"], objectiveIds: string[]): LearningEvent {
  sequence += 1;
  const conceptIds = [...new Set(objectiveIds.map((id) => id.split(":")[0]!))];
  return {
    ...event(
      `o${String(sequence).padStart(4, "0")}`,
      new Date(sequence * 1000).toISOString(),
      type,
      conceptIds,
    ),
    objectiveIds,
  };
}

function deriveDefer(events: LearningEvent[], objectives = DEFER_OBJECTIVES) {
  return deriveMasteryFromEvents(events, objectives)["go.defer"];
}

test("質問だけで、触れた項目が上がる（確認問題を受けなくてよい）", () => {
  const mastery = deriveDefer([objectiveEvent("question_asked", ["go.defer:timing"])]);

  expect(mastery?.objectives).toEqual({
    "go.defer:timing": 0.05,
    "go.defer:args": 0,
    "go.defer:lifo": 0,
    "go.defer:result": 0,
  });
  expect(mastery?.score).toBeCloseTo(0.0125);
  expect(mastery?.status).toBe("learning");
});

test("質問で上がるのは各項目 0.5 まで", () => {
  const events = Array.from({ length: 20 }, () =>
    objectiveEvent("question_asked", ["go.defer:timing"]),
  );

  expect(deriveDefer(events)?.objectives?.["go.defer:timing"]).toBe(0.5);
});

test("質問を全項目に重ねても確認済みにはならない", () => {
  const events = Array.from({ length: 20 }, () =>
    objectiveEvent(
      "question_asked",
      DEFER_OBJECTIVES.map((o) => o.id),
    ),
  );
  const mastery = deriveDefer(events);

  expect(mastery?.score).toBe(0.5);
  expect(mastery?.status).toBe("learning");
});

test("自力解決は +0.5 で 2 回で最大、確認問題の全問正解は最大にする", () => {
  const mastery = deriveDefer([
    objectiveEvent("solved_independently", ["go.defer:timing"]),
    objectiveEvent("solved_independently", ["go.defer:args"]),
    objectiveEvent("solved_independently", ["go.defer:args"]),
    objectiveEvent("solved_independently", ["go.defer:args"]),
    objectiveEvent("question_asked", ["go.defer:lifo"]),
    objectiveEvent("check_passed", ["go.defer:lifo"]),
  ]);

  expect(mastery?.objectives).toMatchObject({
    "go.defer:timing": 0.5,
    "go.defer:args": 1,
    "go.defer:lifo": 1,
  });
});

test("質問は 0.5 を超えた項目を下げない", () => {
  const mastery = deriveDefer([
    objectiveEvent("check_passed", ["go.defer:timing"]),
    objectiveEvent("question_asked", ["go.defer:timing"]),
  ]);

  expect(mastery?.objectives?.["go.defer:timing"]).toBe(1);
});

test("確認問題の不正解は狙った項目だけ −0.25 し、0 を下回らない", () => {
  const mastery = deriveDefer([
    objectiveEvent("check_passed", ["go.defer:timing"]),
    objectiveEvent("check_passed", ["go.defer:args"]),
    objectiveEvent("check_failed", ["go.defer:timing"]),
    objectiveEvent("check_failed", ["go.defer:lifo"]),
  ]);

  expect(mastery?.objectives).toEqual({
    "go.defer:timing": 0.75,
    "go.defer:args": 1,
    "go.defer:lifo": 0,
    "go.defer:result": 0,
  });
  expect(mastery?.score).toBeCloseTo(0.4375);
});

test("同じエラーの再発は記録だけ残し、項目を下げない", () => {
  const mastery = deriveDefer([
    objectiveEvent("check_passed", ["go.defer:timing"]),
    objectiveEvent("error_recurred", ["go.defer:timing"]),
  ]);

  expect(mastery?.objectives?.["go.defer:timing"]).toBe(1);
  expect(mastery?.evidence.errorRecurrenceCount).toBe(1);
});

test("平均 0.9 以上かつ全項目に進みがあれば確認済み", () => {
  // 質問 2 回（0.1）→ 自力解決（+0.5）で 0.6。1, 1, 1, 0.6 の平均がちょうど 0.9 になる。
  // 0.05 刻みを浮動小数で足すと 0.9 をわずかに下回りうるので、境界そのものを確かめる。
  const threePassed = objectiveEvent("check_passed", [
    "go.defer:timing",
    "go.defer:args",
    "go.defer:lifo",
  ]);
  const toPointSix = [
    objectiveEvent("question_asked", ["go.defer:result"]),
    objectiveEvent("question_asked", ["go.defer:result"]),
    objectiveEvent("solved_independently", ["go.defer:result"]),
  ];

  const atThreshold = deriveDefer([threePassed, ...toPointSix]);
  expect(atThreshold?.objectives?.["go.defer:result"]).toBe(0.6);
  expect(atThreshold?.score).toBe(0.9);
  expect(atThreshold?.status).toBe("confirmed");

  // 質問を 1 回減らすと 0.55 で、平均 0.8875 は届かない。
  const below = deriveDefer([threePassed, ...toPointSix.slice(1)]);
  expect(below?.score).toBeCloseTo(0.8875);
  expect(below?.status).toBe("learning");
});

test("平均が 0.9 に届いても、進みの無い項目が残れば確認済みにならない", () => {
  const ten: LearningObjective[] = Array.from({ length: 10 }, (_, i) => ({
    id: `go.defer:item_${i}`,
    conceptId: "go.defer",
    label: `項目${i}`,
  }));
  const mastery = deriveDefer(
    [
      objectiveEvent(
        "check_passed",
        ten.slice(0, 9).map((o) => o.id),
      ),
    ],
    ten,
  );

  expect(mastery?.score).toBe(0.9);
  expect(mastery?.status).toBe("learning");
});

test("1つのイベントが複数のノードの項目にまたがってもそれぞれに反映する", () => {
  const mastery = deriveMasteryFromEvents(
    [objectiveEvent("solved_independently", ["go.defer:timing", "go.slice:append"])],
    [...DEFER_OBJECTIVES, ...SLICE_OBJECTIVES],
  );

  expect(mastery["go.defer"]?.objectives?.["go.defer:timing"]).toBe(0.5);
  expect(mastery["go.slice"]?.objectives).toEqual({
    "go.slice:len_cap": 0,
    "go.slice:append": 0.5,
  });
  expect(mastery["go.slice"]?.score).toBe(0.25);
});

test("項目の値はその Concept の上限（1 / 項目数）を超えない", () => {
  const events = Array.from({ length: 5 }, () =>
    objectiveEvent("solved_independently", ["go.defer:timing"]),
  );
  const mastery = deriveDefer(events);

  // 1 項目だけを何度上げても、ノードへの寄与は 1 / 4 で止まる。
  expect(mastery?.objectives?.["go.defer:timing"]).toBe(1);
  expect(mastery?.score).toBe(0.25);
});

test("項目の情報を持たないイベントは項目を動かさない（記録は残す）", () => {
  const mastery = deriveDefer([
    event("legacy1", "2026-09-05T00:00:01.000Z", "solved_independently"),
    event("legacy2", "2026-09-05T00:00:02.000Z", "check_passed"),
    event("legacy3", "2026-09-05T00:00:03.000Z", "check_passed"),
  ]);

  // 従来の回数の判定なら確認済みになるイベント列でも、項目のある Concept では学習中に戻る。
  expect(mastery?.status).toBe("learning");
  expect(mastery?.score).toBe(0);
  expect(mastery?.evidence.checkPassedCount).toBe(2);
});

test("項目がまだ無い Concept は従来の回数の判定のまま", () => {
  const events = [
    event("e1", "2026-09-05T00:00:01.000Z", "solved_independently", ["ts.type_narrowing"]),
    event("e2", "2026-09-05T00:00:02.000Z", "check_passed", ["ts.type_narrowing"]),
  ];
  const mastery = deriveMasteryFromEvents(events, DEFER_OBJECTIVES)["ts.type_narrowing"];

  expect(mastery?.status).toBe("confirmed");
  expect(mastery?.score).toBe(0.7);
  expect(mastery?.objectives).toBeUndefined();
});

test("conceptIds に無い Concept の項目 ID は無視する", () => {
  const e: LearningEvent = {
    ...event("e1", "2026-09-05T00:00:01.000Z", "check_passed", ["go.slice"]),
    objectiveIds: ["go.defer:timing"],
  };
  const mastery = deriveMasteryFromEvents([e], [...DEFER_OBJECTIVES, ...SLICE_OBJECTIVES]);

  expect(mastery["go.defer"]).toBeUndefined();
  expect(mastery["go.slice"]?.score).toBe(0);
});

test("項目が増えたら 0 から始まり、確認済みだったノードは学習中に戻る", () => {
  const events = [
    objectiveEvent(
      "check_passed",
      DEFER_OBJECTIVES.map((o) => o.id),
    ),
  ];
  expect(deriveDefer(events)?.status).toBe("confirmed");

  const added: LearningObjective = {
    id: "go.defer:recover",
    conceptId: "go.defer",
    label: "recover",
  };
  const mastery = deriveDefer(events, [...DEFER_OBJECTIVES, added]);

  expect(mastery?.objectives?.["go.defer:recover"]).toBe(0);
  expect(mastery?.score).toBe(0.8);
  expect(mastery?.status).toBe("learning");
});

test("項目が減ったら、残った項目だけで計算し直し、消えた項目の進みは補填しない", () => {
  const events = [
    objectiveEvent("check_passed", ["go.defer:timing"]),
    objectiveEvent("solved_independently", ["go.defer:args"]),
  ];
  const mastery = deriveDefer(events, DEFER_OBJECTIVES.slice(1));

  expect(mastery?.objectives).toEqual({
    "go.defer:args": 0.5,
    "go.defer:lifo": 0,
    "go.defer:result": 0,
  });
  expect(mastery?.score).toBeCloseTo(0.1667, 4);
});

test("applyEvent も同じ規則で項目を積み上げ、一覧の変化に追従する", () => {
  let profile = createEmptyProfile("2026-09-05T00:00:00.000Z");
  const events = [
    objectiveEvent("solved_independently", ["go.defer:timing"]),
    objectiveEvent("question_asked", ["go.defer:args"]),
  ];
  for (const e of events) {
    profile = applyEvent(profile, e, DEFER_OBJECTIVES);
  }

  expect(profile.mastery["go.defer"]).toEqual(deriveDefer(events));

  // 一覧から消えた項目は、次のイベントを畳み込むときに落ちる。
  profile = applyEvent(
    profile,
    objectiveEvent("question_asked", ["go.defer:lifo"]),
    DEFER_OBJECTIVES.slice(1),
  );
  expect(Object.keys(profile.mastery["go.defer"]?.objectives ?? {})).toEqual([
    "go.defer:args",
    "go.defer:lifo",
    "go.defer:result",
  ]);
});
