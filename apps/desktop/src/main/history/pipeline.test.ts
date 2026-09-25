import { describe, expect, it } from "vitest";

import type {
  AnalysisProvider,
  Concept,
  HistorySourceAdapter,
  RawConversation,
} from "@gakushu-sochi/domain";

import { createLocalRuleProvider } from "./local-rules.js";
import { mergePastedAnalysis, runImportPipeline, type ImportProgress } from "./pipeline.js";

const CONCEPTS: Concept[] = [
  { id: "go.pointer_receiver", label: "値レシーバとポインタレシーバ", language: "go" },
  { id: "go.error_handling", label: "error 型と if err != nil", language: "go" },
];

function adapterWith(
  provider:
    "codex" | "claude-code" | "vscode" | "chatgpt" | "claude" | "copilot" | "cursor" | "gemini",
  conversations: RawConversation[],
): HistorySourceAdapter {
  return {
    provider,
    detect: () => Promise.resolve({ available: true }),
    scan: () =>
      (async function* () {
        for (const conversation of conversations) yield conversation;
      })(),
  };
}

function failingAdapter(provider: "codex"): HistorySourceAdapter {
  return {
    provider,
    detect: () => Promise.resolve({ available: true }),
    scan: () =>
      (async function* () {
        throw new Error("disk read failed");
        yield undefined as never;
      })(),
  };
}

function aiProvider(
  id: string,
  result: {
    observations: {
      sourceId: string;
      conceptCandidates: string[];
      kind: "question";
      confidence: number;
    }[];
  },
): AnalysisProvider {
  return {
    id,
    isAvailable: () => Promise.resolve(true),
    analyze: () => Promise.resolve(result),
  };
}

/** 入力チャンクの各会話に対して1件ずつ観測を返す Provider。 */
function echoProvider(id: string, candidate: string): AnalysisProvider {
  return {
    id,
    isAvailable: () => Promise.resolve(true),
    analyze: (input) =>
      Promise.resolve({
        observations: input.conversations.map((conversation) => ({
          sourceId: conversation.sourceId,
          conceptCandidates: [candidate],
          kind: "question" as const,
          confidence: 0.9,
        })),
      }),
  };
}

const BUDGET = { managedAiMaxCalls: 5 };

describe("runImportPipeline", () => {
  it("covers keyword-matched conversations with local rules only", async () => {
    const { preview } = await runImportPipeline({
      adapters: [
        adapterWith("codex", [
          { sourceId: "a", body: "go の pointer receiver について教えて。error handling も。" },
        ]),
      ],
      localProvider: createLocalRuleProvider(CONCEPTS),
      aiProviders: [
        {
          provider: {
            id: "unused",
            isAvailable: () => Promise.resolve(true),
            analyze: () => Promise.reject(new Error("AI should not be called")),
          },
          managed: false,
        },
      ],
      mode: "auto",
      budget: BUDGET,
      concepts: CONCEPTS,
      importedBy: "desktop",
      sessionId: "s-1",
    });
    expect(preview.evidence).toHaveLength(1);
    expect(preview.conceptSummaries.map((c) => c.conceptId)).toEqual([
      "go.error_handling",
      "go.pointer_receiver",
    ]);
    expect(preview.analyzersUsed).toEqual([]);
    expect(preview.unanalyzedCount).toBe(0);
  });

  it("falls back to an AI provider for conversations local rules miss", async () => {
    const { preview } = await runImportPipeline({
      adapters: [
        adapterWith("claude-code", [{ sourceId: "b", body: "kubernetes の pod が起動しない" }]),
      ],
      localProvider: createLocalRuleProvider(CONCEPTS),
      aiProviders: [
        {
          provider: aiProvider("cli", {
            observations: [
              {
                sourceId: "b",
                conceptCandidates: ["kubernetes"],
                kind: "question",
                confidence: 0.7,
              },
            ],
          }),
          managed: false,
        },
      ],
      mode: "auto",
      budget: BUDGET,
      concepts: CONCEPTS,
      importedBy: "desktop",
      sessionId: "s-1",
    });
    // "kubernetes" は Concept 一覧に無い → Evidence ではなく unmapped。
    expect(preview.evidence).toHaveLength(0);
    expect(preview.unmapped).toEqual([{ sourceId: "b", candidate: "kubernetes" }]);
    expect(preview.analyzersUsed).toEqual(["cli"]);
    expect(preview.unanalyzedCount).toBe(0);
  });

  it("marks conversations unanalyzed when no AI provider is usable", async () => {
    const { preview } = await runImportPipeline({
      adapters: [
        adapterWith("codex", [{ sourceId: "c", body: "kubernetes pod の起動に失敗する" }]),
      ],
      localProvider: createLocalRuleProvider(CONCEPTS),
      aiProviders: [
        {
          provider: {
            id: "cli",
            isAvailable: () => Promise.resolve(false),
            analyze: () => Promise.reject(),
          },
          managed: false,
        },
      ],
      mode: "auto",
      budget: BUDGET,
      concepts: CONCEPTS,
      importedBy: "desktop",
      sessionId: "s-1",
    });
    expect(preview.unanalyzedCount).toBe(1);
    expect(preview.evidence).toHaveLength(0);
  });

  it("does not call managed providers in user-ai mode", async () => {
    const { preview } = await runImportPipeline({
      adapters: [
        adapterWith("codex", [{ sourceId: "d", body: "kubernetes pod の起動に失敗する" }]),
      ],
      localProvider: createLocalRuleProvider(CONCEPTS),
      aiProviders: [
        {
          provider: aiProvider("managed", {
            observations: [
              {
                sourceId: "d",
                conceptCandidates: ["go.error_handling"],
                kind: "question",
                confidence: 0.9,
              },
            ],
          }),
          managed: true,
        },
      ],
      mode: "user-ai",
      budget: BUDGET,
      concepts: CONCEPTS,
      importedBy: "desktop",
      sessionId: "s-1",
    });
    expect(preview.managedCallsUsed).toBe(0);
    expect(preview.unanalyzedCount).toBe(1);
  });

  it("stops using managed AI when the budget is exhausted", async () => {
    const conversations = Array.from({ length: 51 }, (_, i) => ({
      sourceId: `e${String(i)}`,
      body: `kubernetes pod ${String(i)} の起動に失敗する`,
    }));
    const { preview } = await runImportPipeline({
      adapters: [adapterWith("codex", conversations)],
      localProvider: createLocalRuleProvider(CONCEPTS),
      aiProviders: [{ provider: echoProvider("managed", "go.error_handling"), managed: true }],
      mode: "auto",
      // 50件/チャンク × 1回分の予算だけ。2チャンク目は使えない。
      budget: { managedAiMaxCalls: 1 },
      concepts: CONCEPTS,
      importedBy: "desktop",
      sessionId: "s-1",
    });
    expect(preview.managedCallsUsed).toBe(1);
    expect(preview.unanalyzedCount).toBe(1);
    expect(preview.evidence).toHaveLength(50);
  });

  it("continues when a source scan fails and reports a warning", async () => {
    const { preview } = await runImportPipeline({
      adapters: [
        failingAdapter("codex"),
        adapterWith("claude-code", [{ sourceId: "f", body: "go の pointer receiver の話" }]),
      ],
      localProvider: createLocalRuleProvider(CONCEPTS),
      aiProviders: [],
      mode: "auto",
      budget: BUDGET,
      concepts: CONCEPTS,
      importedBy: "desktop",
      sessionId: "s-1",
    });
    expect(preview.warnings.some((w) => w.includes("codex"))).toBe(true);
    expect(preview.evidence).toHaveLength(1);
  });

  it("filters non-programming conversations before analysis", async () => {
    const { preview } = await runImportPipeline({
      adapters: [
        adapterWith("codex", [
          { sourceId: "g1", body: "今日の夕飯の献立を考えて" },
          { sourceId: "g2", body: "go の pointer receiver とは何か" },
        ]),
      ],
      localProvider: createLocalRuleProvider(CONCEPTS),
      aiProviders: [],
      mode: "auto",
      budget: BUDGET,
      concepts: CONCEPTS,
      importedBy: "desktop",
      sessionId: "s-1",
    });
    expect(preview.ignoredCount).toBe(1);
    expect(preview.conversationCount).toBe(1);
  });

  it("dedupes identical conversations across sources", async () => {
    const body = "go の pointer receiver の説明";
    const { preview } = await runImportPipeline({
      adapters: [
        adapterWith("codex", [{ sourceId: "h1", body }]),
        adapterWith("claude-code", [{ sourceId: "h2", body }]),
      ],
      localProvider: createLocalRuleProvider(CONCEPTS),
      aiProviders: [],
      mode: "auto",
      budget: BUDGET,
      concepts: CONCEPTS,
      importedBy: "desktop",
      sessionId: "s-1",
    });
    // ソースをまたいだ重複は会話単位で除かれる。
    expect(preview.duplicateCount).toBe(1);
  });

  it("reports progress for each scanned provider", async () => {
    const progress: ImportProgress[] = [];
    await runImportPipeline({
      adapters: [
        adapterWith("codex", [{ sourceId: "i1", body: "go の pointer receiver" }]),
        adapterWith("vscode", [{ sourceId: "i2", body: "go の pointer receiver" }]),
      ],
      localProvider: createLocalRuleProvider(CONCEPTS),
      aiProviders: [],
      mode: "auto",
      budget: BUDGET,
      concepts: CONCEPTS,
      importedBy: "desktop",
      sessionId: "s-1",
      onProgress: (p) => progress.push(p),
    });
    expect(progress.filter((p) => p.phase === "scanning")).toHaveLength(2);
  });

  it("passes sinceMs through to adapters for incremental scans", async () => {
    let seenSince: number | undefined;
    const adapter: HistorySourceAdapter = {
      provider: "codex",
      detect: () => Promise.resolve({ available: true }),
      scan: (options) => {
        seenSince = options?.sinceMs;
        return (async function* () {
          yield { sourceId: "j", body: "go の pointer receiver" } satisfies RawConversation;
        })();
      },
    };
    await runImportPipeline({
      adapters: [adapter],
      localProvider: createLocalRuleProvider(CONCEPTS),
      aiProviders: [],
      mode: "auto",
      budget: BUDGET,
      concepts: CONCEPTS,
      importedBy: "desktop",
      sessionId: "s-1",
      sinceMs: 9_999,
    });
    expect(seenSince).toBe(9_999);
  });
});

describe("mergePastedAnalysis", () => {
  it("merges pasted observations into the preview and removes them from pending", async () => {
    const pending = new Map([
      [
        "codex" as const,
        [
          { sourceId: "p1", body: "kubernetes pod の起動に失敗する" },
          { sourceId: "p2", body: "kubernetes の service が公開されない" },
        ],
      ],
    ]);
    const preview = {
      sessionId: "s-1",
      importedBy: "desktop" as const,
      providers: ["codex" as const],
      conversationCount: 2,
      duplicateCount: 0,
      ignoredCount: 0,
      sanitized: {},
      localCoveredCount: 0,
      unanalyzedCount: 2,
      evidence: [],
      familiarity: {},
      conceptSummaries: [],
      unmapped: [],
      rejected: [],
      warnings: [],
      analyzersUsed: [],
      managedCallsUsed: 0,
    };
    const merged = mergePastedAnalysis({
      preview,
      pending,
      result: {
        observations: [
          {
            sourceId: "p1",
            conceptCandidates: ["go.error_handling"],
            kind: "question",
            confidence: 0.8,
          },
          // この Import に属さない sourceId は捨てる
          { sourceId: "foreign", conceptCandidates: ["x"], kind: "question", confidence: 0.5 },
        ],
      },
      concepts: CONCEPTS,
    });
    expect(merged.preview.evidence).toHaveLength(1);
    expect(merged.preview.evidence[0]?.conceptIds).toEqual(["go.error_handling"]);
    expect(merged.preview.warnings.some((w) => w.includes("属さない"))).toBe(true);
    expect(merged.preview.unanalyzedCount).toBe(1);
    expect([...(merged.remaining.get("codex") ?? [])].map((c) => c.sourceId)).toEqual(["p2"]);
  });
});
