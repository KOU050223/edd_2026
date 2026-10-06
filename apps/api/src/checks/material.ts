/**
 * 確認問題の材料（本人が自力解決した質問）を集め、プロンプトの入力上限に収める。
 *
 * 材料を送ってよいか（生成の同意）は呼び出し元（`checks/generate.ts`）が先に確かめる。
 */

import {
  CHECK_MATERIAL_MAX_QUESTION_LENGTH,
  CHECK_MATERIAL_MAX_QUESTIONS,
} from "@gakushu-sochi/domain";
import { AI_USAGE_LIMITS, estimateInputTokens } from "../contract/ai-usage.js";
import type {
  ConversationRepository,
  LearningEventRepository,
  UserSettingsRepository,
} from "../repository/types.js";
import { buildCheckPrompt, type CheckRequest } from "./prompt.js";

export interface MaterialSources {
  events: LearningEventRepository;
  conversations: ConversationRepository;
  settings: UserSettingsRepository;
}

/**
 * 狙う項目で本人が自力解決した質問を、新しい順に上限まで集める。
 *
 * 学習イベントの `sessionId` が会話 ID である（#233）。会話が無い（保存していない、
 * または消した）なら材料は無い。それは失敗ではなく、通常の1組を作る（#236 の決定 3）。
 *
 * **「質問履歴の保存」を今無効にしている人の会話は、保存済みでも使わない。** 無効にしても
 * 保存済みの履歴は残る（`CONSENT_NOTICE_DETAIL`）が、無効にした人は自分の履歴を使ってほしくない
 * と読むのが自然で、生成の同意の文面（`CHECK_GENERATION_NOTICE`）もそう約束している。
 * 渡すのは**質問文（`user`）だけ**で、選択テキスト（`context`）と回答（`assistant`）は渡さない。
 */
export async function solvedQuestionsFor(
  sources: MaterialSources,
  userId: string,
  objectiveId: string,
): Promise<string[]> {
  const settings = await sources.settings.get(userId);
  if (settings?.saveConversationHistory !== true) return [];

  const events = await sources.events.listByUser(userId);
  const sessionIds: string[] = [];
  // listByUser は発生時刻の昇順なので、後ろから見ると新しい順になる。
  for (const event of [...events].reverse()) {
    if (
      event.type === "solved_independently" &&
      event.sessionId !== undefined &&
      event.objectiveIds?.includes(objectiveId) === true &&
      !sessionIds.includes(event.sessionId)
    ) {
      sessionIds.push(event.sessionId);
    }
  }

  const questions: string[] = [];
  for (const sessionId of sessionIds) {
    if (questions.length >= CHECK_MATERIAL_MAX_QUESTIONS) break;
    const conversation = await sources.conversations.getById(userId, sessionId);
    if (conversation === null) continue;
    const text = conversation.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text.trim())
      .filter((message) => message.length > 0)
      .join("\n");
    if (text.length === 0) continue;
    questions.push(text.slice(0, CHECK_MATERIAL_MAX_QUESTION_LENGTH));
  }
  return questions;
}

/**
 * 自力解決した質問を、プロンプト全体が1回あたりの入力上限に収まる長さまで削る。
 *
 * 質問は新しい順に並んでいる。新しいものから残りの予算の分だけ載せ、入らなくなったら
 * 古いものを落とす。上限で 500 にすると、同じ履歴からは何度試しても作れなくなる。
 * 見積もりは UTF-8 のバイト数（`estimateInputTokens`）なので、削るのもバイト数で行う。
 */
export function fitQuestionsToInputLimit(
  input: Parameters<typeof buildCheckPrompt>[0],
  base: CheckRequest,
  questions: readonly string[],
): string[] {
  const limit = AI_USAGE_LIMITS.inputTokensPerRequest;
  const fits = (candidate: readonly string[]) =>
    estimateInputTokens(buildCheckPrompt(input, { ...base, solvedQuestions: candidate })) <= limit;
  if (fits(questions)) return [...questions];

  const kept: string[] = [];
  for (const question of questions) {
    // 区切りと見出しの分は、空の質問を載せたプロンプトで測る。
    const overhead = estimateInputTokens(
      buildCheckPrompt(input, { ...base, solvedQuestions: [...kept, ""] }),
    );
    const room = limit - overhead;
    if (room <= 0) break;
    const trimmed = truncateToBytes(question, room);
    if (trimmed.length === 0) break;
    kept.push(trimmed);
  }
  return kept;
}

/** 文字の途中で切らずに、UTF-8 で `maxBytes` バイト以内へ収める。 */
function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}
