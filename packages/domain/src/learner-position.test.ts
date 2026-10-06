/**
 * learner-position.ts の検証（Issue #216）。
 *
 * プロンプトへ載せる「利用者の学習の現在地」の振る舞いを固定する。
 * 載せるもの・載せないもの・並び順はどちらの回答経路（VS Code / Managed AI）
 * でも同じでなければならないため、ここで確認する。
 */

import { describe, expect, test } from "vitest";
import {
  buildLearnerPositionLines,
  LEARNER_POSITION_GROUP_LIMIT,
  recentlyRecurredConceptIds,
} from "./learner-position.js";
import { RECURRENCE_WINDOW_MS, type ConceptMastery, type LearningEvent } from "./profile.js";

function mastery(
  conceptId: string,
  status: ConceptMastery["status"],
  score: number,
): ConceptMastery {
  return {
    conceptId,
    status,
    score,
    evidence: {
      questionCount: 0,
      answerViewCount: 0,
      solvedIndependentlyCount: 0,
      errorRecurrenceCount: 0,
      checkPassedCount: 0,
      checkFailedCount: 0,
      recentTypes: [],
    },
  };
}

function recurredEvent(id: string, occurredAt: string, conceptIds: string[]): LearningEvent {
  return { id, occurredAt, type: "error_recurred", origin: "vscode", conceptIds };
}

const NOW = Date.parse("2026-09-22T10:00:00.000Z");

describe("recentlyRecurredConceptIds", () => {
  test("時間窓の内側の error_recurred だけを、重複なく昇順で返す", () => {
    const events: LearningEvent[] = [
      recurredEvent("e1", "2026-09-20T00:00:00.000Z", ["go.defer", "git.commit"]),
      recurredEvent("e2", "2026-09-21T00:00:00.000Z", ["go.defer"]),
      // 別種別は混ぜない。質問の反復は「再発」ではない。
      {
        id: "e3",
        occurredAt: "2026-09-21T00:00:00.000Z",
        type: "question_asked",
        origin: "vscode",
        conceptIds: ["ts.typeof"],
      },
    ];

    expect(recentlyRecurredConceptIds(events, NOW)).toEqual(["git.commit", "go.defer"]);
  });

  test("時間窓を過ぎた再発は含めない", () => {
    const old = new Date(NOW - RECURRENCE_WINDOW_MS - 1).toISOString();
    const events = [recurredEvent("e1", old, ["go.defer"])];

    expect(recentlyRecurredConceptIds(events, NOW)).toEqual([]);
  });

  test("occurredAt が時刻として解釈できなければ例外にする", () => {
    // 壊れた時刻を「窓の外」と黙って読み替えると、再発の有無が誤る（RULE-004）。
    const events = [recurredEvent("e1", "not-a-date", ["go.defer"])];

    expect(() => recentlyRecurredConceptIds(events, NOW)).toThrow(RangeError);
  });
});

describe("buildLearnerPositionLines", () => {
  test("載せるものが1つも無ければ空配列を返す（セクション自体を出さない）", () => {
    expect(buildLearnerPositionLines({ masteries: [] })).toEqual([]);
    // unobserved は「習熟度が低い」ではなく「判断材料がない」なので載せない。
    expect(
      buildLearnerPositionLines({ masteries: [mastery("go.defer", "unobserved", 0)] }),
    ).toEqual([]);
  });

  test("確認済みと学習中を分けて、表示名と理解度を載せる", () => {
    const lines = buildLearnerPositionLines({
      masteries: [
        mastery("ts.variable_declaration", "confirmed", 0.9),
        mastery("go.defer", "learning", 0.4),
      ],
    });

    const text = lines.join("\n");
    expect(text).toContain("--- 利用者の学習の現在地 ---");
    expect(text).toContain("確認済み（説明を省略してよい前提知識）: 変数宣言と const / let（90%）");
    expect(text).toContain("学習中（基礎を確かめながら説明する範囲）: defer の実行順序（40%）");
    expect(text).toContain("未観測");
  });

  test("同じ状態の中では score の降順、同点なら Concept ID の昇順で並ぶ", () => {
    const lines = buildLearnerPositionLines({
      masteries: [
        mastery("go.defer", "learning", 0.4),
        mastery("ts.variable_declaration", "learning", 0.6),
        mastery("git.commit", "learning", 0.6),
      ],
    });

    const learning = lines.find((line) => line.startsWith("学習中"));
    expect(learning).toBeDefined();
    // 0.6 の2件は ID 昇順（git.commit < ts.variable_declaration）で並ぶ。
    expect(learning).toContain(
      "コミットとメッセージ（60%） / 変数宣言と const / let（60%） / defer の実行順序（40%）",
    );
  });

  test("再発した Concept と外部履歴の形跡を、それぞれ別の行で載せる", () => {
    const lines = buildLearnerPositionLines({
      masteries: [],
      recurringConceptIds: ["go.defer"],
      familiarity: [
        {
          conceptId: "ts.variable_declaration",
          observationCount: 2,
          maxConfidence: 0.8,
          sources: [{ provider: "codex", count: 2 }],
        },
      ],
    });

    const text = lines.join("\n");
    expect(text).toContain("繰り返しつまずいている（最近同じエラーが再発した）: defer の実行順序");
    expect(text).toContain(
      "過去に他の手段で触れた形跡がある（学習の記録では確認していない）: 変数宣言と const / let",
    );
  });

  test("定義に無い Concept ID は表示名の代わりに ID をそのまま出す", () => {
    const lines = buildLearnerPositionLines({
      masteries: [mastery("unknown.concept", "learning", 0.3)],
    });

    expect(lines.join("\n")).toContain("unknown.concept（30%）");
  });

  test("グループの上限を超えた分は「他 N 件」で丸める", () => {
    // 上限は入力トークン上限を現在地で食い潰さないためのもの。
    const masteries = Array.from({ length: LEARNER_POSITION_GROUP_LIMIT + 3 }, (_, i) =>
      mastery(`unknown.c${String(i).padStart(2, "0")}`, "learning", 0.5),
    );
    const lines = buildLearnerPositionLines({ masteries });

    const learning = lines.find((line) => line.startsWith("学習中"));
    expect(learning).toContain("他 3 件");
    expect(learning?.split(" / ")).toHaveLength(LEARNER_POSITION_GROUP_LIMIT);
  });
});
