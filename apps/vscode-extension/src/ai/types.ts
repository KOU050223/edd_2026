/**
 * AI の共有契約は、Web と API からも利用できる domain package に置く。
 * この再 export は既存の拡張内 import を段階的に移行するための互換窓口。
 */
export type {
  AIAnswer,
  AIError,
  AIErrorReason,
  AIRequest,
  AIResponse,
  ConversationTurn,
  ProfileSummary,
} from "@gakushu-sochi/domain";
