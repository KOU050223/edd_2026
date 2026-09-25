/**
 * Learner Profile のスキーマ定義。
 *
 * このファイルは VS Code API を含む一切のモジュールに依存しない。
 * AI / UI / context の各モジュールが並行して参照する共有契約であり、
 * ここに import を増やすと変更のたびに全モジュールが巻き込まれる。
 */

// ---------------------------------------------------------------------------
// Concept
// ---------------------------------------------------------------------------

/**
 * 学習概念の識別子。`<prefix>.<concept>` 形式の文字列。
 * prefix は言語（`go` / `ts` / `python` …）か、言語を横断する領域
 * （`git` / `design` / `db` / `http`）を表す。
 *
 * 例: `go.pointer_receiver` / `ts.type_narrowing` / `git.rebase`
 *
 * literal union にはしない。union にすると未登録の Concept を扱うコードが
 * コンパイルできず、Concept を追加するたびにこのファイルが全 PR の衝突点になる。
 * 妥当性は {@link CONCEPT_ID_PATTERN} と {@link isConceptId} で検査する。
 */
export type ConceptId = string;

/** {@link ConceptId} の形式。小文字英数の領域プレフィックス + `.` + 小文字英数とアンダースコア。 */
export const CONCEPT_ID_PATTERN = /^[a-z0-9]+\.[a-z0-9_]+$/;

/** 文字列が {@link ConceptId} の命名規則を満たすかを判定する。 */
export function isConceptId(value: string): value is ConceptId {
  return CONCEPT_ID_PATTERN.test(value);
}

/**
 * Concept 体系の出所。
 *
 * docs/idea.md の「教材・エディタ・AIの組み合わせはユーザーごとに異なる」に対応する。
 * MVP では手で定義した Go の Concept しか持たないため実質 `manual` 固定だが、
 * 後から roadmap.sh や教材由来の Concept を混ぜても version を上げずに済むよう
 * 最初からフィールドを空けておく。
 */
export type ConceptSourceKind = "manual" | "roadmap.sh" | "course" | "book" | "docs";

export interface ConceptSource {
  kind: ConceptSourceKind;
  /** 出所内での参照先。roadmap.sh のノード ID や教材のセクション番号など。 */
  ref?: string;
  /** 人間が辿れる URL。 */
  url?: string;
}

/** 学習概念の定義。一覧の正典は packages/domain/concepts.md で、この型はその表現形式。 */
export interface Concept {
  id: ConceptId;
  /** 表示名。例: `ポインタレシーバ` */
  label: string;
  /** `id` のプレフィックスと一致する領域識別子。例: `go` / `git`（プログラミング言語とは限らない） */
  language: string;
  /**
   * 1〜2文の説明。UI での補足表示と、確認問題を生成するときの AI への入力に使う（#184）。
   *
   * `packages/domain/concepts.md` の全行が持ち（空欄は `npm run check:concepts` が落とす）、
   * 一覧から生成した {@link CONCEPTS} では常に埋まっている。型で必須にしていないのは、
   * 手で組み立てる Concept（テストの題材や、将来の外部由来の一覧）まで
   * 巻き込まないためである。**省略された Concept の確認問題は生成しない。**
   * 表示名1行だけを入力に生成すると、問題の粒度が Concept ごとにばらける。
   */
  summary?: string;
  /**
   * 前提となる Concept。Skill Tree の辺にあたる。
   * MVP では自動生成せず packages/domain/concepts.md の表で手で定義する。
   */
  prerequisites?: ConceptId[];
  source: ConceptSource;
}

// ---------------------------------------------------------------------------
// Learning Event
// ---------------------------------------------------------------------------

/**
 * 学習イベントの種別。
 *
 * docs/idea.md の「質問数は補助指標として扱い、自力解決の成功、
 * 同じエラーの再発減少、確認問題の正答などと組み合わせて Map へ反映する」に対応し、
 * 習熟度への寄与が異なるものを別種別として区別する。
 */
export type LearningEventType =
  /** 質問した。習熟度を上げる根拠にはならない。 */
  | "question_asked"
  /** ヒントを見た。答えの閲覧より弱い依存。 */
  | "hint_used"
  /** 答えを見た。自力解決には至らなかった。 */
  | "answer_viewed"
  /** ヒントの後に自力で解決した。習熟度を上げる主要な根拠。 */
  | "solved_independently"
  /** 同じ Concept のエラーが再発した。習熟度を下げる根拠。 */
  | "error_recurred"
  /** 確認問題に正答した。 */
  | "check_passed"
  /** 確認問題に誤答した。 */
  | "check_failed";

/**
 * イベントの観測元。
 *
 * Concept の出所（{@link ConceptSource}）とは別の軸。
 * 「roadmap.sh で学ぶ概念に、VS Code で詰まった」のように直交する。
 * MVP では `vscode` のみだが、GitHub や Web を後から繋いでも
 * 既存イベントを書き換えずに済むよう最初から持たせる。
 */
export type EventOrigin = "vscode" | "github" | "web" | "cli";

/** 1件の学習イベント。追記のみで、あとから書き換えない。 */
export interface LearningEvent {
  /** イベントの一意な ID。 */
  id: string;
  /** 発生時刻。ISO 8601 形式の文字列。globalState は Date を復元しないため string で持つ。 */
  occurredAt: string;
  type: LearningEventType;
  origin: EventOrigin;
  /**
   * 関連する Concept。
   * 質問から Concept を抽出できなかった場合は空配列になりうる。
   * 1つの質問が複数 Concept にまたがることがあるため配列で持つ。
   */
  conceptIds: ConceptId[];
  /** 対象コードの言語識別子。例: `go` */
  language?: string;
  /** 関連する Diagnostic のコード。同じエラーの再発判定に使う。 */
  diagnosticCode?: string;
  /**
   * 一連のやり取りをまとめる ID。
   * Hint → 自力解決 の流れを、独立した2件ではなく1つの試行として辿れるようにする。
   */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Mastery
// ---------------------------------------------------------------------------

/**
 * 習熟度の状態。
 *
 * docs/idea.md の「根拠が少ない段階で理解度を断定せず、
 * 『未観測』『学習中』『確認済み』といった状態と確信の理由を示す」に対応する。
 * score だけでは「根拠が乏しくて 0.5」と「根拠が揃った上で 0.5」を区別できないため、
 * status と evidence を必ず併せて持つ。
 */
export type MasteryStatus =
  /** 一度も観測されていない。score は参考値にならない。 */
  | "unobserved"
  /** 観測はあるが、確認済みと言える根拠が足りない。 */
  | "learning"
  /** 自力解決や確認問題の正答が積み上がっている。 */
  | "confirmed";

/**
 * status ごとに `score` が取りうる範囲。
 *
 * status と score を独立に導出すると「確認済みなのに 45%」のような
 * 矛盾した表示が生まれる。score は必ずこの範囲へクランプする。
 */
export const MASTERY_SCORE_RANGE: Record<MasteryStatus, { min: number; max: number }> = {
  unobserved: { min: 0, max: 0 },
  learning: { min: 0, max: 0.69 },
  confirmed: { min: 0.7, max: 1 },
};

/**
 * 習熟度を支える根拠の集計。
 *
 * 「何回 AI を使ったか」ではなく「何を理解したか」を示すため、
 * status と score をこの数値から導けるようにする。UI の
 * 「Pointer 学習中（Hintで2回解決）」のような表示もここを参照する。
 */
export interface MasteryEvidence {
  questionCount: number;
  hintCount: number;
  answerViewCount: number;
  solvedIndependentlyCount: number;
  errorRecurrenceCount: number;
  checkPassedCount: number;
  checkFailedCount: number;
  /**
   * 直近のイベント種別の並び（古い順）。長さの上限は docs/concepts.md を参照。
   *
   * 累積カウントだけでは「再発したが、その後に自力解決を重ねた」状態を表現できず、
   * 一度の再発で `confirmed` へ戻れなくなる。直近の並びを保持して、
   * 最近のふるまいで status を判定できるようにする。
   */
  recentTypes: LearningEventType[];
  /** 直近で観測したイベントの時刻。ISO 8601 形式。 */
  lastObservedAt?: string;
}

/** ある Concept に対する現在の習熟度。 */
export interface ConceptMastery {
  conceptId: ConceptId;
  status: MasteryStatus;
  /**
   * 0.0〜1.0 の習熟度スコア。
   *
   * status と矛盾しないよう {@link MASTERY_SCORE_RANGE} の範囲へクランプする。
   * status が `unobserved` の場合は 0 だが、これは「習熟度が低い」ではなく
   * 「判断材料がない」を意味するため、そのまま 0% として表示してはならない。
   * 更新ルールは docs/concepts.md に定義する。
   */
  score: number;
  evidence: MasteryEvidence;
}

// ---------------------------------------------------------------------------
// Learner Profile
// ---------------------------------------------------------------------------

/**
 * 現在の Learner Profile スキーマバージョン。
 *
 * 破壊的変更を加えるときにインクリメントする。
 * 判断基準と移行手順は docs/concepts.md を参照。
 */
export const LEARNER_PROFILE_VERSION = 1;

/**
 * 学習者のプロファイル。globalState に単一キーで保存する。
 *
 * Date や Map を含めない。globalState は JSON として直列化するため、
 * それらは読み戻したときにプレーンオブジェクトになり型と実体がずれる。
 */
export interface LearnerProfile {
  /** スキーマバージョン。読み込み時に必ず検査する。 */
  version: number;
  /** 最終更新時刻。ISO 8601 形式。 */
  updatedAt: string;
  /**
   * Concept ID をキーにした習熟度。
   * 配列ではなく辞書にして、ID による参照を O(1) かつ重複不能にする。
   *
   * 値が `undefined` を含むのは意図的である。`ConceptId` が string である以上、
   * 未観測の ID やタイプミスした ID での参照が必ず起きる。
   * tsconfig に noUncheckedIndexedAccess が無いため、型で undefined を明示しないと
   * `mastery[id].score` がコンパイルを通り実行時に落ちる。
   */
  mastery: Record<ConceptId, ConceptMastery | undefined>;
  /**
   * 学習イベントの履歴。新しいものを末尾に追加する。
   * 保存上限と切り詰め方針は docs/concepts.md を参照。
   */
  events: LearningEvent[];
}

/** イベントも習熟度も持たない初期プロファイルを作る。 */
export function createEmptyProfile(now: string): LearnerProfile {
  return {
    version: LEARNER_PROFILE_VERSION,
    updatedAt: now,
    mastery: {},
    events: [],
  };
}
