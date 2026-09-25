import { describe, expect, it } from "vitest";

import type { Concept, RawConversation } from "@gakushu-sochi/domain";

import { createLocalRuleProvider } from "./local-rules.js";

const CONCEPTS: Concept[] = [
  { id: "go.pointer_receiver", label: "値レシーバとポインタレシーバ", language: "go" },
  { id: "go.error_handling", label: "error 型と if err != nil", language: "go" },
  { id: "ts.type_narrowing", label: "型の絞り込み", language: "ts" },
];

function conv(body: string): RawConversation {
  return { sourceId: "s1", body };
}

describe("createLocalRuleProvider", () => {
  it("is always available", async () => {
    const provider = createLocalRuleProvider(CONCEPTS);
    expect(await provider.isAvailable()).toBe(true);
  });

  it("matches concepts by ID suffix tokens", async () => {
    const provider = createLocalRuleProvider(CONCEPTS);
    const result = await provider.analyze({
      conversations: [conv("go の pointer receiver について教えて")],
      knownConceptIds: CONCEPTS.map((c) => c.id),
    });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.conceptCandidates).toContain("go.pointer_receiver");
  });

  it("matches concepts by label text", async () => {
    const provider = createLocalRuleProvider(CONCEPTS);
    const result = await provider.analyze({
      conversations: [conv("型の絞り込みについての説明")],
      knownConceptIds: CONCEPTS.map((c) => c.id),
    });
    expect(result.observations[0]?.conceptCandidates).toContain("ts.type_narrowing");
  });

  it("produces no observation for unrelated conversations", async () => {
    const provider = createLocalRuleProvider(CONCEPTS);
    const result = await provider.analyze({
      conversations: [conv("今日の夕飯のレシピを教えて")],
      knownConceptIds: CONCEPTS.map((c) => c.id),
    });
    expect(result.observations).toHaveLength(0);
  });

  it("does not treat a bare language name as evidence of any concept", async () => {
    const provider = createLocalRuleProvider(CONCEPTS);
    const result = await provider.analyze({
      // "golang" は言語の別表記。Concept 固有の語が無いので
      // go.* のどの Concept の形跡にもしてはいけない。
      conversations: [conv("golang で遊んでみた話")],
      knownConceptIds: CONCEPTS.map((c) => c.id),
    });
    expect(result.observations).toHaveLength(0);
  });

  it("respects knownConceptIds as the allowed candidate set", async () => {
    const provider = createLocalRuleProvider(CONCEPTS);
    const result = await provider.analyze({
      conversations: [conv("pointer receiver と error handling")],
      knownConceptIds: ["go.error_handling"],
    });
    const candidates = result.observations[0]?.conceptCandidates ?? [];
    expect(candidates).toContain("go.error_handling");
    expect(candidates).not.toContain("go.pointer_receiver");
  });

  it("sorts candidates by hit count descending", async () => {
    const provider = createLocalRuleProvider(CONCEPTS);
    // error_handling は "error" と "err" の2トークンが当たる想定
    const result = await provider.analyze({
      conversations: [conv("error と err と pointer の話")],
      knownConceptIds: CONCEPTS.map((c) => c.id),
    });
    const candidates = result.observations[0]?.conceptCandidates ?? [];
    expect(candidates[0]).toBe("go.error_handling");
  });

  it("infers debugging kind for error-heavy text", async () => {
    const provider = createLocalRuleProvider(CONCEPTS);
    const result = await provider.analyze({
      conversations: [conv("panic: runtime error が出た。pointer receiver 周りかも")],
      knownConceptIds: CONCEPTS.map((c) => c.id),
    });
    expect(result.observations[0]?.kind).toBe("debugging");
  });

  it("propagates observedAt and externalRefHash", async () => {
    const provider = createLocalRuleProvider(CONCEPTS);
    const result = await provider.analyze({
      conversations: [
        {
          sourceId: "s1",
          body: "pointer receiver の話",
          observedAt: "2024-01-01T00:00:00Z",
          externalRefHash: "abc",
        },
      ],
      knownConceptIds: CONCEPTS.map((c) => c.id),
    });
    expect(result.observations[0]?.observedAt).toBe("2024-01-01T00:00:00Z");
    expect(result.observations[0]?.externalRefHash).toBe("abc");
  });
});
