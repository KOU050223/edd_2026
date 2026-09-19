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
