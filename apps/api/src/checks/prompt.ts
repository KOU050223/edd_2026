/**
 * 確認問題を生成させるプロンプトの組み立て（#184）。
 *
 * **入力は Concept の定義だけである。** 利用者個人の情報（`status` / `score` /
 * `evidence` / `diagnosticCode` / 手動上書き）と、コード本文・質問文・AI の回答文は
 * 一切渡さない。生成した問題を全利用者で使い回す（#185）ための前提であり、
 * 個人に依存する入力を1つ混ぜた時点で「1 Concept 1組で全員分が揃う」が崩れる。
 *
 * 学習データが効くのは「どの Concept を出題するか」の選択だけで、それは #43 が持つ。
 *
 * 描画も HTTP も知らない純粋な関数として置く。プロンプトはプロダクトの出題方針
 * そのものなので、このファイルだけを読めば何を頼んでいるか分かるようにする。
 */

import { CHECK_LIMITS, CONCEPTS, type Concept, type ConceptId } from "@gakushu-sochi/domain";

/** 例示コードの行数の上限。文字数の上限（{@link CHECK_LIMITS}）と対で効かせる。 */
const CODE_MAX_LINES = 15;

/** プロンプトへ載せる Concept の情報。ここに無いものは AI へ渡らない。 */
export interface CheckPromptInput {
  id: ConceptId;
  label: string;
  /** ID のプレフィックス。`go` のような言語と、`git` のような領域の両方がありうる。 */
  language: string;
  summary: string;
  /** 前提 Concept の表示名。 */
  prerequisiteLabels: readonly string[];
  /** この Concept を前提に持つ Concept（次に接続する Concept）の表示名。 */
  nextLabels: readonly string[];
}

/**
 * プロンプトの入力を組み立てられなかった理由。
 *
 * 呼び出し側が応答を選び分けられるように、理由を型で返す。
 * `unknown-concept` は要求した側の誤りだが、`summary-missing` は
 * リポジトリの定義の不備なので、同じ扱いにしてはならない。
 */
export type CheckPromptInputFailure = "unknown-concept" | "summary-missing";

export type CheckPromptInputResult =
  { ok: true; input: CheckPromptInput } | { ok: false; reason: CheckPromptInputFailure };

/**
 * `conceptId` から、そのままプロンプトへ載せられる入力を引く。
 *
 * 既知の 148 件以外は受理しない。ここが「歯止め」の一部である（#184）。
 * 生成は `ai_usage` の回数上限の対象外なので、宛先の集合が有限であることが
 * 生成回数の上界になっている。
 *
 * `concepts` を差し替えられるのはテストのためである。本番は既定の {@link CONCEPTS}
 * （`concepts.md` から生成した一覧）しか使わない。
 */
export function checkPromptInputFor(
  conceptId: string,
  concepts: readonly Concept[] = CONCEPTS,
): CheckPromptInputResult {
  const concept = concepts.find((candidate) => candidate.id === conceptId);
  if (!concept) {
    return { ok: false, reason: "unknown-concept" };
  }
  const summary = concept.summary?.trim();
  if (!summary) {
    // 表示名1行だけで生成すると、問題の粒度と深さが Concept ごとにばらける。
    // 足りない入力で走らせず、定義の不備として扱う（RULE-004）。
    return { ok: false, reason: "summary-missing" };
  }

  return {
    ok: true,
    input: {
      id: concept.id,
      label: concept.label,
      language: concept.language,
      summary,
      prerequisiteLabels: labelsOf(concept.prerequisites ?? [], concepts),
      nextLabels: labelsOf(
        concepts
          .filter((candidate) => candidate.prerequisites?.includes(concept.id))
          .map((candidate) => candidate.id),
        concepts,
      ),
    },
  };
}

/**
 * ID の並びを表示名の並びへ直す。定義に無い ID は落とす。
 *
 * `apps/web` の `linkConcepts` と同じ関係（前提と、次に接続する Concept）を見るが、
 * API から Web App のモジュールを import はしない。表示のための配置計算まで
 * 引き込むことになり、依存の向きが逆になる。
 */
function labelsOf(ids: readonly ConceptId[], concepts: readonly Concept[]): string[] {
  return ids.flatMap((id) => {
    const label = concepts.find((candidate) => candidate.id === id)?.label;
    return label ? [label] : [];
  });
}

function listOrNone(labels: readonly string[]): string {
  return labels.length > 0 ? labels.join(" / ") : "なし";
}

/**
 * 概要問題・実践問題の2問1組を作らせるプロンプト。
 *
 * 出力は JSON 1つに限定する。本文へ添えた説明や ``` の囲みは、
 * 受理側（`response.ts`）が剥がさずに拒否するため、ここで明示的に禁じる。
 */
export function buildCheckPrompt(input: CheckPromptInput): string {
  return [
    "あなたは Gakushu Sochi の確認問題を作る出題者です。",
    "1つの概念について、利用者がそれを理解できたかを測る4択問題を、概要問題と実践問題の2問1組で作ってください。",
    "",
    "--- 対象の概念 ---",
    `ID: ${input.id}`,
    `表示名: ${input.label}`,
    `領域: ${input.language}`,
    `概要: ${input.summary}`,
    `前提の概念: ${listOrNone(input.prerequisiteLabels)}`,
    `次に接続する概念: ${listOrNone(input.nextLabels)}`,
    "",
    "--- 出題の方針 ---",
    "概要問題: この概念が何であり、どう振る舞うかを問う。コードは載せない。",
    `実践問題: 短い例示コードを自分で書き、そのコードについて問う。コードは ${CODE_MAX_LINES} 行以内にする。`,
    "例示コードは領域に合わせて書く。領域が git / db / design / http のようにプログラミング言語でない場合は、" +
      "その領域で実際に書くもの（コマンド、SQL、リクエストなど）を例示にする。",
    "上の「概要」に書かれた範囲を出題の的にする。概念の外側にある知識を前提にしない。",
    "前提の概念は既に理解しているものとして扱い、次に接続する概念は出題しない。",
    "利用者の習熟度は渡していない。難易度を調整せず、この概念を理解した直後の人が解ける水準で固定する。",
    "誤答の選択肢には、この概念でありがちな誤解を書く。明らかに無関係な選択肢で埋めない。",
    "「上記のすべて」「いずれでもない」のような選択肢は作らない。",
    "設問文と選択肢に答えを書かない。解説には、なぜその選択肢が正解なのかを書く。",
    "すべて日本語で書く。",
    "",
    "--- 出力形式 ---",
    "次の形の JSON を1つだけ出力する。前後に説明文やコードブロックの囲みを付けない。",
    JSON.stringify({
      conceptId: input.id,
      overview: {
        prompt: "概要問題の設問文",
        choices: ["選択肢1", "選択肢2", "選択肢3", "選択肢4"],
        answerIndex: 0,
        explanation: "概要問題の解説",
      },
      practice: {
        prompt: "実践問題の設問文",
        code: "例示コード",
        choices: ["選択肢1", "選択肢2", "選択肢3", "選択肢4"],
        answerIndex: 0,
        explanation: "実践問題の解説",
      },
    }),
    `conceptId は ${input.id} をそのまま入れる。`,
    `choices はちょうど ${String(CHECK_LIMITS.choiceCount)} 個で、正解はちょうど1つにする。`,
    "answerIndex は choices の添字（0 始まり）で、正解の位置を指す。",
    "文字数の上限: 設問文 " +
      `${String(CHECK_LIMITS.promptMaxLength)}、選択肢 ${String(CHECK_LIMITS.choiceMaxLength)}、` +
      `例示コード ${String(CHECK_LIMITS.codeMaxLength)}、解説 ${String(CHECK_LIMITS.explanationMaxLength)}。`,
  ].join("\n");
}
