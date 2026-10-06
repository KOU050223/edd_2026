import type { LearningObjective } from "@gakushu-sochi/domain";
import type {
  AiUsageRepository,
  AuditLogRepository,
  CheckGenerationConsentRepository,
  ConversationRepository,
  IdentityRepository,
  LearningEventRepository,
  PersonalCheckRepository,
  UserSettingsRepository,
} from "../repository/types.js";

/** 確認問題のルート（`routes/checks.ts`）と生成（`checks/generate.ts`）が使う依存。 */
export interface ChecksDeps {
  apiKey?: string;
  model?: string;
  /**
   * 順に試すモデル（`vars.CHECK_MODELS`、#268）。先頭が一時的な失敗なら、待たずに次へ送る。
   * 省略・空なら {@link model} だけを使う。
   */
  models?: readonly string[];
  fetch: typeof fetch;
  /** 生成した問題の保存先。利用者ごと（migrations/0012_user_concept_checks.sql）。 */
  checks: PersonalCheckRepository;
  consents: CheckGenerationConsentRepository;
  /** 自力解決した質問を探すために読む。 */
  events: LearningEventRepository;
  /** 自力解決した会話の本文。「質問履歴の保存」を有効にした人の分だけがある。 */
  conversations: ConversationRepository;
  /** 「質問履歴の保存」が今も有効かを見る。無効なら保存済みの会話も材料にしない。 */
  settings: UserSettingsRepository;
  /** `ai_usage.user_id` は `users(id)` を参照するので、数える前に行を用意する。 */
  usage: AiUsageRepository;
  identity: IdentityRepository;
  audit: AuditLogRepository;
  /**
   * 回数上限（日 15・月 150）を効かせるか。省略は効かせる。
   *
   * テスト中だけ外す（`vars.CHECK_GENERATION_LIMITS: "off"`、#255 で戻す）。外しても回数と
   * トークン量は記録し、月のトークン量の安全弁とレート制限は効かせたままにする。
   */
  enforceUsageLimits?: boolean;
  /** 上流の一時的な失敗のあとの待ち時間。省略は `UPSTREAM_RETRY_DELAYS_MS`。テストで縮める。 */
  retryDelaysMs?: readonly number[];
  /** 「理解すること」の一覧。生成の口ができるまではモック（#224）。テストで差し替える。 */
  objectives?: readonly LearningObjective[];
  now: () => Date;
}
