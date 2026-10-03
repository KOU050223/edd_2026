import { expect, test } from "vitest";
import { summarizeConcepts } from "./profile.js";

test("未観測の Concept を学習中へ混在させない", () => {
  expect(
    summarizeConcepts([
      {
        conceptId: "confirmed",
        status: "confirmed",
        score: 1,
        evidence: { solvedIndependentlyCount: 2 },
      },
      {
        conceptId: "learning",
        status: "learning",
        score: 0.5,
        evidence: { solvedIndependentlyCount: 1 },
      },
      {
        conceptId: "unobserved",
        status: "unobserved",
        score: 0,
        evidence: { solvedIndependentlyCount: 0 },
      },
    ]),
  ).toEqual({ confirmed: 1, learning: 1, unobserved: 1 });
});
