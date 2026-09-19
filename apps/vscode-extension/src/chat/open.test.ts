import { expect, test } from "vitest";
import { openGakushuSochiChat } from "./open";

test("@gakushu-sochiを入力済みかつ未送信でChatを開く", async () => {
  const calls: unknown[][] = [];

  await openGakushuSochiChat("context-1", async (...args: unknown[]) => {
    calls.push(args);
  });

  expect(calls).toEqual([
    [
      "workbench.action.chat.open",
      {
        query: "@gakushu-sochi [context:context-1] ",
        isPartialQuery: true,
      },
    ],
  ]);
});

test("Chatを開けないエラーを握り潰さない", async () => {
  const failure = new Error("Chat を開けませんでした");

  await expect(
    openGakushuSochiChat("context-1", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});
