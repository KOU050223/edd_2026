/**
 * evidence.ts の検証。
 *
 * 外部履歴を LearningEvidence へ正規化し、Familiarity へ畳み込み、
 * Learning Map の表示状態を導出するまでの規則を固定する。
 * Issue #157 の「Provider の差異を Domain 側へ漏らさない」
 * 「触れたことがあると理解しているを区別する」を担保するのがこの層。
 */

import { expect, test } from "vitest";
import {
  deriveFamiliarityFromEvidence,
  deriveLearningMapStatus,
  isProbablyProgrammingRelated,
  normalizeAnalysisResult,
  selectAnalysisProvider,
  selectCalibrationCandidates,
  suggestNextConcepts,
  type NormalizeEvidenceContext,
} from "./evidence.js";
import {
  canTransitionImportSession,
  type AnalysisProvider,
  type ConceptFamiliarity,
  type HistoryAnalysisResult,
  type LearningEvidence,
} from "./history-import.js";
import type { Concept, ConceptMastery } from "./profile.js";

const CONCEPTS: Concept[] = [
  {
    id: "go.pointer_receiver",
    label: "値レシーバとポインタレシーバ",
    language: "go",
    source: { kind: "manual" },
  },
  {
    id: "go.error_handling",
    label: "error 型と if err != nil",
    language: "go",
    source: { kind: "manual" },
  },
  {
    id: "ts.type_narrowing",
    label: "型の絞り込み",
    language: "ts",
    source: { kind: "manual" },
  },
];

const CTX: NormalizeEvidenceContext = {
  provider: "codex",
  importedBy: "desktop",
  importSessionId: "session-1",
  concepts: CONCEPTS,
};

function observation(
  sourceId: string,
  conceptCandidates: string[],
  overrides: Partial<HistoryAnalysisResult["observations"][number]> = {},
) {
  return {
    sourceId,
    conceptCandidates,
    kind: "question" as const,
    confidence: 0.8,
    ...overrides,
  };
}

function evidence(partial: Partial<LearningEvidence> & { id: string }): LearningEvidence {
  return {
    conceptIds: ["go.pointer_receiver"],
    source: { provider: "codex", importedBy: "desktop" },
    kind: "question",
    confidence: 0.8,
    importSessionId: "session-1",
    ...partial,
  };
}

function mastery(status: ConceptMastery["status"]): ConceptMastery {
  return {
    conceptId: "go.pointer_receiver",
    status,
    score: 0.5,
    evidence: {
      questionCount: 0,
      hintCount: 0,
      answerViewCount: 0,
      solvedIndependentlyCount: 0,
      errorRecurrenceCount: 0,
      checkPassedCount: 0,
      checkFailedCount: 0,
      recentTypes: [],
    },
  };
}

// ---------------------------------------------------------------------------
// normalizeAnalysisResult
// ---------------------------------------------------------------------------

test("正確な Concept ID の候補はそのまま Evidence になる", () => {
  const result = normalizeAnalysisResult(
    { observations: [observation("s1", ["go.pointer_receiver"])] },
    CTX,
  );

  expect(result.evidence).toEqual([
    {
      id: "session-1:codex:s1",
      conceptIds: ["go.pointer_receiver"],
      source: { provider: "codex", importedBy: "desktop" },
      kind: "question",
      confidence: 0.8,
      importSessionId: "session-1",
    },
  ]);
  expect(result.unmapped).toEqual([]);
  expect(result.rejected).toEqual([]);
});

test("Concept ID 以外の候補は label や ID 末尾への一意な照合で Concept へ写す", () => {
  const result = normalizeAnalysisResult(
    {
      observations: [
        // label の完全一致（大文字小文字は無視する）
        observation("s1", ["error 型と if err != nil"]),
        // ID 末尾の一致（catalog 内で一意な場合だけ）
        observation("s2", ["type_narrowing"]),
        // 空白や大小文字の揺れを正規化して ID と照合する
        observation("s3", ["Go.Pointer_Receiver"]),
      ],
    },
    CTX,
  );

  expect(result.evidence.map((e) => e.conceptIds)).toEqual([
    ["go.error_handling"],
    ["ts.type_narrowing"],
    ["go.pointer_receiver"],
  ]);
});

test("候補が ID 末尾で一意に決まらない場合は unmapped に残し、推測で写さない", () => {
  const ambiguousCatalog: Concept[] = [
    { id: "go.pointer", label: "a", language: "go", source: { kind: "manual" } },
    { id: "c.pointer", label: "b", language: "c", source: { kind: "manual" } },
  ];
  const result = normalizeAnalysisResult(
    { observations: [observation("s1", ["pointer"])] },
    { ...CTX, concepts: ambiguousCatalog },
  );

  expect(result.evidence).toEqual([]);
  expect(result.unmapped).toEqual([{ sourceId: "s1", candidate: "pointer" }]);
});

test("一覧に無い話題は unmapped として残し、近い Concept へ押し込まない", () => {
  const result = normalizeAnalysisResult(
    { observations: [observation("s1", ["kubernetes"])] },
    CTX,
  );

  expect(result.evidence).toEqual([]);
  expect(result.unmapped).toEqual([{ sourceId: "s1", candidate: "kubernetes" }]);
});

test("候補を1つも持たない観測は棄却し、Concept の無い Evidence を作らない", () => {
  const result = normalizeAnalysisResult({ observations: [observation("s1", [])] }, CTX);

  expect(result.evidence).toEqual([]);
  expect(result.rejected).toEqual([{ sourceId: "s1", reason: "no-concept-candidates" }]);
});

test("confidence が範囲外の観測は棄却する", () => {
  const result = normalizeAnalysisResult(
    {
      observations: [
        observation("high", ["go.pointer_receiver"], { confidence: 1.2 }),
        observation("low", ["go.pointer_receiver"], { confidence: -0.1 }),
        observation("nan", ["go.pointer_receiver"], { confidence: Number.NaN }),
      ],
    },
    CTX,
  );

  expect(result.evidence).toEqual([]);
  expect(result.rejected.map((r) => r.sourceId)).toEqual(["high", "low", "nan"]);
  expect(result.rejected.every((r) => r.reason === "invalid-confidence")).toBe(true);
});

test("observedAt が解釈できない観測は棄却する", () => {
  const result = normalizeAnalysisResult(
    {
      observations: [
        observation("s1", ["go.pointer_receiver"], { observedAt: "3年前" }),
        observation("s2", ["go.pointer_receiver"], { observedAt: "2026-09-05T00:00:00Z" }),
      ],
    },
    CTX,
  );

  // 壊れた時刻を通すと「最後に触れた時期」の根拠が汚染される。
  // 落とすのは観測そのものではなく検証できない行だけにし、後者は残す。
  expect(result.evidence).toHaveLength(1);
  expect(result.evidence[0]?.observedAt).toBe("2026-09-05T00:00:00Z");
  expect(result.rejected).toEqual([{ sourceId: "s1", reason: "invalid-observed-at" }]);
});

test("sourceId の無い観測は棄却する", () => {
  const result = normalizeAnalysisResult(
    { observations: [observation("", ["go.pointer_receiver"])] },
    CTX,
  );

  expect(result.evidence).toEqual([]);
  expect(result.rejected).toEqual([{ sourceId: "", reason: "missing-source-id" }]);
});

test("同じ sourceId の観測は1件の Evidence へまとめる", () => {
  const result = normalizeAnalysisResult(
    {
      observations: [
        observation("s1", ["go.pointer_receiver"], { confidence: 0.4 }),
        observation("s1", ["go.error_handling"], {
          confidence: 0.9,
          kind: "debugging",
        }),
      ],
    },
    CTX,
  );

  // 二重計上を避けつつ情報は失わない。Concept は和集合、confidence は最大値、
  // kind は最も確からしい観測のものを採る。
  expect(result.evidence).toHaveLength(1);
  expect(result.evidence[0]?.conceptIds.sort()).toEqual([
    "go.error_handling",
    "go.pointer_receiver",
  ]);
  expect(result.evidence[0]?.confidence).toBe(0.9);
  expect(result.evidence[0]?.kind).toBe("debugging");
});

test("同じ sourceId の観測で observedAt は最新のものを採る", () => {
  const result = normalizeAnalysisResult(
    {
      observations: [
        observation("s1", ["go.pointer_receiver"], {
          observedAt: "2024-01-01T00:00:00Z",
        }),
        observation("s1", ["go.error_handling"], {
          observedAt: "2026-01-01T00:00:00Z",
        }),
      ],
    },
    CTX,
  );

  expect(result.evidence[0]?.observedAt).toBe("2026-01-01T00:00:00Z");
});

test("Evidence の ID は Session と Provider と sourceId から一意に決まる", () => {
  const a = normalizeAnalysisResult(
    { observations: [observation("s1", ["go.pointer_receiver"])] },
    CTX,
  );
  const b = normalizeAnalysisResult(
    { observations: [observation("s1", ["go.pointer_receiver"])] },
    { ...CTX, provider: "claude-code" },
  );

  expect(a.evidence[0]?.id).toBe("session-1:codex:s1");
  expect(b.evidence[0]?.id).toBe("session-1:claude-code:s1");
  // 別 Provider で同じ sourceId が出ても Evidence ID は衝突しない。
  expect(a.evidence[0]?.id).not.toBe(b.evidence[0]?.id);
});

// ---------------------------------------------------------------------------
// deriveFamiliarityFromEvidence
// ---------------------------------------------------------------------------

test("Evidence が無ければ Familiarity のキー自体が生まれない", () => {
  expect(deriveFamiliarityFromEvidence([])).toEqual({});
});

test("Concept ごとに観測数・最大 confidence・最終観測を集計する", () => {
  const familiarity = deriveFamiliarityFromEvidence([
    evidence({ id: "e1", observedAt: "2024-06-01T00:00:00Z", confidence: 0.5 }),
    evidence({ id: "e2", observedAt: "2025-06-01T00:00:00Z", confidence: 0.9 }),
    evidence({ id: "e3", conceptIds: ["ts.type_narrowing"] }),
  ]);

  expect(familiarity["go.pointer_receiver"]).toEqual({
    conceptId: "go.pointer_receiver",
    observationCount: 2,
    maxConfidence: 0.9,
    lastObservedAt: "2025-06-01T00:00:00Z",
    sources: [{ provider: "codex", count: 2, lastObservedAt: "2025-06-01T00:00:00Z" }],
  });
  expect(familiarity["ts.type_narrowing"]?.observationCount).toBe(1);
});

test("1件の Evidence が複数 Concept にまたがってもそれぞれへ数える", () => {
  const familiarity = deriveFamiliarityFromEvidence([
    evidence({ id: "e1", conceptIds: ["go.pointer_receiver", "go.error_handling"] }),
  ]);

  expect(familiarity["go.pointer_receiver"]?.observationCount).toBe(1);
  expect(familiarity["go.error_handling"]?.observationCount).toBe(1);
});

test("ソースごとの内訳を持ち、並びは provider 名の昇順で一意にする", () => {
  const familiarity = deriveFamiliarityFromEvidence([
    evidence({ id: "e1", source: { provider: "codex", importedBy: "desktop" } }),
    evidence({ id: "e2", source: { provider: "chatgpt", importedBy: "file" } }),
    evidence({ id: "e3", source: { provider: "codex", importedBy: "desktop" } }),
  ]);

  // 「なぜこの状態か」を説明するための根拠。出力順が入力順に依存すると
  // 同じ履歴でも表示が揺れるため、名前順で固定する。
  expect(familiarity["go.pointer_receiver"]?.sources).toEqual([
    { provider: "chatgpt", count: 1, lastObservedAt: undefined },
    { provider: "codex", count: 2, lastObservedAt: undefined },
  ]);
});

test("観測時刻の無い Evidence も数えるが lastObservedAt は立てない", () => {
  const familiarity = deriveFamiliarityFromEvidence([evidence({ id: "e1" })]);

  expect(familiarity["go.pointer_receiver"]?.observationCount).toBe(1);
  expect(familiarity["go.pointer_receiver"]?.lastObservedAt).toBeUndefined();
});

test("解釈できない observedAt を持つ Evidence は握りつぶさず例外にする", () => {
  // Normalizer を通っていれば起きないはずの値を直接渡された場合、
  // 0 や NaN へ丸めると「最後に触れた時期」が黙って嘘をつく。
  expect(() =>
    deriveFamiliarityFromEvidence([evidence({ id: "e1", observedAt: "not-a-date" })]),
  ).toThrow(TypeError);
});

// ---------------------------------------------------------------------------
// deriveLearningMapStatus
// ---------------------------------------------------------------------------

test("Mastery がある Concept は Familiarity に関わらず Mastery の状態を使う", () => {
  const fam: ConceptFamiliarity = {
    conceptId: "go.pointer_receiver",
    observationCount: 3,
    maxConfidence: 0.9,
    sources: [],
  };
  // 「触れた形跡」は Mastery を底上げしない。confirmed への到達は
  // 実際の学習イベント（自力解決・確認問題）だけが担う。
  expect(deriveLearningMapStatus(mastery("confirmed"), fam)).toBe("confirmed");
  expect(deriveLearningMapStatus(mastery("learning"), fam)).toBe("learning");
});

test("Mastery が無く Familiarity だけある Concept は familiar になる", () => {
  const fam: ConceptFamiliarity = {
    conceptId: "go.pointer_receiver",
    observationCount: 1,
    maxConfidence: 0.5,
    sources: [],
  };
  expect(deriveLearningMapStatus(undefined, fam)).toBe("familiar");
});

test("どちらの観測も無い Concept は unobserved になる", () => {
  expect(deriveLearningMapStatus(undefined, undefined)).toBe("unobserved");
});

// ---------------------------------------------------------------------------
// selectAnalysisProvider
// ---------------------------------------------------------------------------

function provider(id: string, available = true): AnalysisProvider {
  return {
    id,
    isAvailable: () => Promise.resolve(available),
    analyze: () => Promise.resolve({ observations: [] }),
  };
}

const BUDGET = { managedAiMaxCalls: 2 };

test("優先順位の先頭から、利用可能な最初の Provider を選ぶ", async () => {
  const first = provider("unavailable-cli", false);
  const second = provider("codex-cli");
  const selection = await selectAnalysisProvider(
    [
      { provider: first, managed: false },
      { provider: second, managed: false },
    ],
    { mode: "auto", managedCallsUsed: 0, budget: BUDGET },
  );

  expect(selection).toEqual({ kind: "provider", provider: second });
});

test("どれも利用できなければ no-provider を返す", async () => {
  const selection = await selectAnalysisProvider(
    [{ provider: provider("x", false), managed: false }],
    { mode: "auto", managedCallsUsed: 0, budget: BUDGET },
  );

  expect(selection).toEqual({ kind: "unavailable", reason: "no-provider" });
});

test("user-ai モードでは Managed AI を選ばない", async () => {
  const selection = await selectAnalysisProvider(
    [{ provider: provider("managed"), managed: true }],
    { mode: "user-ai", managedCallsUsed: 0, budget: BUDGET },
  );

  expect(selection).toEqual({ kind: "unavailable", reason: "no-provider" });
});

test("managed モードではユーザー所有の Provider を選ばない", async () => {
  const selection = await selectAnalysisProvider(
    [{ provider: provider("codex-cli"), managed: false }],
    { mode: "managed", managedCallsUsed: 0, budget: BUDGET },
  );

  expect(selection).toEqual({ kind: "unavailable", reason: "no-provider" });
});

test("Managed AI は予算の残っている間だけ選ばれる", async () => {
  const managed = { provider: provider("managed"), managed: true };

  const withinBudget = await selectAnalysisProvider([managed], {
    mode: "auto",
    managedCallsUsed: 1,
    budget: BUDGET,
  });
  expect(withinBudget).toEqual({ kind: "provider", provider: managed.provider });

  // 使い切った後は「使えない」ではなく「予算を使い切った」と区別する。
  // UI が「方法を変えれば続けられる」のか「何もできない」のかを
  // 利用者へ説明できるようにするため。
  const exhausted = await selectAnalysisProvider([managed], {
    mode: "auto",
    managedCallsUsed: 2,
    budget: BUDGET,
  });
  expect(exhausted).toEqual({ kind: "unavailable", reason: "budget-exhausted" });
});

// ---------------------------------------------------------------------------
// selectCalibrationCandidates
// ---------------------------------------------------------------------------

test("確認価値の高い Concept から上限数だけ選ぶ", () => {
  const familiarity: Record<string, ConceptFamiliarity> = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `go.c${i}`,
      {
        conceptId: `go.c${i}`,
        observationCount: i + 1,
        maxConfidence: 0.8,
        sources: [],
      },
    ]),
  );

  const picked = selectCalibrationCandidates({ familiarity, mastery: {} });

  // 頻繁に触れたものほど確認の価値が高い。全件を聞かない。
  expect(picked).toHaveLength(5);
  expect(picked[0]).toBe("go.c7");
});

test("既に confirmed の Concept は Calibration の対象から外す", () => {
  const familiarity: Record<string, ConceptFamiliarity> = {
    "go.a": { conceptId: "go.a", observationCount: 10, maxConfidence: 0.9, sources: [] },
    "go.b": { conceptId: "go.b", observationCount: 1, maxConfidence: 0.5, sources: [] },
  };

  const picked = selectCalibrationCandidates({
    familiarity,
    mastery: { "go.a": mastery("confirmed") },
  });

  // 確認済みのものを聞き直すのは利用者の手間を無駄にするだけ。
  expect(picked).toEqual(["go.b"]);
});

// ---------------------------------------------------------------------------
// suggestNextConcepts
// ---------------------------------------------------------------------------

test("最近触れていて未確定の Concept を次の候補として返す", () => {
  const familiarity: Record<string, ConceptFamiliarity> = {
    "go.a": {
      conceptId: "go.a",
      observationCount: 1,
      maxConfidence: 0.5,
      lastObservedAt: "2026-09-01T00:00:00Z",
      sources: [],
    },
    "go.b": {
      conceptId: "go.b",
      observationCount: 5,
      maxConfidence: 0.9,
      lastObservedAt: "2026-09-20T00:00:00Z",
      sources: [],
    },
  };

  const next = suggestNextConcepts({ familiarity, mastery: {} }, 1);

  // 「最近触れているのに確定していない」が次に学ぶ理由になる。
  expect(next).toEqual(["go.b"]);
});

test("confirmed の Concept は次の候補に含めない", () => {
  const familiarity: Record<string, ConceptFamiliarity> = {
    "go.a": {
      conceptId: "go.a",
      observationCount: 3,
      maxConfidence: 0.9,
      lastObservedAt: "2026-09-20T00:00:00Z",
      sources: [],
    },
  };

  expect(suggestNextConcepts({ familiarity, mastery: { "go.a": mastery("confirmed") } })).toEqual(
    [],
  );
});

// ---------------------------------------------------------------------------
// isProbablyProgrammingRelated
// ---------------------------------------------------------------------------

test("コードや開発用語を含む会話をプログラミング関連と判定する", () => {
  for (const text of [
    "Go の pointer receiver について教えて",
    "function foo() { return 1 } の意味は？",
    "npm install でエラーが出ます",
    "コンパイルエラーを直したい",
    "```go\nfmt.Println()\n```",
  ]) {
    expect(isProbablyProgrammingRelated(text)).toBe(true);
  }
});

test("プログラミングと無関係な会話は対象外にする", () => {
  for (const text of ["今日の夕飯のレシピを教えて", "この英文を翻訳して"]) {
    expect(isProbablyProgrammingRelated(text)).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// Import session の状態遷移
// ---------------------------------------------------------------------------

test("Import Session は定められた順序でしか遷移できない", () => {
  expect(canTransitionImportSession("scanning", "analyzing")).toBe(true);
  expect(canTransitionImportSession("analyzing", "ready_for_review")).toBe(true);
  expect(canTransitionImportSession("ready_for_review", "applied")).toBe(true);
  expect(canTransitionImportSession("applied", "undone")).toBe(true);

  // 解析結果の無いまま適用はできない。プレビューを経ない適用を型で塞ぐ。
  expect(canTransitionImportSession("scanning", "applied")).toBe(false);
  // 終端（undone / failed）からはどこへも戻れない。
  expect(canTransitionImportSession("undone", "scanning")).toBe(false);
  expect(canTransitionImportSession("failed", "analyzing")).toBe(false);
});
