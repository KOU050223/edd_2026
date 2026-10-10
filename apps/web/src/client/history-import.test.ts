import { expect, test } from "vitest";
import { importHistoryFiles } from "./history-import.js";
import type { HistoryFile } from "./local-history.js";
import type { HistoryStore } from "./history-store.js";

function memoryStore() {
  const saved = new Map<string, HistoryFile>();
  let writes = 0;
  const store = {
    files: async () => [...saved.values()],
    saveFile: async (file: HistoryFile) => {
      saved.set(file.key, file);
      writes++;
    },
  } as unknown as HistoryStore;
  return { store, saved, writes: () => writes };
}
const record = (uuid: string, text: string, timestamp = "2025-01-01T00:00:00Z") =>
  JSON.stringify({
    type: "user",
    uuid,
    timestamp,
    sessionId: "s1",
    message: { role: "user", content: text },
  });
const file = (text: string) => [
  { file: new File([text], "s1.jsonl", { lastModified: 1 }), relativePath: "projects/p1/s1.jsonl" },
];

test("同じ更新日時でも追記を検出し、過去日時の新規発話を追加する", async () => {
  const memory = memoryStore();
  const signal = new AbortController().signal;
  const first = record("q1", "defer とは？");
  await importHistoryFiles(file(first), memory.store, signal, () => undefined);
  const result = await importHistoryFiles(
    file(`${first}\n${record("q2", "Go の質問", "2020-01-01T00:00:00Z")}`),
    memory.store,
    signal,
    () => undefined,
  );

  expect(result.updated).toBe(1);
  expect([...memory.saved.values()][0]!.questions).toHaveLength(2);
  expect(memory.writes()).toBe(2);
});

test("変更がないファイルを再処理せず、編集・切り詰めは置換と警告で扱う", async () => {
  const memory = memoryStore();
  const signal = new AbortController().signal;
  const original = `${record("q1", "Go")}\n${record("q2", "defer")}`;
  await importHistoryFiles(file(original), memory.store, signal, () => undefined);
  const unchanged = await importHistoryFiles(file(original), memory.store, signal, () => undefined);
  expect(unchanged.unchanged).toBe(1);
  expect(memory.writes()).toBe(1);
  await importHistoryFiles(file(record("q1", "Go")), memory.store, signal, () => undefined);

  expect([...memory.saved.values()][0]!.questions).toHaveLength(1);
  expect([...memory.saved.values()][0]!.warnings.at(-1)).toContain("切り詰め");
});

test("容量不足とキャンセルを保存成功に見せない", async () => {
  const memory = memoryStore();
  memory.store.saveFile = async () => {
    throw new DOMException("capacity exceeded", "QuotaExceededError");
  };
  await expect(
    importHistoryFiles(
      file(record("q1", "Go")),
      memory.store,
      new AbortController().signal,
      () => undefined,
    ),
  ).rejects.toThrow("capacity");
  const controller = new AbortController();
  controller.abort();
  await expect(
    importHistoryFiles(file(record("q1", "Go")), memory.store, controller.signal, () => undefined),
  ).rejects.toThrow();
  expect(memory.saved.size).toBe(0);
});

test("JSONL のない選択を履歴0件の成功として扱わない", async () => {
  await expect(
    importHistoryFiles([], memoryStore().store, new AbortController().signal, () => undefined),
  ).rejects.toThrow("JSONL 履歴がありません");
});
