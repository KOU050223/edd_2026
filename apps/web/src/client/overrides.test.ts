import { expect, test } from "vitest";
import { applyOverrides, clampScoreToStatus } from "./overrides.js";
import { summarizeConcepts, type Concept } from "./profile.js";

const CONCEPTS: Concept[] = [
  {
    conceptId: "go.pointer",
    label: "ポインタ",
    status: "learning",
    score: 0.4,
    evidence: { solvedIndependentlyCount: 1 },
  },
  {
    conceptId: "go.defer",
    status: "unobserved",
    score: 0,
    evidence: { solvedIndependentlyCount: 0 },
  },
];

test("手動で理解度を変えても自動算出の evidence は書き換えない", () => {
  const overlaid = applyOverrides(CONCEPTS, {
    "go.pointer": { status: "confirmed", updatedAt: "2026-09-21T00:00:00.000Z" },
  });

  expect(overlaid[0]?.status).toBe("confirmed");
  expect(overlaid[0]?.evidence).toEqual({ solvedIndependentlyCount: 1 });
});

test("手動で変えた Concept は自動算出の値を併せて保持する", () => {
  const overlaid = applyOverrides(CONCEPTS, {
    "go.pointer": { status: "confirmed", updatedAt: "2026-09-21T00:00:00.000Z" },
  });

  expect(overlaid[0]?.manual).toBe(true);
  expect(overlaid[0]?.derived).toEqual({ status: "learning", score: 0.4 });
  expect(overlaid[1]?.manual).toBe(false);
  expect(overlaid[1]?.derived).toEqual({ status: "unobserved", score: 0 });
});

test("手動修正の無い未観測も割合を表示しない", () => {
  const overlaid = applyOverrides(CONCEPTS, {});

  expect(overlaid[1]?.score).toBeNull();
  expect(overlaid[0]?.score).toBe(0.4);
});

test("確認済みへ手動で上げたらメーターの割合も確認済みの範囲に入る", () => {
  const overlaid = applyOverrides(CONCEPTS, {
    "go.pointer": { status: "confirmed", updatedAt: "2026-09-21T00:00:00.000Z" },
  });

  expect(overlaid[0]?.score).toBe(0.7);
});

test("未観測へ手動で下げたら割合は表示しない", () => {
  expect(clampScoreToStatus(0.95, "unobserved")).toBeNull();
  expect(clampScoreToStatus(0.95, "learning")).toBe(0.69);
  expect(clampScoreToStatus(0.1, "confirmed")).toBe(0.7);
});

test("知らない conceptId の上書きが残っていても Concept を捏造しない", () => {
  const overlaid = applyOverrides(CONCEPTS, {
    "go.deleted": { status: "confirmed", updatedAt: "2026-09-21T00:00:00.000Z" },
  });

  expect(overlaid.map((concept) => concept.conceptId)).toEqual(["go.pointer", "go.defer"]);
});

test("手動で変えた理解度は集計にも反映される", () => {
  const overlaid = applyOverrides(CONCEPTS, {
    "go.defer": { status: "confirmed", updatedAt: "2026-09-21T00:00:00.000Z" },
  });

  expect(summarizeConcepts(overlaid)).toEqual({ confirmed: 1, learning: 1, unobserved: 0 });
});

test("「理解すること」を持つ Concept の割合は項目の平均のまま見せ、範囲へ丸めない", () => {
  // 0 の項目が残って学習中でも、平均は 0.69 を超えうる（docs/concepts.md「項目ごとの理解度」）。
  const withObjectives: Concept = {
    conceptId: "go.defer",
    status: "learning",
    score: 0.8,
    evidence: { solvedIndependentlyCount: 0 },
    objectives: {
      "go.defer:a": 1,
      "go.defer:b": 1,
      "go.defer:c": 1,
      "go.defer:d": 1,
      "go.defer:e": 0,
    },
  };

  expect(applyOverrides([withObjectives], {})[0]?.score).toBe(0.8);
  // 手動で status を変えたときは、従来どおりその status の範囲へ収める。
  const manual = applyOverrides([withObjectives], {
    "go.defer": { status: "unobserved", updatedAt: "2026-09-21T00:00:00.000Z" },
  });
  expect(manual[0]?.score).toBeNull();
});
