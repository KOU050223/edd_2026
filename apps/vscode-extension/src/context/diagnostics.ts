/** VS Code の Position と互換な、比較に必要な最小の座標。 */
interface PositionLike {
  line: number;
  character: number;
}

/** VS Code の Range と互換な、比較に必要な最小の範囲。 */
interface RangeLike {
  start: PositionLike;
  end: PositionLike;
}

function comparePositions(left: PositionLike, right: PositionLike): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.character - right.character;
}

function isEmptyRange(range: RangeLike): boolean {
  return comparePositions(range.start, range.end) === 0;
}

function containsPosition(range: RangeLike, position: PositionLike): boolean {
  return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

/**
 * 2つの範囲に空でない共通部分があるか判定する。
 *
 * 終端だけが接する場合は、ユーザーがそのDiagnosticを選択していないため false にする。
 *
 * 長さ0の範囲（位置だけを指すDiagnostic）は共通部分を持ちえないので、
 * その位置がもう一方の範囲に含まれるかで判定する。両端も含める。
 * 文字と文字の間を指す位置なので、端にあっても選択の外にははみ出さない。
 * 行末の「; が必要」のような位置は選択の終端に来やすく、落とすと拾えない。
 */
export function rangesOverlap(left: RangeLike, right: RangeLike): boolean {
  if (isEmptyRange(left)) {
    return containsPosition(right, left.start);
  }
  if (isEmptyRange(right)) {
    return containsPosition(left, right.start);
  }
  return comparePositions(left.start, right.end) < 0 && comparePositions(right.start, left.end) < 0;
}

/** 再発判定に必要な、VS Code の Diagnostic と互換な最小の形。 */
export interface DiagnosticLike {
  message: string;
  source?: string;
  code?: string | number | { value: string | number };
}

/**
 * 「同じエラー」を識別するキーを作る。docs/concepts.md の「同じエラーの同一性」を参照。
 *
 * - `code` があれば `source` と組にして使う（例: `code:ts:2345`）。
 *   `code` は発生元ごとの名前空間なので、`source` を外すと TypeScript の番号と
 *   ESLint のルール名のような別物が衝突しうる。
 * - `code` が無ければ、正規化した `message` を使う（例: `message:ts:...`）。
 *
 * ファイル名と行番号は含めない。編集で動くため、同じ誤りを別物と判定してしまう。
 */
export function errorKeyOf(diagnostic: DiagnosticLike): string {
  const source = diagnostic.source ?? "";
  const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
  if (code !== undefined && String(code) !== "") {
    return `code:${source}:${String(code)}`;
  }
  return `message:${source}:${normalizeDiagnosticMessage(diagnostic.message)}`;
}

/** 同期 API が受け付ける `diagnosticCode` の最大長（apps/api/src/contract/learning-event.ts）。 */
const MAX_DIAGNOSTIC_CODE_LENGTH = 128;

/**
 * 識別キーのうち、サーバーへ送ってよい部分（`LearningEvent.diagnosticCode`）を返す。
 *
 * メッセージ由来のキーは送らない。正規化しても利用者のコード片が残りうるため、
 * ローカルの再発判定だけに使う。
 *
 * API の上限を超えるものも付けない。付けるとイベントごと拒否され、再発の記録
 * そのものがサーバーへ届かなくなる。欠けるのは補助情報だけで、習熟度は
 * `type` と `conceptIds` から導出される。
 */
export function diagnosticCodeOfKey(key: string): string | undefined {
  if (!key.startsWith("code:")) {
    return undefined;
  }
  const code = key.slice("code:".length);
  return code.length <= MAX_DIAGNOSTIC_CODE_LENGTH ? code : undefined;
}

/**
 * メッセージから、同じ誤りでも出現ごとに変わる部分を落とす。
 *
 * 引用された識別子や型（`'foo'`、`"bar"`、`` `baz` ``）と数値は、変数名や
 * 行数に応じて変わるため、プレースホルダへ置き換える。
 */
export function normalizeDiagnosticMessage(message: string): string {
  return message
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "_")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}
