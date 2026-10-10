import { requestJson } from "./api.js";
import type { HistoryFile } from "./local-history.js";

export async function historyUserId(): Promise<string> {
  const session = await requestJson<{ userId?: unknown }>("/session");
  if (typeof session.userId !== "string" || !session.userId)
    throw new Error("履歴の利用にはログインが必要です");
  return session.userId;
}

/** One DB per authenticated subject. Storage failure propagates before success is shown. */
export async function openHistoryStore(userId: string) {
  if (typeof indexedDB === "undefined")
    throw new Error("このブラウザは IndexedDB に対応していません");
  const request = indexedDB.open(`gakushu-claude-history:${userId}`, 1);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => {
      request.result.createObjectStore("files", { keyPath: "key" });
      request.result.createObjectStore("progress", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("別のタブを閉じて履歴を開き直してください"));
  });
  db.onversionchange = () => db.close();
  async function run<T>(
    store: string,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const tx = db.transaction(store, mode);
    const result = operation(tx.objectStore(store));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(result.result);
      const failure = () => {
        const cause = tx.error ?? (result.readyState === "done" ? result.error : null);
        return cause?.name === "QuotaExceededError"
          ? new Error(
              "保存容量が不足しています。不要なローカル履歴を削除してください。保存は完了していません",
              { cause },
            )
          : (cause ?? new Error("履歴の保存が中断されました。サイトデータ設定を確認してください"));
      };
      tx.onabort = () => reject(failure());
      tx.onerror = () => reject(failure());
    });
  }
  return {
    files: () => run("files", "readonly", (store) => store.getAll()) as Promise<HistoryFile[]>,
    saveFile: (file: HistoryFile) => run("files", "readwrite", (store) => store.put(file)),
    loadProgress: <T>(key: string) =>
      run("progress", "readonly", (store) => store.get(key)) as Promise<T | undefined>,
    saveProgress: (progress: { key: string }) =>
      run("progress", "readwrite", (store) => store.put(progress)),
    async deleteProject(project?: string) {
      const files = (await run("files", "readonly", (store) => store.getAll())) as HistoryFile[];
      const progress = (await run("progress", "readonly", (store) => store.getAll())) as {
        key: string;
      }[];
      const keysToDelete =
        project === undefined
          ? []
          : progress
              .filter((item) => {
                if (!item.key.startsWith("[")) return false;
                const selection: unknown = JSON.parse(item.key);
                if (!Array.isArray(selection)) throw new Error("保存した解析条件が不正です");
                return selection[1] === "" || selection[1] === project;
              })
              .map((item) => item.key);
      const tx = db.transaction(["files", "progress"], "readwrite");
      for (const file of files)
        if (project === undefined || file.project === project)
          tx.objectStore("files").delete(file.key);
      if (project === undefined) tx.objectStore("progress").clear();
      else for (const key of keysToDelete) tx.objectStore("progress").delete(key);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error("履歴を削除できませんでした"));
        tx.onerror = () => reject(tx.error);
      });
    },
    close: () => db.close(),
  };
}
export type HistoryStore = Awaited<ReturnType<typeof openHistoryStore>>;
