/**
 * 確認問題（Concept 1つにつき2問1組）の型。
 *
 * 出題形式の正典は #43（Web/02）である。1 Concept につき次の2問を1組で出題し、
 * **2問とも正解した場合のみ**その Concept を理解したとみなす。
 *
 * 1. 概要問題: その概念の意味を問う
 * 2. 実践問題: 例示コードに対する具体的な問題
 *
 * 実践問題が「実コード」ではなく例示コードなのは、利用者のコード本文を保存していないため
 * （#184）。AI が例示コードごと生成する形へ読み替えてある。
 *
 * この型は API（生成・検証）とクライアント（出題・採点）で共有する。
 * **生成の入力に利用者個人の情報は入らない**ので、ここに `status` / `score` /
 * `evidence` に相当するものを持たせてはならない。問題は全利用者で共有できる
 * 静的コンテンツであり、それが #185 で 1 Concept 1組を使い回せる前提になっている。
 */

import type { ConceptId } from "./profile.js";

/** 出題の種別。並びは出題順を兼ねる。 */
export type CheckQuestionKind = "overview" | "practice";

/**
 * 出題順に並べた種別。
 *
 * 種別を増やすと「2問とも正解で理解済み」（#43）の判定が変わるため、
 * ここへ足すだけで済む変更ではない。
 */
export const CHECK_QUESTION_KINDS: readonly CheckQuestionKind[] = ["overview", "practice"];

/**
 * 1問の構造的な上限。生成の指示・応答の検証・画面の描画が同じ値を見る。
 *
 * 上限を置くのは、AI の応答が長文や大量の選択肢になったときに、
 * そのまま保存・描画してしまわないため。**超過は切り詰めず拒否する**（RULE-004）。
 */
export const CHECK_LIMITS = {
  /** 選択肢の数。増減させない。正解は必ず1つである。 */
  choiceCount: 4,
  /** 設問文の最大文字数。 */
  promptMaxLength: 400,
  /** 選択肢1つの最大文字数。 */
  choiceMaxLength: 200,
  /** 実践問題の例示コードの最大文字数。 */
  codeMaxLength: 1_200,
  /** 解説の最大文字数。 */
  explanationMaxLength: 400,
} as const;

/** 4択1問。 */
export interface CheckQuestion {
  /** 設問文。答えそのものを含めない。 */
  prompt: string;
  /**
   * 選択肢。**並びが答えの位置を決める**ため、表示側で並べ替えてはならない。
   * 長さは {@link CHECK_LIMITS.choiceCount} に固定する。
   */
  choices: readonly string[];
  /** 正解の添字（0 始まり）。`choices` の範囲内であることを受理時に検証する。 */
  answerIndex: number;
  /** 回答後に見せる解説。なぜその選択肢が正解なのかを述べる。 */
  explanation: string;
}

/** 例示コードを題材にする実践問題。コードを持たない実践問題は成立しない。 */
export interface PracticeCheckQuestion extends CheckQuestion {
  /**
   * 設問が指す例示コード。
   *
   * 言語の指定は持たせていない。`ConceptId` のプレフィックスで大半は決まるが、
   * `git` / `design` / `db` / `http` の Concept では言語にならないため、
   * 強調表示のヒントが実際に必要になった画面で足す。
   */
  code: string;
}

/**
 * ある Concept の確認問題1組。
 *
 * 2問を配列ではなく別のフィールドで持つ。配列にすると「1問しか無い組」を
 * 型として表現できてしまい、#43 の「2問1組」を呼び出し側の検査に頼ることになる。
 */
export interface ConceptCheck {
  conceptId: ConceptId;
  /** 概要問題。 */
  overview: CheckQuestion;
  /** 実践問題。 */
  practice: PracticeCheckQuestion;
  /** 生成に使ったモデル。問題の出所を追えるように残す。 */
  model?: string;
  /** 生成時刻。ISO 8601 形式。Concept の定義が変わった後の扱い（#185）に使う。 */
  generatedAt?: string;
}

/**
 * 出題順に2問を取り出す。
 *
 * 種別ごとの見出しを付けて描画する側と、2問を同じ規則で検証する側が、
 * それぞれ `overview` / `practice` を並べ直さずに済むようにする。
 * 採点（2問とも正解のときだけ理解済み）は #43 が持つ。
 */
export function checkQuestionsOf(
  check: ConceptCheck,
): readonly { kind: CheckQuestionKind; question: CheckQuestion }[] {
  return [
    { kind: "overview", question: check.overview },
    { kind: "practice", question: check.practice },
  ];
}
