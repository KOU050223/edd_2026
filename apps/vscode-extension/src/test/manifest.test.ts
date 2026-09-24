import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  contributes: {
    commands: { command: string; title: string }[];
    keybindings: { command: string; key: string; when?: string }[];
    configuration: { properties: Record<string, { scope?: string }> };
  };
};

test("選択・ターミナル・クリップボードの入力経路を利用者が選べる", () => {
  expect(manifest.contributes.commands).toEqual(
    expect.arrayContaining([
      { command: "gakushuSochi.askSelection", title: "Gakushu Sochi: Ask Selection" },
      {
        command: "gakushuSochi.askTerminalSelection",
        title: "Gakushu Sochi: Ask Terminal Selection",
      },
      { command: "gakushuSochi.askClipboard", title: "Gakushu Sochi: Ask Clipboard" },
    ]),
  );
});

test("ログインとログアウトを利用者がコマンドから実行できる", () => {
  // ログアウトの導線が無いと、撤回も SecretStorage の破棄も呼べない
  // （docs/auth.md §8）。
  expect(manifest.contributes.commands).toEqual(
    expect.arrayContaining([
      { command: "gakushuSochi.login", title: "Gakushu Sochi: ログイン" },
      { command: "gakushuSochi.logout", title: "Gakushu Sochi: ログアウト" },
    ]),
  );
});

test("エディタとターミナルの同じキーをフォーカス条件で使い分ける", () => {
  expect(manifest.contributes.keybindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        command: "gakushuSochi.askSelection",
        key: "ctrl+shift+j",
        when: "editorTextFocus",
      }),
      expect.objectContaining({
        command: "gakushuSochi.askTerminalSelection",
        key: "ctrl+shift+j",
        when: "terminalFocus",
      }),
      expect.objectContaining({
        command: "gakushuSochi.askClipboard",
        key: "ctrl+alt+j",
      }),
    ]),
  );
});

test("APIの送信先設定をワークスペースから上書きできない", () => {
  expect(manifest.contributes.configuration.properties["gakushuSochi.api.baseUrl"]?.scope).toBe(
    "machine",
  );
});

test("AI の送信経路と BYOK の送信先をワークスペースから上書きできない", () => {
  // 経路・提供元・送信先 URL は、コードと API キーがどこへ出るかを左右する。
  // ワークスペース設定で書き換えられると、開いたリポジトリが送信先を
  // すり替えられる（RULE-006）。
  for (const key of [
    "gakushuSochi.ai.provider",
    "gakushuSochi.byok.vendor",
    "gakushuSochi.byok.model",
    "gakushuSochi.byok.baseUrl",
  ]) {
    expect(manifest.contributes.configuration.properties[key]?.scope).toBe("machine");
  }
});

test("BYOK の API キーを設定・削除するコマンドがある", () => {
  expect(manifest.contributes.commands).toEqual(
    expect.arrayContaining([
      { command: "gakushuSochi.setByokApiKey", title: "Gakushu Sochi: BYOK の API キーを設定する" },
      {
        command: "gakushuSochi.clearByokApiKey",
        title: "Gakushu Sochi: BYOK の API キーを削除する",
      },
    ]),
  );
});

test("API キーは設定項目として持たない", () => {
  // キーを contributes.configuration に置くと平文の settings.json に載り、
  // 設定同期で他のマシンへ配られる。SecretStorage 専用にする（RULE-006）。
  const secretSettings = Object.keys(manifest.contributes.configuration.properties).filter((key) =>
    /key|secret|token/i.test(key),
  );
  expect(secretSettings).toEqual([]);
});

test("同意の確認と取り消しを利用者がコマンドから行える", () => {
  expect(manifest.contributes.commands).toEqual(
    expect.arrayContaining([
      { command: "gakushuSochi.reviewConsent", title: "Gakushu Sochi: 送信内容の同意を確認する" },
      { command: "gakushuSochi.revokeConsent", title: "Gakushu Sochi: 送信内容の同意を取り消す" },
    ]),
  );
});

test("同意の状態をワークスペース設定から書き換えられない", () => {
  // 同意は globalState にしか置かない。設定項目として生やすと、開いたリポジトリの
  // .vscode/settings.json が同意を偽装できてしまう（RULE-006）。
  const consentSettings = Object.keys(manifest.contributes.configuration.properties).filter((key) =>
    key.toLowerCase().includes("consent"),
  );
  expect(consentSettings).toEqual([]);
});

test("キーボードショートカット設定への導線をコマンドから辿れる", () => {
  // #34: 既定のキーバインドは `keybindings.json` から上書きできるが、その設定画面へ
  // 辿り着く導線が拡張側に無かった。独自の設定画面は作らない（VS Code の作法から
  // 外れる）ため、標準の画面を開くコマンドが正解になる。
  expect(manifest.contributes.commands).toEqual(
    expect.arrayContaining([
      {
        command: "gakushuSochi.openKeybindings",
        title: "Gakushu Sochi: キーボードショートカットを変更する",
      },
    ]),
  );
});

test("導線そのものにキーバインドを割り当てない", () => {
  // 設定画面を開くだけのコマンドに既定キーを配ると、衝突の種を増やすだけで
  // 利用頻度に見合わない。
  const assigned = manifest.contributes.keybindings.filter(
    (keybinding) => keybinding.command === "gakushuSochi.openKeybindings",
  );
  expect(assigned).toEqual([]);
});
