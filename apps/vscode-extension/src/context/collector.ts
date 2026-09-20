import * as vscode from "vscode";
import type {
  CodeContext,
  ContextLevel,
  ContextSource,
  ExternalDefinition,
} from "@gakushu-sochi/domain";

/**
 * 選択範囲の前後に含める行数。
 *
 * 選択範囲だけでは判断できないコード（使われている変数の宣言が選択範囲の外にあるなど）を
 * 拾うために必要だが、増やすほどトークンを食う。宣言は使用箇所の少し上にあることが多いので、
 * まず 10 行で試し、docs/testing.md のデモケースで足りなければ調整する。
 */
const SURROUNDING_LINE_COUNT = 10;

/**
 * 定義取得を諦めるまでの時間（ミリ秒）。
 *
 * `executeDefinitionProvider` は言語サーバーの起動前に呼ぶと応答が返らないことがある。
 * タイムアウトを置かないと、質問のたびに言語サーバーの起動待ちで固まる。
 * 「拡張が入っていても起動前は結果が返らない」のは Lv2 として扱うべき状態なので、
 * タイムアウトは異常ではなく想定内の分岐として扱う。
 *
 * これは1回の呼び出しではなく定義収集全体の期限である。候補ごとに計ると
 * 候補数だけ待ち時間が積み上がり、防ごうとしている「起動待ちで固まる」状態そのものになる。
 */
const DEFINITION_TIMEOUT_MS = 300;

/** 1つの選択範囲から取得する定義の上限。プロンプトが膨らむのを防ぐ。 */
const MAX_DEFINITIONS = 3;

/** 定義1件あたりに含める行数。宣言行とその周辺のみを運び、ファイル全体は含めない。 */
const DEFINITION_LINE_COUNT = 5;

/**
 * エディタの選択範囲から {@link CodeContext} を作る。
 *
 * 呼び出し側は選択が空でないことを確認してから呼ぶこと。
 * `source` は引数で受けず `"editor"` に固定する。この関数はエディタからしか呼ばれない。
 */
export async function collectFromEditor(editor: vscode.TextEditor): Promise<CodeContext> {
  const document = editor.document;
  const selection = editor.selection;

  const code = document.getText(selection);
  const surroundingCode = readSurroundingCode(document, selection);
  const definitions = await collectDefinitions(document, selection);

  // Lv3 と Lv2 を分けるのは定義が実際に取れたかどうか。
  // 言語サーバーの有無ではなく、呼んだ結果で判定する。
  const contextLevel: ContextLevel = definitions.length > 0 ? 3 : 2;

  return {
    code,
    source: "editor",
    contextLevel,
    surroundingCode,
    languageId: document.languageId,
    fileName: describeFileName(document),
    startLine: selection.start.line,
    endLine: selection.end.line,
    ...(definitions.length > 0 ? { definitions } : {}),
  };
}

/**
 * 位置情報を持たないテキストから {@link CodeContext} を作る。
 *
 * ターミナルやクリップボード経由で得た文字列が対象。内容しか運ばれてこないため、
 * 言語もファイル名も行番号も推測しない。`source` は呼び出し側が
 * どのコマンドから来たかで確定させる。ここで推測することはできない。
 */
export function collectFromText(text: string, source: ContextSource): CodeContext {
  return {
    code: text,
    source,
    contextLevel: 1,
    // Lv1 では前後を取得できない。必須項目なので空文字列を入れる。
    surroundingCode: "",
  };
}

/**
 * 選択範囲の前後のコードを読む。
 *
 * ファイルの先頭・末尾を選択した場合に範囲外アクセスで落ちないよう、
 * 行番号を必ずドキュメントの範囲へ収める。
 */
function readSurroundingCode(document: vscode.TextDocument, selection: vscode.Selection): string {
  const startLine = Math.max(0, selection.start.line - SURROUNDING_LINE_COUNT);
  const endLine = Math.min(document.lineCount - 1, selection.end.line + SURROUNDING_LINE_COUNT);

  const range = new vscode.Range(
    startLine,
    0,
    endLine,
    document.lineAt(endLine).range.end.character,
  );

  return document.getText(range);
}

/**
 * 表示・AI送信用のファイル名を返す。
 *
 * 未保存ファイルの `fileName` は "Untitled-1" のような実在しないパスになる。
 * 破綻はしないが、絶対パスをそのまま送るとユーザーのディレクトリ構成が漏れるため、
 * どちらの場合もファイル名部分だけを取り出す。
 */
function describeFileName(document: vscode.TextDocument): string {
  const path = document.uri.path;
  const separatorIndex = path.lastIndexOf("/");

  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

/**
 * 定義先のファイルを、どこにあるかが分かる形で表す。
 *
 * 定義はファイル名だけでは足りない。`log/slog/logger.go` と
 * `internal/app/logger.go` はどちらも "logger.go" になり、
 * AI から見ると「同じファイル内の定義」と読めてしまう。
 *
 * ワークスペース内ならそこからの相対パスを返す。ユーザーの絶対パスは含まれない。
 * ワークスペース外（標準ライブラリ、依存パッケージ）は末尾2階層に切り詰める。
 * 絶対パスを避けつつ どこのファイルなのか程度の手がかりは残すため。
 */
function describeDefinitionPath(document: vscode.TextDocument): string {
  const relative = vscode.workspace.asRelativePath(document.uri, false);

  // asRelativePath はワークスペース外だと絶対パスをそのまま返す。
  if (!relative.startsWith("/")) {
    return relative;
  }

  const segments = relative.split("/").filter((segment) => segment !== "");

  return segments.slice(-2).join("/");
}

/**
 * 選択範囲内の識別子から、選択範囲の外にある定義を集める。
 *
 * 言語サーバーが無い、起動前、定義が同一ファイル内にある、のいずれでも空配列を返す。
 * 呼び出し側はこの結果で Lv3 / Lv2 を判定する。
 */
async function collectDefinitions(
  document: vscode.TextDocument,
  selection: vscode.Selection,
): Promise<ExternalDefinition[]> {
  const positions = findIdentifierPositions(document, selection);
  const definitions: ExternalDefinition[] = [];
  const seen = new Set<string>();

  // 収集全体で1つの期限を共有する。候補ごとにタイムアウトを計ると、
  // 言語サーバー起動前は候補数 × タイムアウトだけ待つことになる。
  const deadline = Date.now() + DEFINITION_TIMEOUT_MS;

  for (const position of positions) {
    if (definitions.length >= MAX_DEFINITIONS || Date.now() >= deadline) {
      break;
    }

    const locations = await executeDefinitionProvider(document.uri, position, deadline);

    for (const location of locations) {
      // 同一ファイル内の定義は surroundingCode 側で拾える可能性があり、
      // Lv3 の「別ファイルの定義」にもあたらない。
      if (location.uri.toString() === document.uri.toString()) {
        continue;
      }

      const key = `${location.uri.toString()}:${location.range.start.line}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      // getWordRangeAtPosition は範囲が無いと undefined を返す。
      // getText(undefined) はドキュメント全体を返すため、そのまま渡すと
      // symbol にファイル全体が入り、プロンプトへ載る。必ず範囲を確認してから読む。
      const wordRange = document.getWordRangeAtPosition(position);
      const definition = await readDefinition(
        location,
        wordRange ? document.getText(wordRange) : undefined,
      );

      if (definition) {
        definitions.push(definition);
      }

      break;
    }
  }

  return definitions;
}

/**
 * 定義位置の周辺を読み出す。
 *
 * 定義先のファイルを開けない場合（バイナリ、権限、削除済みなど）は
 * 例外を投げずに undefined を返す。定義が1件取れないことは Lv2 へ落ちるだけの話で、
 * 質問そのものを失敗させる理由にはならない。
 */
async function readDefinition(
  location: vscode.Location,
  symbol: string | undefined,
): Promise<ExternalDefinition | undefined> {
  try {
    const target = await vscode.workspace.openTextDocument(location.uri);

    // 行番号は別ファイルのもので、こちらが検証していない値である。
    // 言語サーバーが編集前の位置を返すこともあるため、必ず対象の範囲へ収める。
    // ここを超えると lineAt が投げ、catch で定義が黙って捨てられる。
    const startLine = Math.max(0, Math.min(target.lineCount - 1, location.range.start.line));
    const endLine = Math.min(target.lineCount - 1, startLine + DEFINITION_LINE_COUNT - 1);

    return {
      fileName: describeDefinitionPath(target),
      code: target.getText(
        new vscode.Range(startLine, 0, endLine, target.lineAt(endLine).range.end.character),
      ),
      startLine,
      symbol: symbol === "" ? undefined : symbol,
    };
  } catch {
    return undefined;
  }
}

/**
 * 定義取得を、収集全体で共有する期限つきで呼ぶ。
 *
 * 言語サーバーの起動前は応答が返らないため、待ち続けない。
 * タイムアウトも失敗も空配列にまとめる。呼び出し側にとっては
 * 「定義が取れなかった」という同じ結果でしかない。
 */
async function executeDefinitionProvider(
  uri: vscode.Uri,
  position: vscode.Position,
  deadline: number,
): Promise<vscode.Location[]> {
  const request = vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    "vscode.executeDefinitionProvider",
    uri,
    position,
  );

  // 残り時間で打ち切る。個別に DEFINITION_TIMEOUT_MS を計り直さない。
  const remaining = Math.max(0, deadline - Date.now());
  const timeout = new Promise<undefined>((resolve) =>
    setTimeout(() => resolve(undefined), remaining),
  );

  try {
    const result = await Promise.race([request, timeout]);

    if (!result) {
      return [];
    }

    return result.map(toLocation);
  } catch {
    return [];
  }
}

/** LocationLink 形式で返す言語サーバーがあるため、Location に揃える。 */
function toLocation(value: vscode.Location | vscode.LocationLink): vscode.Location {
  return "targetUri" in value ? new vscode.Location(value.targetUri, value.targetRange) : value;
}

/**
 * 選択範囲内にある識別子の位置を返す。
 *
 * 選択範囲の全単語で定義を引くと、言語サーバーへの問い合わせが選択行数に比例して増える。
 * 定義の取得数には上限があるので、先頭から順に見て必要な数だけ引ければ十分。
 *
 * 既知の弱点: ファイル全体のような広い範囲を選ぶと、先頭にある import 文の
 * 識別子だけで {@link MAX_DEFINITIONS} を使い切る。実機では Go の main.go 全選択で
 * `context` / `log` / `slog` のパッケージ宣言行が3件並び、本体の呼び出し先である
 * app.SetupLogger には到達しなかった。contextLevel は 3 になるが中身は
 * 回答の役に立たない。想定している「数行を選んで質問する」使い方では起きない。
 * 直すなら、パッケージ宣言だけの定義を捨てるか、候補を選択範囲全体へ分散させる。
 */
function findIdentifierPositions(
  document: vscode.TextDocument,
  selection: vscode.Selection,
): vscode.Position[] {
  const prioritized: vscode.Position[] = [];
  const deferred: vscode.Position[] = [];
  const identifier = /[A-Za-z_][A-Za-z0-9_]*/g;
  const lastLine = Math.min(document.lineCount - 1, selection.end.line);

  for (let line = selection.start.line; line <= lastLine; line++) {
    const text = document.lineAt(line).text;
    const target = isImportOrIncludeLine(text) ? deferred : prioritized;

    identifier.lastIndex = 0;

    for (let match = identifier.exec(text); match; match = identifier.exec(text)) {
      if (target.length < MAX_DEFINITIONS * 4) {
        target.push(new vscode.Position(line, match.index));
      }
    }
  }

  // import/include だけを選択した場合にも定義を取得できるよう、後回しにするだけで除外はしない。
  // 判定は一般的な import/include 宣言の構文に限られ、言語ごとの構文を網羅するものではない。
  return [...prioritized, ...deferred].slice(0, MAX_DEFINITIONS * 4);
}

function isImportOrIncludeLine(text: string): boolean {
  return /^\s*(?:#\s*include\b|import\b|from\b.*\bimport\b|use\b|using\b)/.test(text);
}
