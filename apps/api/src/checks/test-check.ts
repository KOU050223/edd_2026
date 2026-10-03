/**
 * テスト用の保存済み確認問題。退会・学習データの削除が問題を巻き込まないことを
 * 確かめるテストで使う（#185）。
 */

import type { StoredConceptCheck } from "../repository/types.js";
import { CHECK_FORMAT_VERSION } from "./cache.js";

export function storedCheck(conceptId: string): StoredConceptCheck {
  const question = {
    prompt: `${conceptId} の概要問題`,
    choices: ["選択肢1", "選択肢2", "選択肢3", "選択肢4"],
    answerIndex: 0,
    explanation: "選択肢1が正解である理由。",
  };
  return {
    check: {
      conceptId,
      overview: question,
      practice: { ...question, prompt: `${conceptId} の実践問題`, code: "example()" },
      model: "gemini-3.6-flash",
      generatedAt: "2026-09-01T00:00:00.000Z",
    },
    formatVersion: CHECK_FORMAT_VERSION,
    promptSha256: "0".repeat(64),
  };
}
