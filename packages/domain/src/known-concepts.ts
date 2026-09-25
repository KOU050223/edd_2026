/**
 * ある入力に対して「既知の概念一覧」に載る Concept の絞り込み。
 *
 * 一覧へ載せた ID だけが抽出・分類の受理範囲になる。プロンプト方式の抽出
 * （apps/vscode-extension/src/ai/prompt）と Jev による分類
 * （apps/api/src/routes/ai-concept-scores.ts）が同じ集合を見るため、
 * ここが唯一の実装である。
 */

import { CONCEPTS } from "./concepts.generated.js";
import type { Concept } from "./profile.js";

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
 * この `languageId` の「既知の概念一覧」に載る Concept。
 *
 * 言語の Concept は languageId と一致するものだけに絞る。git や db のような
 * 領域の Concept は languageId に対応付かないため、有無に関わらず常に載せる。
 * languageId が取れない入力（クリップボード経由など）でも領域横断は対象になる。
 */
export function knownConceptsFor(languageId: string | undefined): readonly Concept[] {
  return CONCEPTS.filter(
    (concept) =>
      CROSS_DOMAIN_PREFIXES.has(concept.language) ||
      (languageId !== undefined && concept.language === conceptLanguageFor(languageId)),
  );
}
