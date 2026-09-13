import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const extensionPackageJson = JSON.parse(
  await readFile(new URL("../apps/vscode-extension/package.json", import.meta.url), "utf8"),
);
const apiPackageJson = JSON.parse(
  await readFile(new URL("../apps/api/package.json", import.meta.url), "utf8"),
);
const webPackageJson = JSON.parse(
  await readFile(new URL("../apps/web/package.json", import.meta.url), "utf8"),
);
const lefthook = await readFile(new URL("../lefthook.yml", import.meta.url), "utf8");
const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const harvestWorkflow = await readFile(
  new URL("../.github/workflows/harvest-rules.yml", import.meta.url),
  "utf8",
);

test("dev は API・Desktop・Web を失敗時に連携して並列起動する", () => {
  assert.match(packageJson.scripts.dev, /concurrently/);
  assert.match(packageJson.scripts.dev, /--kill-others-on-fail/);
  assert.match(packageJson.scripts.dev, /@gakushu-sochi\/api/);
  assert.match(packageJson.scripts.dev, /@gakushu-sochi\/desktop/);
  assert.match(packageJson.scripts.dev, /@gakushu-sochi\/web/);
});

test("ルートのテストは package scripts の契約も検証する", () => {
  assert.match(packageJson.scripts.test, /test:package-scripts/);
});

test("Web の開発サーバーは API とポートを分け、Worker 経由で配信する", () => {
  assert.match(webPackageJson.scripts.dev, /wrangler dev/);
  assert.match(webPackageJson.scripts.dev, /--port 8788/);
});

test("Web の本番アセットを hook と CI でビルド検証する", () => {
  assert.equal(packageJson.scripts["build:web"], "npm run build --workspace=@gakushu-sochi/web");
  assert.match(lefthook, /web-build:\n\s+run: npm run build:web/);
  assert.match(ci, /name: Build Web assets\n\s+run: npm run build:web/);
});

test("main への push は検証後に API と Web を順にデプロイする", () => {
  assert.equal(
    apiPackageJson.scripts.deploy,
    "npm run compile --workspace=@gakushu-sochi/domain && wrangler deploy",
  );
  assert.equal(webPackageJson.scripts.deploy, "npm run build && wrangler deploy");
  assert.match(ci, /deploy:\n\s+name: Deploy Workers/);
  assert.match(ci, /needs: verify/);
  assert.match(ci, /github\.event_name == 'push'/);
  assert.match(ci, /npm run migrate:remote --workspace=@gakushu-sochi\/api/);
  assert.match(ci, /npm run deploy --workspace=@gakushu-sochi\/api/);
  assert.match(ci, /npm run deploy --workspace=@gakushu-sochi\/web/);
});

test("Web の初回 deploy は required secrets を secrets file で渡す", () => {
  assert.match(ci, /WEB_API_TOKEN: \$\{\{ secrets\.WEB_API_TOKEN \}\}/);
  assert.match(ci, /WEB_ACCESS_PASSPHRASE: \$\{\{ secrets\.WEB_ACCESS_PASSPHRASE \}\}/);
  assert.match(ci, /name: Require Web Worker secrets/);
  assert.match(ci, /--secrets-file "\$secrets_file"/);
});

test("VS Code Extension はコンパイル後に VSIX を生成できる", () => {
  assert.equal(
    extensionPackageJson.scripts.package,
    "npm run compile && npx --no-install @vscode/vsce package --no-dependencies",
  );
  // npx --no-install はローカル依存のみを実行するため、lockfile 固定のバージョンが必須。
  assert.equal(extensionPackageJson.devDependencies["@vscode/vsce"], "3.9.2");
});

test("PR レビュー由来のプロジェクトルールを hook と CI で検証する", () => {
  // ルール検査が npm script / CI / lefthook のどこからも呼ばれなくなると、
  // ファイルは残ったまま何も守らなくなる。配線そのものを検査する。
  assert.equal(
    packageJson.scripts["test:project-rules"],
    "node --test test/project-rules.test.mjs",
  );
  assert.match(packageJson.scripts.test, /test:project-rules/);
  assert.match(ci, /name: Check project rules\n\s+run: npm run test:project-rules/);
  assert.match(lefthook, /project-rules:\n\s+run: npm run test:project-rules/);
});

test("ルール候補の収穫が main への push で自動的に走る", () => {
  // 収穫が誰かの手動実行でしか動かないなら、ルールは増えない。
  // 起動条件・権限・通知先の配線を検査する。
  assert.equal(packageJson.scripts["harvest:rules"], "node scripts/harvest-review-rules.mjs");
  assert.match(harvestWorkflow, /on:\n\s+push:\n\s+branches:\n\s+- main/);
  assert.match(harvestWorkflow, /issues: write/);
  assert.match(harvestWorkflow, /npm run --silent harvest:rules -- --json/);
  assert.match(harvestWorkflow, /scripts\/format-rule-candidates\.mjs/);
  // 新しい候補が無いときは通知しない。鳴り続ける通知は無視されるようになる。
  assert.match(harvestWorkflow, /steps\.harvest\.outputs\.has_new == 'true'/);
});

test("正典の出典は PR 番号とパスの組で引ける", async () => {
  // PR 番号だけで採用済みを判定すると、同じ PR の別カテゴリの指摘まで
  // 採用済みになり、本当は新しい候補が黙って消える（PR#98 のレビュー指摘）。
  // 出典の書式が崩れると照合できなくなるので、書式自体を検査する。
  const rules = await readFile(new URL("../.agents/rules/rules.md", import.meta.url), "utf8");
  const blocks = [...rules.matchAll(/\*\*出典\*\*:([\s\S]*?)(?=\n\n)/g)];
  assert.ok(blocks.length > 0, "出典ブロックを読み取れない");
  for (const [, block] of blocks) {
    for (const segment of block.split(/(?=PR#\d+)/)) {
      if (!/PR#\d+/.test(segment)) continue;
      assert.match(
        segment,
        /`[^`]+`/,
        `出典に対象パスが無い。PR 番号だけでは採用済みを判定できない: ${segment.trim()}`,
      );
    }
  }
});

test("収穫は採用済み・却下済みを差し引くための台帳を持つ", async () => {
  // 台帳が無いと同じ候補が毎回出て、通知はすぐ無視されるようになる。
  const harvester = await readFile(
    new URL("../scripts/harvest-review-rules.mjs", import.meta.url),
    "utf8",
  );
  assert.match(harvester, /\.agents\/rules\/rules\.md/);
  assert.match(harvester, /\.agents\/rules\/declined\.md/);
  const declined = await readFile(new URL("../.agents/rules/declined.md", import.meta.url), "utf8");
  assert.match(declined, /## 一覧/, "却下台帳の書式が壊れている");
});

test("スキルの台帳とエージェント連携のリンクが揃っている", async () => {
  // `skills experimental_install` は .claude/skills/ のリンクを復元しないまま
  // 終了コード 0 で終わる（実測）。リンクを git で追跡することだけが配布経路なので、
  // 追跡から外れると clone した人の Claude Code からスキルが黙って消える。
  const lock = JSON.parse(await readFile(new URL("../skills-lock.json", import.meta.url), "utf8"));
  const tracked = execFileSync("git", ["ls-files", "-s", ".claude/skills/"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  for (const [name, entry] of Object.entries(lock.skills)) {
    if (entry.sourceType !== "local") continue;
    assert.match(
      tracked,
      new RegExp(`^120000 \\S+ 0\\t\\.claude/skills/${name}$`, "m"),
      `${name} の .claude/skills リンクが git に追跡されていない`,
    );
  }
});

test("棚卸しスキルが存在し、AGENTS.md から辿れる", async () => {
  // スキルは Claude Code だけが自動で拾う。他のエージェントには AGENTS.md の
  // 導線が唯一の手がかりなので、リンクが切れるとスキルは在るだけで読まれなくなる。
  const skill = await readFile(
    new URL("../.agents/skills/rule-harvest/SKILL.md", import.meta.url),
    "utf8",
  );
  // 収穫の入口を Issue 本文ではなくスクリプトに向けているか。Issue は生成時点の描画で古い。
  assert.match(skill, /npm run harvest:rules -- --new-only/);
  // 編集は 3 箇所ある。どれが欠けてもメタテストが落ちるか候補が再提示される。
  for (const path of [".agents/rules/rules.md", ".agents/rules/declined.md", "AGENTS.md"]) {
    assert.ok(skill.includes(path), `棚卸し手順が ${path} への編集に触れていない`);
  }

  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.ok(
    agents.includes(".agents/skills/rule-harvest/SKILL.md"),
    "AGENTS.md から棚卸しスキルへの導線が切れている",
  );
});

test("AGENTS.md がルールの正典を読み込ませ、一覧が正典と一致する", async () => {
  // AGENTS.md（= CLAUDE.md）は Claude Code と Codex の両方が自動で読む唯一の入口。
  // ここから正典への導線が切れると、ルールは書いてあるだけで参照されなくなる。
  const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const rules = await readFile(new URL("../.agents/rules/rules.md", import.meta.url), "utf8");

  // Claude Code はこの行を展開して正典の全文をコンテキストへ載せる。
  assert.match(agents, /^@\.agents\/rules\/rules\.md$/m);

  // Codex は @ を展開しない（実測）。一覧表が唯一の手がかりになるので、
  // 正典に載っている ID がすべて表にあることを確認する。
  const canonical = [...rules.matchAll(/^## (RULE-\d+):/gm)].map((match) => match[1]);
  assert.ok(canonical.length > 0, "正典からルール ID を読み取れない");
  for (const id of canonical) {
    assert.match(agents, new RegExp(`\\| ${id}\\s`), `${id} が AGENTS.md の一覧に無い`);
  }
  const listed = [...agents.matchAll(/^\| (RULE-\d+)\s/gm)].map((match) => match[1]);
  for (const id of listed) {
    assert.ok(canonical.includes(id), `${id} は AGENTS.md にあるが正典に無い`);
  }
});

test("正典の旧パスへの参照が残っていない", () => {
  // 正典を .agents/ へ移したとき、拡張子を列挙して grep したせいで
  // .ts / .tsx のコメント内の参照を見落とした（PR#98 のレビューで指摘された）。
  // 追跡対象ファイル全体を対象にして、この取りこぼしを二度と起こさない。
  let tracked = "";
  try {
    tracked = execFileSync(
      "git",
      ["grep", "-lF", "docs/rules/", "--", ".", ":!test/package-scripts.test.mjs"],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim();
  } catch (error) {
    // git grep は一致が無いと終了コード 1 で終わる。それが期待する状態。
    // それ以外の失敗（git が無い、リポジトリ外など）は握りつぶさない。
    if (error.status !== 1) throw error;
  }
  assert.equal(tracked, "", `旧パス docs/rules/ への参照が残っている:\n${tracked}`);
});
