import { describe, expect, it } from "vitest";
import {
  CHECK_MATERIAL_MAX_QUESTION_LENGTH,
  CHECK_MATERIAL_MAX_QUESTIONS,
  type LearningEvent,
} from "@gakushu-sochi/domain";
import { AI_USAGE_LIMITS, estimateInputTokens } from "../contract/ai-usage.js";
import {
  createInMemoryRepositoryStore,
  InMemoryConversationRepository,
  InMemoryLearningEventRepository,
} from "../repository/memory.js";
import { InMemoryUserSettingsRepository } from "../repository/user-settings.js";
import { fitQuestionsToInputLimit, solvedQuestionsFor, type MaterialSources } from "./material.js";
import { buildCheckPrompt, checkPromptInputFor, type CheckRequest } from "./prompt.js";

const CONCEPT_ID = "go.pointer_receiver";
const OBJECTIVE_ID = `${CONCEPT_ID}:copy`;
const USER_A = "auth0|user-a";
const USER_B = "auth0|user-b";

function sources(): MaterialSources {
  const store = createInMemoryRepositoryStore();
  return {
    events: new InMemoryLearningEventRepository(store),
    conversations: new InMemoryConversationRepository(store),
    settings: new InMemoryUserSettingsRepository(),
  };
}

/**
 * 本人が項目を自力解決した会話を、学習イベントと会話の両方に置く。
 * 「質問履歴の保存」も有効にする（会話が保存されるのは有効なときだけなので、実際の状態に揃える）。
 */
async function seedSolved(
  repos: MaterialSources,
  {
    userId = USER_A,
    conversationId,
    occurredAt,
    questions,
    type = "solved_independently",
    objectiveId = OBJECTIVE_ID,
  }: {
    userId?: string;
    conversationId: string;
    occurredAt: string;
    questions: string[];
    type?: LearningEvent["type"];
    objectiveId?: string;
  },
) {
  await repos.settings.put(userId, { saveConversationHistory: true }, occurredAt);
  const event: LearningEvent = {
    id: `event-${conversationId}`,
    occurredAt,
    type,
    origin: "vscode",
    conceptIds: [CONCEPT_ID],
    objectiveIds: [objectiveId],
    sessionId: conversationId,
  };
  await repos.events.append(userId, [
    { event, clientId: "vscode-1", receivedAtMs: Date.parse(occurredAt) },
  ]);
  await repos.conversations.upsert(
    userId,
    {
      id: conversationId,
      origin: "vscode",
      occurredAt,
      updatedAt: occurredAt,
      complete: true,
      messages: [
        { role: "context", text: "SELECTED-CODE-SECRET", at: occurredAt },
        ...questions.map((text) => ({ role: "user" as const, text, at: occurredAt })),
        { role: "assistant", text: "ASSISTANT-ANSWER", at: occurredAt },
      ],
    },
    Date.parse(occurredAt),
  );
}

describe("solvedQuestionsFor", () => {
  it("その項目で自力解決した会話の質問文だけを、新しい順に上限の件数まで返す", async () => {
    const repos = sources();
    for (const [index, day] of ["01", "02", "03", "04"].entries()) {
      await seedSolved(repos, {
        conversationId: `conv-${String(index)}`,
        occurredAt: `2026-09-${day}T00:00:00.000Z`,
        questions: [`質問${String(index)}`],
      });
    }

    const questions = await solvedQuestionsFor(repos, USER_A, OBJECTIVE_ID);

    expect(CHECK_MATERIAL_MAX_QUESTIONS).toBe(3);
    // 選択したコード（context）と AI の回答（assistant）は渡さない（#236 の決定）。
    expect(questions).toEqual(["質問3", "質問2", "質問1"]);
  });

  it("1つの会話の質問は、前後の空白を除いて改行でつなぎ、空の質問は捨てる", async () => {
    const repos = sources();
    await seedSolved(repos, {
      conversationId: "conv-1",
      occurredAt: "2026-09-01T00:00:00.000Z",
      questions: ["  最初の質問  ", "   ", "続きの質問"],
    });

    await expect(solvedQuestionsFor(repos, USER_A, OBJECTIVE_ID)).resolves.toEqual([
      "最初の質問\n続きの質問",
    ]);
  });

  it("質問は上限の文字数で切る", async () => {
    const repos = sources();
    await seedSolved(repos, {
      conversationId: "conv-long",
      occurredAt: "2026-09-01T00:00:00.000Z",
      questions: ["あ".repeat(CHECK_MATERIAL_MAX_QUESTION_LENGTH + 100)],
    });

    await expect(solvedQuestionsFor(repos, USER_A, OBJECTIVE_ID)).resolves.toEqual([
      "あ".repeat(CHECK_MATERIAL_MAX_QUESTION_LENGTH),
    ]);
  });

  it("「質問履歴の保存」を後から無効にした人の会話は、保存済みでも使わない", async () => {
    // 無効にしても保存済みの履歴は残る。同意の文面は「有効にしているときだけ」と約束している。
    const repos = sources();
    await seedSolved(repos, {
      conversationId: "conv-1",
      occurredAt: "2026-09-01T00:00:00.000Z",
      questions: ["保存済みの質問"],
    });
    await repos.settings.put(
      USER_A,
      { saveConversationHistory: false },
      "2026-09-02T00:00:00.000Z",
    );

    await expect(solvedQuestionsFor(repos, USER_A, OBJECTIVE_ID)).resolves.toEqual([]);
  });

  it("会話が残っていなければ材料は無い（失敗にしない）", async () => {
    const repos = sources();
    await seedSolved(repos, {
      conversationId: "conv-1",
      occurredAt: "2026-09-01T00:00:00.000Z",
      questions: ["質問"],
    });
    await repos.conversations.deleteAllByUser(USER_A);

    await expect(solvedQuestionsFor(repos, USER_A, OBJECTIVE_ID)).resolves.toEqual([]);
  });

  it("消えた会話の分は、次に新しい会話で埋める", async () => {
    const repos = sources();
    for (const [index, day] of ["01", "02", "03", "04"].entries()) {
      await seedSolved(repos, {
        conversationId: `conv-${String(index)}`,
        occurredAt: `2026-09-${day}T00:00:00.000Z`,
        questions: [`質問${String(index)}`],
      });
    }
    // 一番新しい会話だけ本文が無い（イベントだけ残っている）。
    await repos.conversations.deleteById(USER_A, "conv-3");

    await expect(solvedQuestionsFor(repos, USER_A, OBJECTIVE_ID)).resolves.toEqual([
      "質問2",
      "質問1",
      "質問0",
    ]);
  });

  it("自力解決でないイベントと、別の項目のイベントは使わない", async () => {
    const repos = sources();
    await seedSolved(repos, {
      conversationId: "conv-other-type",
      occurredAt: "2026-09-01T00:00:00.000Z",
      questions: ["答えを見た質問"],
      type: "answer_viewed",
    });
    await seedSolved(repos, {
      conversationId: "conv-other-objective",
      occurredAt: "2026-09-02T00:00:00.000Z",
      questions: ["別の項目の質問"],
      objectiveId: `${CONCEPT_ID}:choose`,
    });

    await expect(solvedQuestionsFor(repos, USER_A, OBJECTIVE_ID)).resolves.toEqual([]);
  });

  it("他人の会話は使わない", async () => {
    const repos = sources();
    await seedSolved(repos, {
      conversationId: "conv-1",
      occurredAt: "2026-09-01T00:00:00.000Z",
      questions: ["A さんの質問"],
    });
    await repos.settings.put(USER_B, { saveConversationHistory: true }, "2026-09-01T00:00:00.000Z");

    await expect(solvedQuestionsFor(repos, USER_B, OBJECTIVE_ID)).resolves.toEqual([]);
  });
});

describe("fitQuestionsToInputLimit", () => {
  const resolved = checkPromptInputFor(CONCEPT_ID);
  if (!resolved.ok) throw new Error(`入力を組み立てられなかった: ${resolved.reason}`);
  const input = resolved.input;
  const base: CheckRequest = {
    scope: "objective",
    level: "basic",
    objective: { id: OBJECTIVE_ID, label: "値レシーバには複製が渡る" },
    solvedQuestions: [],
  };
  const tokensWith = (questions: readonly string[]) =>
    estimateInputTokens(buildCheckPrompt(input, { ...base, solvedQuestions: questions }));
  const limit = AI_USAGE_LIMITS.inputTokensPerRequest;

  it("上限に収まるなら、そのまま返す", () => {
    const questions = ["質問2", "質問1"];

    expect(fitQuestionsToInputLimit(input, base, questions)).toEqual(questions);
  });

  it("収まらなければ、新しい質問から載せて、入らない古い質問を削る", () => {
    // 質問に使える予算の 6 割ずつにする。1件目は丸ごと入り、2件目は途中で切れ、3件目は入らない。
    const room = limit - tokensWith([""]);
    const long = (label: string) => label + "長".repeat(Math.floor((room * 0.6) / 3));
    const questions = [long("新"), long("中"), long("古")];

    const kept = fitQuestionsToInputLimit(input, base, questions);

    expect(tokensWith(kept)).toBeLessThanOrEqual(limit);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe(questions[0]);
    expect(kept[1]!.length).toBeLessThan(questions[1]!.length);
    expect(questions[1]!.startsWith(kept[1]!)).toBe(true);
  });

  it("文字の途中（サロゲートペアの間）で切らない", () => {
    const question = "𠮷".repeat(limit);

    const kept = fitQuestionsToInputLimit(input, base, [question]);

    expect(kept).toHaveLength(1);
    expect(tokensWith(kept)).toBeLessThanOrEqual(limit);
    expect(kept[0]!.length % 2).toBe(0);
    expect(kept[0]).toBe("𠮷".repeat(kept[0]!.length / 2));
  });

  it("見出しだけで予算を使い切るなら、質問を載せない", () => {
    const tooBig: CheckRequest = {
      ...base,
      objective: { id: OBJECTIVE_ID, label: "長".repeat(limit / 3) },
    };
    const overhead = estimateInputTokens(
      buildCheckPrompt(input, { ...tooBig, solvedQuestions: [""] }),
    );
    expect(overhead).toBeGreaterThanOrEqual(limit);

    expect(fitQuestionsToInputLimit(input, tooBig, ["質問"])).toEqual([]);
  });
});
