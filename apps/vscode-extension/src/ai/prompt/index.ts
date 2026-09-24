import { CONCEPTS, type AIRequest, type Concept } from "@gakushu-sochi/domain";

/** 応答本文の末尾に付けさせる、表示しないメタ情報の開始マーカー。 */
export const META_MARKER = "<<code-companion-meta>>";

const SYSTEM_PROMPT = `あなたは Gakushu Sochi の学習支援コンパニオンです。
利用者が次回はAIなしでも理解・解決できるように、考え方と確認方法を教えてください。
完成したコードを提示することを基本方針にしません。質問の情報だけで確定できないことは推測で埋めず、前提と確認方法を示してください。
入力はコードとは限らないため、技術用語、エラー文、コメント、Markdownの文章にも、その入力に合う形で回答してください。`;

/** VS Code の languageId を、Concept の言語プレフィックスへ対応付ける。 */
function conceptLanguageFor(languageId: string): string {
  // TypeScript と JavaScript の共通概念は、習熟度が分散しないよう ts.* に統一する。
  return languageId === "typescript" || languageId === "javascript" ? "ts" : languageId;
}

/**
 * ファイルの言語に依らず質問されうる領域の Concept プレフィックス。
 * languageId と一致する Concept に加えて常に一覧へ載せる。
 * 言語ではない領域を concepts.md へ追加したらここへも登録する（docs/concepts.md）。
 */
const CROSS_DOMAIN_PREFIXES: ReadonlySet<string> = new Set(["db", "design", "git", "http"]);

/**
 * このリクエストの「既知の概念一覧」に載る Concept。
 *
 * 一覧へ載せた ID だけが抽出の受理範囲になる。応答のパース側もこの結果で
 * フィルタするため、プロンプトと受理範囲がずれることはない。
 */
export function knownConceptsFor(request: AIRequest): readonly Concept[] {
  // 言語の Concept は languageId と一致するものだけに絞る。git や db のような
  // 領域の Concept は languageId に対応付かないため、有無に関わらず常に載せる。
  const languageId = request.context.languageId;
  return CONCEPTS.filter(
    (concept) =>
      CROSS_DOMAIN_PREFIXES.has(concept.language) ||
      (languageId !== undefined && concept.language === conceptLanguageFor(languageId)),
  );
}

function presetInstruction(request: AIRequest): string[] {
  if (request.diagnostics && request.diagnostics.length > 0) {
    return [
      "### Error Explain",
      "エラーを解説する。なぜエラーになるか、どこを確認すべきか、次に試すことを順に説明してください。",
      "修正済みの完成コードは出さず、利用者が自分で直せる確認手順を示してください。",
    ];
  }

  if (request.mode === "hint") {
    return [
      "### Hint",
      "会話履歴があれば、それまでに示した内容を繰り返さず、次に試す一手だけを示してください。完成したコードを出さないでください。",
    ];
  }

  return [
    "### Explain",
    "意味、なぜそうなるのか、どこを確認すれば理解できるかを説明してください。完成したコードを提示しないでください。",
  ];
}

/**
 * 利用者が実際に書いた質問を取り出す。空白だけのものは質問と見なさない。
 *
 * `extension.ts` は `[context:...]` を取り除いた残り全部を `question` に渡すため、
 * 利用者が文脈だけを送った場合でも改行や空白が残る。これを質問として扱うと、
 * 中身の無い「質問」が preset より優先されてしまう。
 */
function userQuestionOf(request: AIRequest): string | undefined {
  const question = request.question?.trim();
  return question ? question : undefined;
}

/**
 * AIRequest を、VS Code Language Model に送る単一のユーザープロンプトへ変換する。
 *
 * Prompt はプロダクトの学習方針そのものなので、このディレクトリだけを編集すれば
 * 方針・preset・文脈の渡し方をレビューできるようにする。
 */
export function buildPrompt(request: AIRequest): string {
  const question = userQuestionOf(request);

  // 利用者が質問を書いたなら、それを preset の前に置く。preset を先頭に置くと
  // 「コードを解説せよ」という強い指示が先に立ち、質問が他の付加情報と同列に
  // 埋もれて無視されることがある（#50）。質問が無いときの並びは変えない。
  const lines = question
    ? [
        SYSTEM_PROMPT,
        "",
        "--- 質問 ---",
        question,
        "",
        "--- 最優先の指示 ---",
        "上の「質問」が利用者の本当の要求です。まずこの質問に答えてください。",
        "以下の指示と文脈は、その回答を組み立てるための補足です。質問より優先しないでください。",
        "質問が選択コードの解説を求めていないなら、解説を返さず、質問されたことに答えてください。",
        "ただし優先順位が変わるのは「何に答えるか」だけです。「どう答えるか」（完成コードを提示せず、",
        "自分で理解・解決できるように導く方針）は質問より優先され、質問によって解除されません。",
        "",
        ...presetInstruction(request),
        "",
        "--- 選択箇所 ---",
        request.context.code,
      ]
    : [
        SYSTEM_PROMPT,
        "",
        ...presetInstruction(request),
        "",
        "--- 選択箇所 ---",
        request.context.code,
      ];

  if (request.context.contextLevel === 1) {
    lines.push(
      "",
      "--- 文脈の制約 ---",
      "前後の文脈や位置情報がありません。前提不足を明示し、断定せず、確認したい情報も伝えてください。",
    );
  } else {
    lines.push("", "--- 前後のコード ---", request.context.surroundingCode);
  }

  if (request.context.definitions && request.context.definitions.length > 0) {
    lines.push(
      "",
      "--- 参照した定義 ---",
      ...request.context.definitions.map(
        (definition) =>
          `${definition.fileName}:${definition.startLine + 1}${definition.symbol ? ` (${definition.symbol})` : ""}\n${definition.code}`,
      ),
    );
  }

  if (request.diagnostics && request.diagnostics.length > 0) {
    lines.push("", "--- 関連するエラー ---", ...request.diagnostics);
  }

  const knownConcepts = knownConceptsFor(request);
  if (knownConcepts.length > 0) {
    lines.push(
      "",
      "--- 既知の概念一覧（id: 説明） ---",
      ...knownConcepts.map((concept) => `${concept.id}: ${concept.label}`),
    );
  }

  lines.push(
    "",
    "--- 出力形式 ---",
    `本文を書き終えたら、必ず最後に ${META_MARKER} という行を書き、続けてJSONを1つだけ書いてください。`,
    '形式: {"conceptIds": ["関係する概念のID。分からなければ空配列"], "resolution": "resolved か unclear"}',
    knownConcepts.length > 0
      ? "conceptIds には、上記の「既知の概念一覧」に載っているIDの中から今回の話題に一致するものだけを入れてください。一覧に無い概念を無理に当てはめず、一致するものが無ければ空配列にしてください。"
      : "この言語向けの既知の概念一覧が無いため、conceptIds は空配列にしてください。",
  );

  if ((request.history?.length ?? 0) > 0) {
    lines.push(
      'resolution には、これまでの会話（履歴）を踏まえて、直前までの説明で扱っていた疑問が今回のユーザーの発言で解消されたと判断できるなら "resolved"、まだそう判断できないなら "unclear" を入れてください。',
    );
  } else {
    lines.push("これが最初のやり取りで判断材料が無いため、resolution キーは省略してください。");
  }

  return lines.join("\n");
}
