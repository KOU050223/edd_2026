import { isIsoDateTime } from "@gakushu-sochi/domain";
import { isLearnerQuestion } from "./history-presentation.js";

/** Browser-local, sanitized Claude Code questions. No filesystem or raw text is persisted. */
export interface HistoryQuestion {
  key: string;
  /** All parts of one learner question share this observation identity. */
  observationKey?: string;
  project: string;
  observedAt: string;
  body: string;
  fingerprint: string;
}
export interface HistoryFile {
  key: string;
  revision?: number;
  project: string;
  fingerprint: string;
  size: number;
  lastModified: number;
  questions: HistoryQuestion[];
  warnings: string[];
}
export const HISTORY_LIMITS = {
  fileBytes: 20 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
  questions: 20_000,
  files: 2_000,
  lineChars: 1_000_000,
  bodyChars: 4_000,
};

export async function historyDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function maskHistory(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/-]{20,})\b/g,
      "<token>",
    )
    .replace(/\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[^\s"',;]+/gi, "<credential>")
    .replace(
      /(?:\/(?:[\w.@-]+\/)+[\w.@-]+|\b[A-Za-z]:\\(?:[\w. @()-]+\\)+[\w.@()-]+(?: [\w.@()-]+)*)/g,
      "<path>",
    );
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Incremental UTF-8 / JSONL reading, including lines split across byte chunks. */
export async function* historyLines(file: Blob, signal: AbortSignal): AsyncIterable<string> {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  const cancel = () => {
    void reader
      .cancel()
      .catch((error: unknown) => console.error("history read cancellation failed", error));
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        if (line.length > HISTORY_LIMITS.lineChars)
          throw new Error("JSONL の1行が上限を超えています");
        yield line;
        pending = pending.slice(end + 1);
      }
      if (pending.length > HISTORY_LIMITS.lineChars)
        throw new Error("JSONL の1行が上限を超えています");
      if (chunk.done) break;
    }
    if (pending.trim()) yield pending;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function parseClaudeHistory(
  lines: AsyncIterable<string>,
  project: string,
  fallbackSession: string,
) {
  const questions = new Map<string, HistoryQuestion>();
  const warningCounts = new Map<string, { count: number; lines: number[] }>();
  const warn = (reason: string, line?: number) => {
    const entry = warningCounts.get(reason) ?? { count: 0, lines: [] };
    entry.count++;
    if (line !== undefined && entry.lines.length < 5) entry.lines.push(line);
    warningCounts.set(reason, entry);
  };
  const questionLines = new Map<string, number>();
  let recognized = 0;
  let lineNumber = 0;
  let latest: HistoryQuestion | undefined;
  for await (const line of lines) {
    lineNumber++;
    if (lineNumber > 100_000) throw new Error("1ファイルの行数上限（100000行）を超えています");
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      warn("JSON が不正", lineNumber);
      continue;
    }
    if (!record || typeof record !== "object") {
      warn("未対応形式", lineNumber);
      continue;
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    recognized++;
    const message = record.message as { role?: string; content?: unknown } | undefined;
    if (
      record.isMeta === true ||
      record.isSidechain === true ||
      record.isCompactSummary === true ||
      message?.role !== record.type
    ) {
      if (record.type === "user") latest = undefined;
      warn("システム挿入文 / サブエージェントを除外", lineNumber);
      continue;
    }
    const rawText = textContent(message?.content);
    const text =
      record.type === "user"
        ? rawText
            .replace(
              /<(system-reminder|ide_opened_file|ide_selection|task-notification|local-command-caveat|local-command-stdout|command-name|command-message|command-args)\b[^>]*>[\s\S]*?<\/\1>/gi,
              "",
            )
            .trim()
        : rawText;
    if (text !== rawText.trim() && record.type === "user")
      warn("システム挿入部分を除去", lineNumber);
    if (record.type === "assistant") {
      if (latest && text) {
        const answer = maskHistory(text);
        if (answer.length > 200) warn("周辺回答を200文字に制限", lineNumber);
        latest.body += `\n周辺回答: ${answer.slice(0, 1_000)}`;
        latest.fingerprint = await historyDigest(latest.body);
        latest = undefined;
      }
      continue;
    }
    latest = undefined;
    if (
      !isLearnerQuestion(text) ||
      /^\s*<(?:system-reminder|local-command|command-name|task-notification|ide_opened_file|ide_selection)/i.test(
        text,
      )
    ) {
      warn("ツール出力 / システム文を除外", lineNumber);
      continue;
    }
    if (
      typeof record.uuid !== "string" ||
      !record.uuid ||
      typeof record.timestamp !== "string" ||
      !isIsoDateTime(record.timestamp)
    ) {
      warn("安定した発話 ID / 日時がないため保留", lineNumber);
      continue;
    }
    const session = typeof record.sessionId === "string" ? record.sessionId : fallbackSession;
    const key = await historyDigest(JSON.stringify(["claude-code", session, record.uuid]));
    const sanitized = maskHistory(text);
    if (sanitized !== text) warn("個人情報 / 資格情報 / パスをマスク", lineNumber);
    if (sanitized.length > HISTORY_LIMITS.bodyChars) warn("質問を4000文字に制限", lineNumber);
    const body = `ユーザーの質問: ${sanitized.slice(0, HISTORY_LIMITS.bodyChars)}`;
    if (questions.has(key)) warn("重複発話を更新", lineNumber);
    latest = {
      key,
      project,
      observedAt: new Date(record.timestamp).toISOString(),
      body,
      fingerprint: await historyDigest(body),
    };
    questions.set(key, latest);
    questionLines.set(key, lineNumber);
    if (questions.size > HISTORY_LIMITS.questions) throw new Error("質問件数の上限を超えています");
  }
  if (recognized === 0)
    warn(lineNumber === 0 ? "履歴なし" : "Claude Code の発話がない / 未対応形式");
  else if (questions.size === 0) warn("本人の質問として取り込める履歴なし");
  const parts: HistoryQuestion[] = [];
  for (const question of questions.values()) {
    const [prompt, answer] = question.body.split("\n周辺回答:");
    const chunks =
      Array.from(prompt!.replace(/^ユーザーの質問: /, ""))
        .join("")
        .match(/[\s\S]{1,500}/gu) ?? [];
    if (chunks.length > 1)
      warn(
        "長い質問を500文字ずつ分割。質問件数は元の発話単位で集計します",
        questionLines.get(question.key),
      );
    for (const [index, chunk] of chunks.entries()) {
      const body = `ユーザーの質問 (${index + 1}/${chunks.length}): ${chunk}${answer ? `\n周辺回答: ${answer.trim().slice(0, 200)}` : ""}`;
      parts.push({
        ...question,
        key: index === 0 ? question.key : await historyDigest(`${question.key}:part:${index}`),
        observationKey: question.key,
        body,
        fingerprint: await historyDigest(JSON.stringify([body, question.observedAt])),
      });
    }
  }
  const warnings = [...warningCounts].map(([reason, { count, lines }]) => {
    if (count === 1) return lines.length ? `行 ${lines[0]}: ${reason}` : reason;
    return `${reason}: ${count} 件${lines.length ? `（最初の行: ${lines.join(", ")}）` : ""}`;
  });
  return { questions: parts, warnings };
}

export function historyQuestions(files: readonly HistoryFile[]): HistoryQuestion[] {
  const questions = new Map<string, HistoryQuestion>();
  for (const file of [...files].sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0)))
    for (const question of file.questions)
      if (isLearnerQuestion(question.body)) questions.set(question.key, question);
  return [...questions.values()].sort(
    (a, b) => a.observedAt.localeCompare(b.observedAt) || a.key.localeCompare(b.key),
  );
}

export function historyQuestionCount(questions: readonly HistoryQuestion[]): number {
  return new Set(questions.map((question) => question.observationKey ?? question.key)).size;
}

export function filterHistory(
  questions: readonly HistoryQuestion[],
  project: string,
  from: string,
  to: string,
) {
  if (
    (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) ||
    (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) ||
    (from && to && from > to)
  )
    throw new Error("期間が不正です");
  return questions.filter(
    (question) =>
      (!project || question.project === project) &&
      (!from || question.observedAt.slice(0, 10) >= from) &&
      (!to || question.observedAt.slice(0, 10) <= to),
  );
}
