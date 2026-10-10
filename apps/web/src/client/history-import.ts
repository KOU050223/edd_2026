import {
  historyDigest,
  historyLines,
  parseClaudeHistory,
  HISTORY_LIMITS,
  historyQuestions,
  type HistoryFile,
} from "./local-history.js";
import type { HistoryStore } from "./history-store.js";

export interface SelectedHistoryFile {
  file: File;
  relativePath: string;
}

export async function importHistoryFiles(
  files: readonly SelectedHistoryFile[],
  store: HistoryStore,
  signal: AbortSignal,
  onProgress: (message: string) => void,
) {
  const jsonl = files.filter(({ file }) => file.name.endsWith(".jsonl"));
  if (!jsonl.length)
    throw new Error(
      "JSONL 履歴がありません。Git のフォルダではなく .claude/projects を選んでください",
    );
  if (
    jsonl.length > HISTORY_LIMITS.files ||
    jsonl.reduce((sum, { file }) => sum + file.size, 0) > HISTORY_LIMITS.totalBytes
  )
    throw new Error(
      "選択した履歴が上限（2000ファイル / 100 MiB）を超えています。プロジェクト別に選択してください",
    );
  const known = new Map((await store.files()).map((file) => [file.key, file]));
  let updated = 0;
  let unchanged = 0;
  for (const [index, { file, relativePath }] of jsonl.entries()) {
    signal.throwIfAborted();
    if (file.size > HISTORY_LIMITS.fileBytes)
      throw new Error(`${file.name}: 20 MiB の上限を超えています`);
    onProgress(`${index + 1} / ${jsonl.length} ファイル（更新 ${updated}、変更なし ${unchanged}）`);
    const parts = relativePath.split("/");
    const projectDirectory = parts[0] === "projects" ? parts[1] : parts[0];
    const label = (projectDirectory ?? "selected")
      .split(/[-\\/]+/)
      .filter(Boolean)
      .slice(-2)
      .join("-");
    const project = `${label} (${(await historyDigest(projectDirectory ?? "selected")).slice(0, 12)})`;
    const key = await historyDigest(JSON.stringify([project, file.name]));
    const bytes = await file.arrayBuffer();
    signal.throwIfAborted();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const fingerprint = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const before = known.get(key);
    if (before?.fingerprint === fingerprint) {
      unchanged++;
      continue;
    }
    const parsed = await parseClaudeHistory(
      historyLines(file, signal),
      project,
      file.name.replace(/\.jsonl$/, ""),
    );
    if (
      before &&
      (file.size < before.size ||
        before.questions.some(
          (question) =>
            !parsed.questions.some(
              (next) => next.key === question.key && next.fingerprint === question.fingerprint,
            ),
        ))
    )
      parsed.warnings.push(
        "編集 / 切り詰めを検出。ローカル素材を置換しました。反映済み観測は Undo で取り消してください",
      );
    const next: HistoryFile = {
      key,
      revision: Math.max(0, ...[...known.values()].map((item) => item.revision ?? 0)) + 1,
      project,
      fingerprint,
      size: file.size,
      lastModified: file.lastModified,
      ...parsed,
    };
    const candidate = new Map(known);
    candidate.set(key, next);
    if (
      candidate.size > HISTORY_LIMITS.files ||
      [...candidate.values()].reduce((sum, item) => sum + item.size, 0) >
        HISTORY_LIMITS.totalBytes ||
      historyQuestions([...candidate.values()]).length > HISTORY_LIMITS.questions
    )
      throw new Error(
        "保存履歴の上限（100 MiB / 20000質問）を超えています。不要なプロジェクトを削除してください",
      );
    signal.throwIfAborted();
    await store.saveFile(next);
    known.set(key, next);
    updated++;
  }
  return { updated, unchanged };
}
