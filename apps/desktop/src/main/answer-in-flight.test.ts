import { describe, expect, it } from "vitest";

import { AnswerInFlight } from "./answer-in-flight.js";

describe("AnswerInFlight", () => {
  it("rejects a second answer while one is running (RULE-007)", () => {
    const inFlight = new AnswerInFlight();
    inFlight.begin();

    expect(() => inFlight.begin()).toThrow("回答を生成しています");

    inFlight.finish();
  });

  it("aborts the running signal when cancelled", () => {
    const inFlight = new AnswerInFlight();
    const signal = inFlight.begin();

    inFlight.cancel();

    expect(signal.aborted).toBe(true);
  });

  it("accepts a new answer after finish even if the previous one was aborted", () => {
    const inFlight = new AnswerInFlight();
    inFlight.begin();
    inFlight.cancel();
    inFlight.finish();

    const next = inFlight.begin();
    expect(next.aborted).toBe(false);
  });

  it("clears the busy state on finish so errors cannot wedge the sender", () => {
    const inFlight = new AnswerInFlight();
    inFlight.begin();
    inFlight.finish();

    expect(() => inFlight.begin()).not.toThrow();
  });

  it("ignores cancel calls when nothing is running", () => {
    const inFlight = new AnswerInFlight();
    expect(() => inFlight.cancel()).not.toThrow();
    // 終了後に届いた cancel は既に終わった生成の signal へは遡らない。
    const signal = inFlight.begin();
    inFlight.finish();
    inFlight.cancel();
    expect(signal.aborted).toBe(false);
  });
});
