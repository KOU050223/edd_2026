/**
 * deriveMasteryFromEvents の検証。
 *
 * applyEvent 側の検証は apps/vscode-extension/src/test/mastery.test.ts にある。
 * ここでは「サーバーがログから導出する」経路に固有の性質、すなわち
 * イベントの到着順に依存せず結果が一意に決まることを確かめる。
 */

import { expect, test } from "vitest";
import { applyEvent, deriveMasteryFromEvents, isIsoDateTime } from "./mastery.js";
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
