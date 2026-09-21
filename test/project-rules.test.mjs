// PR レビューで 2 回以上指摘されたパターンを機械的に検査する。
// ルールの根拠と背景は .agents/rules/rules.md を参照。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "out", "dist", ".wrangler", "build", ".git"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);

/** プロダクションのソースファイルを列挙する。生成物とテストは対象外。 */
async function collectSourceFiles() {
  const files = [];
  async function walk(dir) {
    const entries = await readdir(path.join(repoRoot, dir), { withFileTypes: true });
    for (const entry of entries) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(relative);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (/\.test\.[^.]+$/.test(entry.name) || relative.includes(`${path.sep}test${path.sep}`))
        continue;
      files.push(relative);
    }
  }
  for (const root of SOURCE_ROOTS) await walk(root);
  return files.sort();
}

const sourceFiles = await collectSourceFiles();
const sources = new Map(
  await Promise.all(
    sourceFiles.map(async (file) => [file, await readFile(path.join(repoRoot, file), "utf8")]),
  ),
);

/**
 * ソースを構文解析して `fetch` 呼び出しを取り出す。
 *
 * 正規表現ではなく AST を使う。文字列やコメントの中の `fetch(` を拾わず、
 * 引数が識別子かリテラルかを取り違えないため。TypeScript は既にこのリポジトリの
 * 依存にあるので、解析のために新しい依存は増えない。
 *
 * ファイル名は実際のパスを渡すこと。TypeScript は拡張子から ScriptKind を決めるため、
 * `.tsx` を `.ts` として解析すると JSX の `<` が型アサーションと読まれ、
 * 木が壊れて**何も検出しないまま緑になる**。
 */
function findFetchCalls(text, fileName = "input.ts") {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const calls = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isPropertyAccess = ts.isPropertyAccessExpression(callee);
      const name = ts.isIdentifier(callee)
        ? callee.text
        : isPropertyAccess
          ? callee.name.text
          : undefined;
      if (name === "fetch") {
        // 応答を束縛している変数。ストリーム判定をこの呼び出しの応答に限定するために使う。
        let binding;
        let parent = node.parent;
        if (parent && ts.isAwaitExpression(parent)) parent = parent.parent;
        if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          binding = parent.name.text;
        }
        calls.push({
          node,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          receiver: isPropertyAccess ? callee.expression.getText(source) : undefined,
          args: node.arguments,
          text: node.getText(source),
          binding,
          source,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** 呼び出しの options に、指定した名前のプロパティが直接書かれているか。 */
function optionProperty(call, propertyName) {
  const options = call.args[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  return options.properties.find(
    (property) =>
      property.name && ts.isIdentifier(property.name) && property.name.text === propertyName,
  );
}

/**
 * 受け取った値をそのまま渡すだけの中継か。上流の中断が伝播するので対象外にする。
 *
 * すべての引数が識別子（またはプロパティ参照）で、かつ受け皿を通して呼ぶものだけを
 * 中継と見なす。リテラルが 1 つでもあれば、その場で組み立てた要求なので中継ではない。
 *
 *   globalThis.fetch(input, init)      → 中継（DI のラッパ）
 *   c.env.ASSETS.fetch(c.req.raw)      → 中継
 *   deps.fetch(target, { method })     → 中継ではない
 *   fetch(url)                         → 中継ではない（裸の呼び出し）
 *
 * 引数の個数では判定しない。1 個なら中継と見なすと、ごく普通の `fetch(url)` が
 * すり抜ける（PR#98 のレビューで実際に見つかった見逃し）。
 */
function isRelayCall(call) {
  if (call.args.length === 0) return false;
  if (!call.receiver) return false;
  return call.args.every(
    (argument) => ts.isIdentifier(argument) || ts.isPropertyAccessExpression(argument),
  );
}

/**
 * 応答をストリームとして扱う呼び出しか。
 * ストリーミングに壁時計タイムアウトを付けると、長い生成が途中で打ち切られる。
 */
function isStreamingCall(call) {
  // 要求 URL が SSE を要求しているか。判定に使うのは第 1 引数（宛先）だけ。
  // 呼び出し全体の文字列を見ると、`body: JSON.stringify({ mode: "streaming" })` のような
  // 送信内容までストリームの根拠になり、普通の要求が検査から漏れる。
  const target = call.args[0];
  if (target && /alt=sse|text\/event-stream|stream(?:Generate|ing)/i.test(target.getText())) {
    return true;
  }
  if (!call.binding) return false;

  // 「この呼び出しの応答」の body をどう扱っているかだけを見る。
  // 変数名で束縛しないと document.body のような無関係な .body で
  // ルールが黙って適用されなくなる。判定は必ず厳しい側（違反とみなす側）へ倒す。
  let streaming = false;
  const visit = (node) => {
    if (streaming) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "body" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === call.binding
    ) {
      const parent = node.parent;
      // 逐次読み出し: response.body.getReader() など
      if (
        parent &&
        ts.isPropertyAccessExpression(parent) &&
        ["getReader", "pipeTo", "pipeThrough"].includes(parent.name.text)
      ) {
        streaming = true;
        return;
      }
      // 中継: new Response(upstream.body, ...) のように body をそのまま渡す
      if (parent && ts.isNewExpression(parent) && parent.expression.getText() === "Response") {
        streaming = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(call.source);
  return streaming;
}

const CREDENTIAL_HEADER = /^(?:authorization|x-goog-api-key|api[-_]?key)$/i;

/**
 * 資格情報をヘッダに載せている呼び出しか。
 *
 * 見るのは `fetch(...)` の第 2 引数に直接書かれたヘッダだけ。
 * `Headers` を別の場所で組み立てて渡す書き方は、型情報まで辿らないと判定できないため
 * 検出できない（.agents/rules/rules.md RULE-002 の「検出の限界」を参照）。
 */
function carriesCredential(call) {
  const headers = optionProperty(call, "headers");
  if (!headers || !ts.isPropertyAssignment(headers)) return false;
  const value = headers.initializer;
  if (!ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some((property) => {
    if (!property.name) return false;
    const name = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    return name !== undefined && CREDENTIAL_HEADER.test(name);
  });
}

/** `redirect: "error"` が指定されているか。 */
function hasRedirectError(call) {
  const redirect = optionProperty(call, "redirect");
  return Boolean(
    redirect &&
    ts.isPropertyAssignment(redirect) &&
    ts.isStringLiteral(redirect.initializer) &&
    redirect.initializer.text === "error",
  );
}

// RULE-001: 単発の外向き fetch にはタイムアウトを設定する。
// 応答が返らないまま無限に待つと、UI が固まり Worker は課金時間を食い潰す。
//
// ストリーミングと中継は対象外。壁時計タイムアウトを付けると、正常な応答が
// 途中で切れるバグになる。判定の根拠は .agents/rules/rules.md RULE-001 を参照。
test("RULE-001: 単発の外向き fetch には signal を渡す", () => {
  const violations = [];
  for (const [file, text] of sources) {
    for (const call of findFetchCalls(text, file)) {
      if (optionProperty(call, "signal")) continue;
      if (isRelayCall(call)) continue;
      if (isStreamingCall(call)) continue;
      violations.push(`${file}:${call.line}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `signal 未指定の単発 fetch がある。AbortSignal.timeout を渡すこと` +
      `（.agents/rules/rules.md RULE-001）:\n${violations.join("\n")}`,
  );
});

// RULE-002: 資格情報を載せた fetch はリダイレクトを追跡しない。
// 転送先へ Authorization ヘッダごと送られると、トークンが意図しない相手に渡る。
test('RULE-002: 資格情報を送る fetch は redirect: "error" を指定する', () => {
  const violations = [];
  for (const [file, text] of sources) {
    for (const call of findFetchCalls(text, file)) {
      if (!carriesCredential(call)) continue;
      if (hasRedirectError(call)) continue;
      violations.push(`${file}:${call.line}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `資格情報を送る fetch がリダイレクトを自動追跡する` +
      `（.agents/rules/rules.md RULE-002）:\n${violations.join("\n")}`,
  );
});

// RULE-003: 設定から来た送信先 origin は HTTPS かループバックに限定する。
// 検査の本体は apps/web の単体テスト（origin 検証の実挙動）。
// ここでは、その検査が消えていないことだけを確かめる。
//
// **設定由来の送信先が増えたら、ここへ足すこと。** Web Worker はトークンを
// API へ送り（API_ORIGIN）、client secret を IdP へ送る（AUTH_ISSUER）。
// どちらも設定から来るので、両方が検証されていなければ RULE-003 は守られていない。
const ORIGIN_VALIDATION_TESTS = [
  /loopback 以外の HTTP API_ORIGIN へトークンを送らない/,
  /loopback 以外の HTTP AUTH_ISSUER へ client secret を送らない/,
];

test("RULE-003: origin 検証の単体テストが存在する", async () => {
  const workerTest = await readFile(
    path.join(repoRoot, "apps/web/src/worker/index.test.ts"),
    "utf8",
  );
  for (const pattern of ORIGIN_VALIDATION_TESTS) {
    assert.match(
      workerTest,
      pattern,
      `loopback 以外の平文 HTTP を拒否するテストが消えている（.agents/rules/rules.md RULE-003）: ${pattern}`,
    );
  }
});

// RULE-004: エラーを握りつぶすな。空の catch は eslint でも落ちるが、
// 生成物を含めた全域をここでも押さえる。
test("RULE-004: 空の catch を書かない", () => {
  const violations = [];
  for (const [file, text] of sources) {
    const pattern = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
    for (let match; (match = pattern.exec(text));) {
      violations.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `空の catch がある。記録するか型付きの結果へ変換すること` +
      `（.agents/rules/rules.md RULE-004）:\n${violations.join("\n")}`,
  );
});

// 検出器そのものの回帰テスト。
// 「本物の違反を見逃さない」ことは、緑のテストからは分からない。
// 実際にすり抜けた書き方（PR#98 のレビュー指摘）を固定しておく。
test("検出器: 中継と実際の呼び出しを取り違えない", () => {
  const cases = [
    // [コード, 中継とみなすか]
    ["const r = await globalThis.fetch(input, init);", true],
    ["app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));", true],
    // 裸の fetch(url) は中継ではない。単発の要求として検査対象にする。
    ["const r = await fetch(url);", false],
    ['const r = await fetch("https://example.test/a");', false],
    ['const r = await globalThis.fetch("https://x.test", { headers });', false],
    ["const r = await deps.fetch(target, { method: 'POST' });", false],
  ];
  for (const [code, expected] of cases) {
    const [call] = findFetchCalls(code);
    assert.ok(call, `fetch 呼び出しを検出できない: ${code}`);
    assert.equal(isRelayCall(call), expected, `中継判定が誤り: ${code}`);
  }
});

test("検出器: signal 無しの単発 fetch を見逃さない", () => {
  const violating = [
    'const r = await fetch("https://example.test/a");',
    'const r = await globalThis.fetch("https://x.test", { headers: { Authorization: t } });',
    // 送信内容に "streaming" という語が入るだけの、応答をストリームしない要求。
    // 呼び出し全体の文字列でストリーム判定すると、これが検査から漏れる。
    'const r = await fetch("https://x.test", { body: JSON.stringify({ mode: "streaming" }) });',
  ];
  for (const code of violating) {
    const [call] = findFetchCalls(code);
    assert.ok(!optionProperty(call, "signal"), code);
    assert.ok(!isRelayCall(call), `中継として誤って除外される: ${code}`);
    assert.ok(!isStreamingCall(call), `ストリームとして誤って除外される: ${code}`);
  }
});

test("検出器: ストリームの判定は応答の扱いに基づく", () => {
  const streaming = [
    // SSE を要求する宛先
    'const r = await fetch("https://x.test/v1:stream?alt=sse", { method: "POST" });',
    // 応答を逐次読む
    'const r = await fetch("https://x.test", { method: "POST" });\nconst rd = r.body.getReader();',
    // 応答をそのまま下流へ流す
    'const up = await deps.fetch(t, { method: "GET" });\nreturn new Response(up.body, {});',
  ];
  for (const code of streaming) {
    const [call] = findFetchCalls(code);
    assert.ok(isStreamingCall(call), `ストリームと判定されない: ${code}`);
  }

  const notStreaming = [
    // 送信内容に streaming という語があるだけ
    'const r = await fetch("https://x.test", { body: JSON.stringify({ mode: "streaming" }) });',
    // 無関係な .body（document.body）が近くにある
    'const r = await fetch("https://x.test");\ndocument.body.dataset.ok = "1";',
  ];
  for (const code of notStreaming) {
    const [call] = findFetchCalls(code);
    assert.ok(!isStreamingCall(call), `ストリームとして誤って除外される: ${code}`);
  }
});

// ルール文書とテストが乖離しないよう、正典の存在自体も検査する。
test("ルールの正典が存在し、各ルールに出典 PR が記録されている", async () => {
  const rules = await readFile(path.join(repoRoot, ".agents/rules/rules.md"), "utf8");
  for (const id of ["RULE-001", "RULE-002", "RULE-003", "RULE-004", "RULE-005"]) {
    assert.match(rules, new RegExp(`## ${id}:`), `${id} の記載がない`);
  }
  const sections = rules.split(/^## /m).slice(1);
  for (const section of sections) {
    const id = section.slice(0, 8);
    assert.match(section, /\*\*出典\*\*:[\s\S]*?PR#\d+/, `${id} に出典の PR 番号がない`);
  }
});
