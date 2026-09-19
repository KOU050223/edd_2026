import { expect, test } from "vitest";
import { applyEvent, createEmptyProfile, type LearningEvent } from "@gakushu-sochi/domain";

let nextId = 1;

function event(partial: Partial<LearningEvent> & Pick<LearningEvent, "type">): LearningEvent {
  nextId += 1;
  return {
    id: `event-${nextId}`,
    occurredAt: `2026-09-05T00:00:0${nextId % 10}.000Z`,
    origin: "vscode",
    conceptIds: ["go.defer"],
    ...partial,
  };
}

test("イベントが無いConceptはmasteryに現れない(unobserved相当)", () => {
  const profile = createEmptyProfile("2026-09-05T00:00:00.000Z");

  expect(profile.mastery["go.defer"]).toBeUndefined();
});

test("自力解決を2回積むとconfirmedになる", () => {
  let profile = createEmptyProfile("2026-09-05T00:00:00.000Z");

  profile = applyEvent(profile, event({ type: "hint_used" }));
  profile = applyEvent(profile, event({ type: "solved_independently" }));
  profile = applyEvent(profile, event({ type: "solved_independently" }));

  const mastery = profile.mastery["go.defer"];
  expect(mastery?.status).toBe("confirmed");
  expect(mastery?.evidence.solvedIndependentlyCount).toBe(2);
  // status確定後にクランプするため、confirmedの範囲(0.7〜1.0)に収まる。
  expect(mastery?.score).toBeGreaterThanOrEqual(0.7);
});

test("再発するとconfirmedから外れ、直近の並びだけで判定する", () => {
  let profile = createEmptyProfile("2026-09-05T00:00:00.000Z");

  profile = applyEvent(profile, event({ type: "solved_independently" }));
  profile = applyEvent(profile, event({ type: "solved_independently" }));
  expect(profile.mastery["go.defer"]?.status).toBe("confirmed");

  profile = applyEvent(profile, event({ type: "error_recurred" }));
  expect(profile.mastery["go.defer"]?.status).toBe("learning");

  // 累積回数は減らないので、再発後に自力解決を重ねれば回復できる
  // (docs/concepts.mdの「一度でも再発したConceptが二度とconfirmedに戻れなくなってはならない」)。
  // recentTypesは直近5件しか見ないため、error_recurredがその窓から押し出される
  // まで(5件分)はconfirmedへ戻らない。
  for (let i = 0; i < 4; i += 1) {
    profile = applyEvent(profile, event({ type: "solved_independently" }));
    expect(profile.mastery["go.defer"]?.status).toBe("learning");
  }
  profile = applyEvent(profile, event({ type: "solved_independently" }));
  expect(profile.mastery["go.defer"]?.status).toBe("confirmed");
});

test("questionCountはscoreに影響しない", () => {
  let profile = createEmptyProfile("2026-09-05T00:00:00.000Z");

  profile = applyEvent(profile, event({ type: "question_asked" }));
  profile = applyEvent(profile, event({ type: "question_asked" }));
  profile = applyEvent(profile, event({ type: "question_asked" }));

  const mastery = profile.mastery["go.defer"];
  expect(mastery?.evidence.questionCount).toBe(3);
  expect(mastery?.score).toBe(0);
  expect(mastery?.status).toBe("learning");
});

test("conceptIdsが空のイベントはevents履歴にだけ残りmasteryを変えない", () => {
  let profile = createEmptyProfile("2026-09-05T00:00:00.000Z");

  profile = applyEvent(profile, event({ type: "question_asked", conceptIds: [] }));

  expect(profile.events).toHaveLength(1);
  expect(profile.mastery).toEqual({});
});

test("events履歴は1000件を超えると古いものから捨てる", () => {
  let profile = createEmptyProfile("2026-09-05T00:00:00.000Z");

  for (let i = 0; i < 1005; i += 1) {
    profile = applyEvent(profile, event({ type: "question_asked", id: `bulk-${i}` }));
  }

  expect(profile.events).toHaveLength(1000);
  expect(profile.events[0]?.id).toBe("bulk-5");
});
