import { expect, test } from "vitest";
import { MockProvider } from "./mock";

test("MockProviderは固定の応答を返す", async () => {
  const provider = new MockProvider();

  const response = await provider.ask();

  expect(response.ok).toBe(true);

  if (!response.ok) {
    throw new Error("MockProvider should return a successful response");
  }

  expect(response.answer.model).toBe("mock");
  expect(response.answer.text).toMatch(/MockProvider の固定応答/);
});
