import { expect, test } from "vitest";
import { openGakushuSochiKeybindings } from "./open";

test("この拡張のコマンドで絞り込んだキーボードショートカット設定を開く", async () => {
  const calls: unknown[][] = [];

  await openGakushuSochiKeybindings(async (...args: unknown[]) => {
    calls.push(args);
  });

  // 絞り込み文字列を渡さないと全コマンドが並び、目的のキーを探せない。
  expect(calls).toEqual([["workbench.action.openGlobalKeybindings", "gakushuSochi."]]);
});

test("設定画面を開けないエラーを握り潰さない", async () => {
  const failure = new Error("設定を開けませんでした");

  await expect(
    openGakushuSochiKeybindings(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});
