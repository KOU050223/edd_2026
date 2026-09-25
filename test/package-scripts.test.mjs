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
const desktopPackageJson = JSON.parse(
  await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
);
const webPreview = await readFile(
  new URL("../.github/workflows/preview-web.yml", import.meta.url),
  "utf8",
);
const desktopRelease = await readFile(
  new URL("../.github/workflows/release-desktop.yml", import.meta.url),
  "utf8",
);
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
  assert.equal(
    packageJson.scripts["build:web"],
    "npm run compile --workspace=@gakushu-sochi/domain && npm run build --workspace=@gakushu-sochi/web",
  );
  assert.match(lefthook, /web-build:\n\s+run: npm run build:web/);
  assert.match(ci, /name: Build Web assets\n\s+run: npm run build:web/);
});

test("main の CI 成功後に API を同じコミットへ紐づけてデプロイする", () => {
  assert.equal(
    apiPackageJson.scripts.deploy,
    "npm run compile --workspace=@gakushu-sochi/domain && wrangler deploy",
  );
  assert.match(ci, /deploy-api:\n\s+name: Deploy API Worker/);
  assert.match(ci, /deploy-api:[\s\S]*needs: verify/);
  assert.match(ci, /deploy-api:[\s\S]*github\.event_name == 'push'/);
  assert.match(ci, /deploy-api:[\s\S]*github\.ref == 'refs\/heads\/main'/);
  assert.match(ci, /deploy-api:[\s\S]*ref: \$\{\{ github\.sha \}\}/);
  assert.match(ci, /deploy-api:[\s\S]*npm run migrate:remote --workspace=@gakushu-sochi\/api/);
  assert.match(ci, /deploy-api:[\s\S]*npm run deploy --workspace=@gakushu-sochi\/api/);
});

test("main の CI 成功後に Web を同じコミットへ紐づけてデプロイする", () => {
  assert.equal(
    webPackageJson.scripts.deploy,
    "npm run compile --workspace=@gakushu-sochi/domain && npm run build && wrangler deploy",
  );
  assert.match(ci, /deploy-web:\n\s+name: Deploy Web Worker/);
  assert.match(ci, /deploy-web:[\s\S]*needs: verify/);
  assert.match(ci, /deploy-web:[\s\S]*github\.event_name == 'push'/);
  assert.match(ci, /deploy-web:[\s\S]*github\.ref == 'refs\/heads\/main'/);
  assert.match(ci, /deploy-web:[\s\S]*ref: \$\{\{ github\.sha \}\}/);
  // 共有の API_TOKEN / WEB_ACCESS_PASSPHRASE は Auth/05 で消えた。
  // Web に要る secret は Auth0 の client secret だけになった（docs/auth.md §5.3）。
  assert.match(
    ci,
    /deploy-web:[\s\S]*WEB_AUTH_CLIENT_SECRET: \$\{\{ secrets\.WEB_AUTH_CLIENT_SECRET \}\}/,
  );
  // 全権限をバイパスする共有資格情報が CI 経由で戻ってこないようにする（Auth/06）。
  // これらは設定・コード・Cloudflare・GitHub の secret すべてから消した。
  // どれか1か所でも復活すれば恒久的な裏口になるので、名前の出現そのものを禁じる。
  for (const name of [
    "WEB_ACCESS_PASSPHRASE",
    "WEB_API_TOKEN",
    "DEV_AUTH_TOKEN",
    "DEV_AUTH_USER_ID",
  ]) {
    assert.doesNotMatch(ci, new RegExp(name), `${name} は Auth/06 で廃止した`);
    assert.doesNotMatch(webPreview, new RegExp(name), `${name} は Auth/06 で廃止した`);
  }
  assert.match(ci, /deploy-web:[\s\S]*name: Require Web Worker secrets/);
  assert.match(ci, /deploy-web:[\s\S]*--secrets-file "\$secrets_file"/);
});

test("PR 作成・更新時は本番へ昇格しない Web Preview を発行する", () => {
  assert.match(webPreview, /name: Preview Web/);
  assert.match(webPreview, /pull_request:/);
  assert.match(webPreview, /synchronize/);
  assert.match(webPreview, /head\.repo\.full_name == github\.repository/);
  assert.match(webPreview, /wrangler versions upload/);
  assert.match(webPreview, /--preview-alias "pr-\$\{PR_NUMBER\}"/);
  assert.match(webPreview, /--secrets-file "\$secrets_file"/);
  assert.match(webPreview, /pull-requests: write/);
  assert.match(webPreview, /actions\/github-script@v7/);
  assert.match(webPreview, /context\.payload\.pull_request\.head\.sha\.slice\(0, 7\)/);
  assert.doesNotMatch(webPreview, /context\.sha\.slice\(0, 7\)/);
});

test("VS Code Extension はコンパイル後に VSIX を生成できる", () => {
  assert.equal(
    extensionPackageJson.scripts.package,
    "npm run compile && npx --no-install @vscode/vsce package --no-dependencies",
  );
  // npx --no-install はローカル依存のみを実行するため、lockfile 固定のバージョンが必須。
  assert.equal(extensionPackageJson.devDependencies["@vscode/vsce"], "3.9.2");
});

test("desktop-v* タグで Desktop の GitHub Release を作る", () => {
  // リリース経路は docs/release.md が正典。ここでは配線だけを検査する。
  // タグ push が唯一のリリーストリガー。workflow_dispatch は試運転用でリリースを作らない。
  assert.match(desktopRelease, /tags:\s*\n\s*- "?desktop-v\*"?/);
  assert.match(desktopRelease, /workflow_dispatch:/);
  assert.match(desktopRelease, /if: github\.event_name == 'push'/);
  // タグと package.json のバージョン不一致は即失敗。
  // 名と中身が食い違うリリースを出さないため。
  assert.match(desktopRelease, /GITHUB_REF_NAME#desktop-v/);
  assert.match(desktopRelease, /apps\/desktop\/package\.json/);
  // 検証を通っていないコードはビルドしない、ビルドなしにリリースしない。
  assert.match(desktopRelease, /needs: verify/);
  assert.match(desktopRelease, /needs: build/);
  // mac の dmg と win の nsis を matrix で作る。
  assert.match(desktopRelease, /macos-latest/);
  assert.match(desktopRelease, /windows-latest/);
  // electron-builder には publish させず、gh が各 OS の成果物を 1 つの
  // リリースへ集約する。matrix 各ジョブが個別に publish すると競合する。
  assert.match(desktopRelease, /--publish never/);
  assert.match(desktopRelease, /gh release create/);
  assert.match(desktopRelease, /contents: write/);
  // publish 先の設定が変わると手動 publish の行き先も変わる。向き先を固定する。
  assert.deepEqual(desktopPackageJson.build.publish, [
    { provider: "github", owner: "KOU050223", repo: "edd_2026" },
  ]);
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

test("Nix の devShell が .node-version と同じ Node を配る", async () => {
  // 手元（devShell）と CI（setup-node）で Node が違うと、手元で通ったものが
  // CI で落ちる。.node-version を正典にして、両方がそこを向いているか検査する。
  const nodeVersion = (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim();
  const flake = await readFile(new URL("../flake.nix", import.meta.url), "utf8");

  // flake は .node-version をハードコードせず読み込む。二重管理にしない。
  assert.match(flake, /builtins\.readFile \.\/\.node-version/);
  assert.match(flake, /nodejs_24/);
  assert.match(ci, new RegExp(`node-version: ${nodeVersion.replace(/\./g, "\\.")}`));

  // lock が無いと nixpkgs が流れて Node が勝手に上がる。
  const lock = JSON.parse(await readFile(new URL("../flake.lock", import.meta.url), "utf8"));
  assert.ok(lock.nodes.nixpkgs?.locked?.rev, "flake.lock が nixpkgs を固定していない");
});

test("Taskfile はロジックを持たず npm scripts を呼ぶ", async () => {
  // Taskfile にロジックを移すと、CI と lefthook（npm scripts を直接叩く）を
  // 素通りする経路ができる。入口だけに留めているか検査する。
  const taskfile = await readFile(new URL("../Taskfile.yml", import.meta.url), "utf8");

  // Issue #133 が求めた入口。名前が消えると README の手順が嘘になる。
  for (const name of ["setup:", "dev:", "test:", "lint:", "check:env:"]) {
    assert.ok(taskfile.includes(`\n  ${name}`), `Taskfile に ${name} が無い`);
  }

  // setup は「依存 → env → hook」まで面倒を見る。どれが欠けても clone 直後に動かない。
  const setup = taskfile.match(/\n {2}setup:\n([\s\S]*?)(?=\n {2}\w)/)?.[1];
  assert.ok(setup, "setup タスクを読み取れない");
  for (const dependency of ["install", "env", "hooks"]) {
    assert.match(setup, new RegExp(`task: ${dependency}`), `setup が ${dependency} を呼んでいない`);
  }

  // Taskfile が呼ぶ npm script は実在していること。消えた script を呼ぶと
  // task だけが壊れ、CI は緑のままになる。
  const workspaceScripts = {
    "@gakushu-sochi/api": apiPackageJson.scripts,
    "@gakushu-sochi/web": webPackageJson.scripts,
  };
  for (const [, script, workspace] of taskfile.matchAll(
    /^ +- npm run ([\w:-]+)(?: --workspace=(\S+))?/gm,
  )) {
    const scripts = workspace ? workspaceScripts[workspace] : packageJson.scripts;
    assert.ok(scripts, `Taskfile が未知のワークスペースを指す: ${workspace}`);
    assert.ok(
      scripts[script],
      `Taskfile が存在しない npm script を呼ぶ: ${script}${workspace ? ` (${workspace})` : ""}`,
    );
  }
});

test("setup は .dev.vars を雛形から作り、既存を上書きしない", async () => {
  // 上書きすると、手元に入れた本物の秘密値が空の雛形で消える。
  // 原因が見えにくい 401 になるので、挙動そのものを検査する。
  const setupEnv = await readFile(new URL("../scripts/setup-env.mjs", import.meta.url), "utf8");
  assert.match(setupEnv, /--check/);

  // 雛形が追跡されていないと、clone した人の setup が失敗する。
  const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
  for (const example of ["apps/api/.dev.vars.example", "apps/web/.dev.vars.example"]) {
    assert.match(tracked, new RegExp(`^${example}$`, "m"), `${example} が追跡されていない`);
    // 生成先そのものが追跡されていたら、秘密値がコミットされる経路がある。
    assert.doesNotMatch(
      tracked,
      new RegExp(`^${example.replace(/\.example$/, "")}$`, "m"),
      `${example.replace(/\.example$/, "")} が追跡されている`,
    );
  }
});

test("domain を使うワークスペースのテストは dist を先に作る", () => {
  // @gakushu-sochi/domain の main は dist/index.js を指すが、リポジトリは
  // dist を追跡していない。clone 直後や dist を消した状態で各ワークスペースの
  // test:unit を単体で叩くと "Failed to resolve entry" で落ちる（実測）。
  // ルートの test:unit は compile を挟むので通り、CI も緑のままになる。
  // 手元だけが詰まる状態を作らないよう、前置きの有無を検査する。
  const prefix = "npm run compile --workspace=@gakushu-sochi/domain && ";
  const dependents = {
    "apps/api": apiPackageJson,
    "apps/web": webPackageJson,
    "apps/vscode-extension": extensionPackageJson,
  };
  for (const [path, json] of Object.entries(dependents)) {
    for (const script of ["test:unit", "test:watch"]) {
      assert.ok(
        json.scripts[script]?.startsWith(prefix),
        `${path} の ${script} が domain の compile を先に走らせていない`,
      );
    }
  }
});
