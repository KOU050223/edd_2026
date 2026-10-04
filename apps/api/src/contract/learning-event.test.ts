import { expect, test } from "vitest";
import * as v from "valibot";
import { learningEventSchema, syncRequestSchema } from "./learning-event.js";

const validEvent = {
  id: "event-1",
  occurredAt: "2026-09-05T00:00:00.000Z",
  type: "solved_independently",
  origin: "vscode",
  conceptIds: ["go.defer"],
};

test("最小限の必須項目を満たすイベントを受理する", () => {
  const result = v.safeParse(learningEventSchema, validEvent);

  expect(result.success).toBe(true);
});

test("任意項目を含むイベントを受理する", () => {
  const result = v.safeParse(learningEventSchema, {
    ...validEvent,
    language: "go",
    diagnosticCode: "S1000",
    sessionId: "session-1",
    objectiveIds: ["go.defer:lifo_order"],
  });

  expect(result.success).toBe(true);
});

test("項目 ID の形でない objectiveIds は拒否する", () => {
  for (const objectiveIds of [["go.defer"], ["lifo_order"], ["go.defer:LIFO"], "go.defer:lifo"]) {
    const result = v.safeParse(learningEventSchema, { ...validEvent, objectiveIds });
    expect(result.success, JSON.stringify(objectiveIds)).toBe(false);
  }
});

test("項目一覧に無い項目 ID でも、形が正しければ受理する", () => {
  // 一覧は生成で入れ替わりうる。届いた時点の一覧で拒否するとオフラインキューのイベントが失われる。
  const result = v.safeParse(learningEventSchema, {
    ...validEvent,
    objectiveIds: ["go.defer:no_such_objective"],
  });

  expect(result.success).toBe(true);
});

test("コード本文のような未知のフィールドは剥がさずに拒否する", () => {
  // LearningEvent にコード本文の置き場所は無い（docs/data-privacy.md のプライバシー二段階）。
  // 黙って捨てると、送信側は保存されたと誤解したまま気づけない。
  const result = v.safeParse(learningEventSchema, {
    ...validEvent,
    sourceCode: "func main() { ... }",
  });

  expect(result.success).toBe(false);
});

test("質問本文を含むイベントも拒否する", () => {
  const result = v.safeParse(learningEventSchema, {
    ...validEvent,
    questionText: "なぜ defer は最後に実行されるのですか",
  });

  expect(result.success).toBe(false);
});

test("occurredAtが解釈できない文字列なら拒否する", () => {
  // ここを通すと deriveMasteryFromEvents が読み取りパスで例外を投げ、
  // GET /v1/learning-profile が永続的に 500 になる。
  const result = v.safeParse(learningEventSchema, {
    ...validEvent,
    occurredAt: "not-a-date",
  });

  expect(result.success).toBe(false);
});

test("occurredAtがタイムゾーン付きでも受理する", () => {
  const result = v.safeParse(learningEventSchema, {
    ...validEvent,
    occurredAt: "2026-09-05T09:00:00+09:00",
  });

  expect(result.success).toBe(true);
});

test("未知のイベント種別を拒否する", () => {
  const result = v.safeParse(learningEventSchema, { ...validEvent, type: "solved_by_ai" });

  expect(result.success).toBe(false);
});

test("Concept IDの命名規則に反する値を拒否する", () => {
  const result = v.safeParse(learningEventSchema, { ...validEvent, conceptIds: ["Go.Defer"] });

  expect(result.success).toBe(false);
});

test("conceptIdsが空配列のイベントは受理する", () => {
  // Concept を特定できなかった質問も、記録自体は残す（packages/domain の applyEvent と同じ扱い）。
  const result = v.safeParse(learningEventSchema, { ...validEvent, conceptIds: [] });

  expect(result.success).toBe(true);
});

test("エンベロープは要素を検証せず、不正なイベントが混ざっていても通る", () => {
  // 1件の不正でバッチ全体を落とさないための設計。
  // 各要素は learningEventSchema で個別に検証し、拒否理由をイベントごとに返す。
  const result = v.safeParse(syncRequestSchema, {
    clientId: "client-1",
    events: [validEvent, { broken: true }],
  });

  expect(result.success).toBe(true);
});

test("clientIdが無いリクエストは拒否する", () => {
  const result = v.safeParse(syncRequestSchema, { events: [] });

  expect(result.success).toBe(false);
});

test("エンベロープの未知フィールドも拒否する", () => {
  const result = v.safeParse(syncRequestSchema, {
    clientId: "client-1",
    events: [],
    accessToken: "leaked-into-body",
  });

  expect(result.success).toBe(false);
});
