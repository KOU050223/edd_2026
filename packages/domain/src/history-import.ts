/**
 * 外部 AI 履歴からの学習の引き継ぎ（Issue #157）に関する契約。
 *
 * このファイルは profile.ts と同じく、VS Code・HTTP・DB・特定 AI SDK・
 * ファイルシステムのいずれにも依存しない。Adapter の実装（ファイルを読む、
 * CLI を叩く）は apps/desktop などの各クライアントが持ち、ここには
 * 境界を通るデータの形と、環境を問わず共有すべき判定だけを置く。
 *
 * 設計の正本は Issue #157 で、要点は次の通り。
 *
 * - Raw History（会話本文）は端末内で処理し、サーバーへ残すのは
 *   Learning Map の構築に必要な {@link LearningEvidence} だけにする。
 * - 外部履歴は既存の LearningEvent（VS Code 等での実際の学習行動）とは
 *   別の根拠として扱う。「過去に触れた」（Familiarity）と
 *   「現在理解している」（Mastery）を混ぜない。
 * - Provider の違いは Adapter の内側に閉じ込め、Domain 側へ漏らさない。
 *   Provider は必ず AnalysisResult を返し、Concept への対応付けと
 *   Evidence 化は Normalizer（evidence.ts）が担う。
 */

import type { ConceptId } from "./profile.js";

// ---------------------------------------------------------------------------
// History source
// ---------------------------------------------------------------------------

/**
 * 履歴を提供する AI / 環境の識別子。
 *
 * 分析を依頼する AI（AnalysisProvider）とは別の軸である。
 * 「Claude Code に書いた履歴」を「Codex が分析する」という組み合わせが
 * 成立するため、どちらの値を取るかをフィールド名で区別する。
 */
export type HistoryProviderId =
  "codex" | "chatgpt" | "claude-code" | "claude" | "copilot" | "cursor" | "gemini" | "vscode";

/**
 * 履歴を取り込んだ経路。
 *
 * 同じ Provider の履歴でも、常駐アプリの自動スキャンと
 * ユーザーが選んだエクスポートファイルでは来歴の意味が違うため分ける。
 */
export type EvidenceImportedBy = "desktop" | "agent" | "file" | "connector";

/**
 * HistorySourceAdapter が見つけた生の会話。
 *
 * 本文を持つが、これは Domain の正本にしない。分析の入力として端末内で
 * 使われ、正規化された {@link LearningEvidence} だけが永続化される。
 */
export interface RawConversation {
  /** Adapter が採番する、ソース内で一意な ID。 */
  sourceId: string;
  /** 会話が行われた時刻（取れる場合）。ISO 8601 のオフセット付き date-time。 */
  observedAt?: string;
  /** 会話のタイトルや先頭の話題。プレビューと分析の手がかりに使う。 */
  title?: string;
  /**
   * 会話本文。呼び出し側（Adapter / 前処理）で個人情報・ファイルパスを
   * 除去したものを渡す。生の履歴をそのまま AI やサーバーへ送らない。
   */
  body: string;
  /**
   * 出典の指紋。同じ会話が別のソースにも残っている場合に、
   * ローカルで重複候補をまとめるための照合キー。
   */
  externalRefHash?: string;
}

/** HistorySourceAdapter.detect() の結果。 */
export interface HistorySourceDetection {
  /** このソースが利用できるか（ファイル群が存在する、CLI が入っている等）。 */
  available: boolean;
  /** 見つかった会話数の見込み。検出時点で数えられない場合は省略する。 */
  estimatedCount?: number;
  /** 利用者向けの補足。未対応の理由や、見つかった保存先の説明など。 */
  detail?: string;
}

/**
 * 履歴の保存場所・形式を吸収する Adapter。
 *
 * Provider 本体（分析を担う AI）から分離されているのは、保存形式や
 * パスの変更を Domain 側へ波及させないためである。実装は環境依存なので
 * このパッケージには置かず、各クライアント（現時点では apps/desktop）が持つ。
 */
export interface HistorySourceAdapter {
  readonly provider: HistoryProviderId;
  /** 利用可能かを調べる。ファイルの実読み込みは scan に委ね、ここは軽く保つ。 */
  detect(): Promise<HistorySourceDetection>;
  /**
   * 会話を順に返す。全件をメモリに載せないため AsyncIterable にする。
   *
   * `sinceMs` を渡すと、それ以降に更新された分だけを返す（増分同期）。
   * Adapter が増分に対応できない形式の場合は全体を返してよい。
   * その場合の重複は呼び出し側の externalRefHash で除く。
   *
   * 読み飛ばした行や壊れたファイルは `onWarning` で報告する。
   * 黙って捨てると「履歴があるのに0件」に見える（RULE-004）。
   */
  scan(options?: {
    sinceMs?: number;
    onWarning?: (warning: string) => void;
  }): AsyncIterable<RawConversation>;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** 外部履歴における学習行動の種別。LearningEventType とは別の分類である。 */
export type EvidenceKind =
  /** 質問した。 */
  | "question"
  /** エラーや不具合の解決を試みた。 */
  | "debugging"
  /** 概念や仕組みの説明を求めた。 */
  | "explanation"
  /** 実装を依頼した、または実装方針を議論した。 */
  | "implementation"
  /** 動作確認やレビューを依頼した。 */
  | "verification";

/**
 * AnalysisProvider が返す1件の観測。
 *
 * `conceptCandidates` は Concept ID とは限らない。Provider は
 * 「Concept 一覧に無い話題」を無理やり近い Concept へ押し込まず、
 * 自然言語の候補のまま返してよい。Concept ID への対応付けと
 * unmapped の判定は Normalizer（evidence.ts）の責務である。
 */
export interface HistoryObservation {
  /** 分析対象として渡した {@link RawConversation.sourceId} と同じ値。 */
  sourceId: string;
  /** 概念の候補。Concept ID または自然言語の名前。 */
  conceptCandidates: string[];
  kind: EvidenceKind;
  /** 会話が行われた時刻（分かる場合）。ISO 8601。 */
  observedAt?: string;
  /** 0.0〜1.0 の確からしさ。範囲外の値は Normalizer が棄却する。 */
  confidence: number;
  /** Provider が出典を特定できる場合の指紋。 */
  externalRefHash?: string;
}

/** AnalysisProvider の返り値。自由文ではなく構造化した観測の列である。 */
export interface HistoryAnalysisResult {
  observations: HistoryObservation[];
  /**
   * Provider の出力のうち、構造が合わず落とした観測の件数。
   * 黙って捨てないための計数。取れない Provider は省略してよい。
   */
  droppedObservations?: number;
}

/** AnalysisProvider への入力。 */
export interface AnalysisInput {
  /** 分析対象の会話。前処理済みのものを渡す。 */
  conversations: readonly RawConversation[];
  /**
   * 分類先として知っている Concept ID。
   * 一覧に無い話題を既存 Concept へ押し込まないために、
   * Provider はこれを「選んでよい候補」として扱う。
   */
  knownConceptIds: readonly ConceptId[];
}

/**
 * 分析を担う AI の Adapter。交換可能であることが前提。
 *
 * Provider が直接 Learner Profile や Learning Map を書き換えてはならない。
 * 必ず HistoryAnalysisResult を返し、Normalizer を通る（Issue #157）。
 */
export interface AnalysisProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  analyze(input: AnalysisInput): Promise<HistoryAnalysisResult>;
}

/**
 * Managed AI の使用量の上限。
 *
 * 「100% 分類するために無限に AI を使う」設計を防ぐための明示的な予算。
 * Auto モードでも、この枠を超えて判断不能なものを埋める推論は行わない。
 */
export interface AnalysisBudget {
  /** 1回のインポートで使ってよい Managed AI の呼び出し回数。 */
  managedAiMaxCalls: number;
  /** 使ってよいトークン数の上限（分かる場合）。 */
  managedAiMaxTokens?: number;
}

/**
 * 分析方法。利用者向けの選択肢に対応する。
 *
 * - `auto`: 利用できるユーザー所有 AI を優先し、必要な場合のみ Managed AI。
 * - `user-ai`: ユーザー所有の AI だけを使う。Managed AI は呼ばない。
 * - `managed`: Managed AI を使う。
 */
export type AnalysisMode = "auto" | "user-ai" | "managed";

// ---------------------------------------------------------------------------
// Learning Evidence
// ---------------------------------------------------------------------------

/**
 * 外部履歴から正規化された、学習の根拠1件。
 *
 * LearningEvent と同じ意味では持たせない。「VS Code でエラーを自力解決した」
 * ことと「3年前に ChatGPT へ質問した」ことは別の根拠である。
 * 会話本文そのものは含まず、Concept・種別・時刻・確からしさ・来歴だけを持つ。
 */
export interface LearningEvidence {
  /** Evidence の一意な ID。Import 単位で追跡できるよう、Session ID を含める。 */
  id: string;
  /** 対象の Concept。対応付けられなかった話題は unmapped として別に残し、ここには入らない。 */
  conceptIds: ConceptId[];
  /** どのソースから、どの経路で取り込まれたか。 */
  source: {
    provider: HistoryProviderId;
    importedBy: EvidenceImportedBy;
  };
  kind: EvidenceKind;
  /** 会話が行われた時刻（分かる場合）。ISO 8601。 */
  observedAt?: string;
  /** 0.0〜1.0 の確からしさ。 */
  confidence: number;
  /** どの Import の一部として取り込まれたか。Undo の単位になる。 */
  importSessionId?: string;
  /** 出典の指紋。複数ソースでの二重計上を抑えるための照合キー。 */
  externalRefHash?: string;
}

// ---------------------------------------------------------------------------
// Import session
// ---------------------------------------------------------------------------

/**
 * Import の状態遷移。
 *
 * Issue #157 の流れ（scanning → analyzing → ready_for_review → confirmed →
 * applied）に、失敗と取り消しを表す状態を足したもの。
 *
 * - `failed`: スキャンや分析の失敗を表に出すための状態。これが無いと
 *   中断した Import が永遠に `analyzing` のまま残り、失敗と進行中を
 *   区別できない（RULE-004）。
 * - `undone`: 適用済みの Import を取り消した記録。Evidence は消えるが、
 *   「いつ取り込んで、いつ戻したか」の来歴は残る。
 */
export type ImportSessionStatus =
  "scanning" | "analyzing" | "ready_for_review" | "confirmed" | "applied" | "undone" | "failed";

/** 許可される状態遷移。 */
export const IMPORT_SESSION_TRANSITIONS: Record<
  ImportSessionStatus,
  readonly ImportSessionStatus[]
> = {
  scanning: ["analyzing", "failed"],
  analyzing: ["ready_for_review", "failed"],
  // Preview を確認した結果、Calibration を挟む（confirmed）か、
  // そのまま適用（applied）するかは呼び出し側の流れに任せる。
  ready_for_review: ["confirmed", "applied", "failed"],
  confirmed: ["applied", "failed"],
  applied: ["undone"],
  undone: [],
  failed: [],
};

/** `from` から `to` への遷移が許可されるか。 */
export function canTransitionImportSession(
  from: ImportSessionStatus,
  to: ImportSessionStatus,
): boolean {
  return IMPORT_SESSION_TRANSITIONS[from].includes(to);
}

/**
 * 1回の Import の実行単位。
 *
 * 解析した瞬間に Learning Map を書き換えないため、Evidence の適用とは
 * 独立した状態を持つ。Undo は importSessionId を手がかりに行う。
 */
export interface ImportSession {
  id: string;
  status: ImportSessionStatus;
  /** 取り込みの経路。 */
  importedBy: EvidenceImportedBy;
  /** 開始時刻。ISO 8601。 */
  createdAt: string;
  /** 最終更新時刻。ISO 8601。 */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Familiarity
// ---------------------------------------------------------------------------

/**
 * 外部履歴での「触れた形跡」の集計。Concept ごとに1つ持つ。
 *
 * Mastery（現在理解しているか）とは別の軸である。外部履歴からは
 * 「過去に何度も触れた」ことは分かっても「現在理解している」とは限らない
 * ため、Evidence は Familiarity を育てるだけで Mastery を確定させない
 * （Issue #157「Mastery と Familiarity を分けて考える」）。
 */
export interface ConceptFamiliarity {
  conceptId: ConceptId;
  /** 観測された Evidence の件数。 */
  observationCount: number;
  /** 最後に触れた時刻（分かる場合）。ISO 8601。 */
  lastObservedAt?: string;
  /** 観測の中で最大の confidence。 */
  maxConfidence: number;
  /**
   * ソースごとの内訳。「なぜこの状態か」の説明に使う
   * （例: Codex で7件・最後に触れたのは9日前）。
   * 並びは provider 名の昇順で固定し、導出結果を一意にする。
   */
  sources: {
    provider: HistoryProviderId;
    count: number;
    lastObservedAt?: string;
  }[];
}

/**
 * Learning Map 上での Concept の表示状態。
 *
 * Mastery と Familiarity を合成した、利用者向けの段階。
 * Issue #157 の「未観測 / 過去に触れた形跡あり / 学習中 / 確認済み」に対応する。
 */
export type LearningMapStatus = "unobserved" | "familiar" | "learning" | "confirmed";
