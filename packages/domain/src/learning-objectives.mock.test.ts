import { expect, test } from "vitest";
import { CONCEPTS } from "./concepts.generated.js";
import { isLearningObjectiveIdOf } from "./learning-objective.js";
import { MOCK_LEARNING_OBJECTIVES } from "./learning-objectives.mock.js";

const GO_CONCEPT_IDS = CONCEPTS.filter((concept) => concept.language === "go").map(
  (concept) => concept.id,
);

test("Go の全 Concept が 4〜5 項目を持ち、Go 以外は持たない", () => {
  for (const conceptId of GO_CONCEPT_IDS) {
    const count = MOCK_LEARNING_OBJECTIVES.filter((o) => o.conceptId === conceptId).length;
    expect(count, conceptId).toBeGreaterThanOrEqual(4);
    expect(count, conceptId).toBeLessThanOrEqual(5);
  }
  const owners = new Set(MOCK_LEARNING_OBJECTIVES.map((o) => o.conceptId));
  expect([...owners].sort()).toEqual([...GO_CONCEPT_IDS].sort());
});

test("項目 ID は一意で、所属する Concept の ID で始まる", () => {
  const ids = MOCK_LEARNING_OBJECTIVES.map((o) => o.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const objective of MOCK_LEARNING_OBJECTIVES) {
    expect(isLearningObjectiveIdOf(objective.id, objective.conceptId), objective.id).toBe(true);
    expect(objective.label.trim(), objective.id).not.toBe("");
  }
});

test("isLearningObjectiveIdOf は形と所属の両方を確かめる", () => {
  expect(isLearningObjectiveIdOf("go.defer:lifo_order", "go.defer")).toBe(true);
  expect(isLearningObjectiveIdOf("go.defer:lifo_order", "go.context")).toBe(false);
  expect(isLearningObjectiveIdOf("go.defer:", "go.defer")).toBe(false);
  expect(isLearningObjectiveIdOf("go.defer:LIFO", "go.defer")).toBe(false);
  expect(isLearningObjectiveIdOf("go.defer_extra:lifo_order", "go.defer")).toBe(false);
  expect(isLearningObjectiveIdOf("Go.Defer:lifo_order", "Go.Defer")).toBe(false);
});
