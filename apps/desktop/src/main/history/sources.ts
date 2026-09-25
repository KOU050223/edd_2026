import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import type {
  HistoryProviderId,
  HistorySourceAdapter,
  HistorySourceDetection,
  RawConversation,
} from "@gakushu-sochi/domain";

/**
 * 外部履歴の Source Adapter（Issue #157）。
 *
 * 各ツールの保存場所・形式をここに閉じ込める。OS 依存のパス解決も
 * このモジュールの責務（apps/desktop/AGENTS.md）。
 *
 * 取り扱うデータは会話本文を含むため、ここから先へ出す前に必ず
 * preprocess.ts の sanitizeConversation を通す。Adapter 自体は
 * 永続化も外部送信もしない。
 *
 * ファイル/行の破損は黙って捨てず onWarning で報告する（RULE-004）。
 * 「履歴があるのに0件」は利用者が気付けない失敗である。
 */

/** fs.promises のうち Adapter が使う最小の面。テストで差し替える。 */
export interface ScanFs {
  readdir(dir: string): Promise<{ name: string; isFile(): boolean; isDirectory(): boolean }[]>;
  readFile(file: string): Promise<string>;
  stat(file: string): Promise<{ mtimeMs: number; isFile(): boolean; isDirectory(): boolean }>;
}

export interface AdapterDeps {
  fs: ScanFs;
  /** 候補の保存ディレクトリ。省略時は OS ごとの既定を使う。 */
  roots?: readonly string[];
}

const TITLE_MAX_LENGTH = 80;
/** 1会話の生本文の読み取り上限。前処理でさらに絞るための安全弁。 */
const RAW_BODY_MAX_LENGTH = 200_000;
/** 1ソースからスキャンするファイル数の上限。 */
const MAX_FILES_PER_SOURCE = 2_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function titleFrom(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) return undefined;
  return singleLine.slice(0, TITLE_MAX_LENGTH);
}

/** ディレクトリを再帰的に歩き、pattern に合うファイルのパスを返す。 */
async function walkFiles(
  fs: ScanFs,
  dir: string,
  match: (name: string) => boolean,
  depth: number,
  found: string[],
): Promise<void> {
  if (depth > 8 || found.length >= MAX_FILES_PER_SOURCE) return;
  let entries: Awaited<ReturnType<ScanFs["readdir"]>>;
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 無い・読めないディレクトリは「ソースが無い」の正常系。
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") return;
    throw error;
  }
  for (const entry of entries) {
    if (found.length >= MAX_FILES_PER_SOURCE) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fs, full, match, depth + 1, found);
    } else if (entry.isFile() && match(entry.name)) {
      found.push(full);
    }
  }
}

interface JsonlConversationMeta {
  sourceId: string;
  observedAt?: string;
  ref: string;
}

/**
 * JSONL 形式の会話ログを1ファイル1会話として読み出す。
 *
 * `extractLine` は各行から発話テキストを取り出す。形式の違いは
 * この関数に閉じ込め、走査の流れは共通化する。
 */
async function* scanJsonlFiles(
  fs: ScanFs,
  files: readonly string[],
  extractLine: (line: Record<string, unknown>, texts: string[]) => void,
  options?: { sinceMs?: number; onWarning?: (warning: string) => void },
): AsyncGenerator<RawConversation> {
  for (const file of files) {
    let stat: Awaited<ReturnType<ScanFs["stat"]>>;
    try {
      stat = await fs.stat(file);
    } catch (error) {
      options?.onWarning?.(`${file} の状態を取得できませんでした: ${String(error)}`);
      continue;
    }
    if (options?.sinceMs !== undefined && stat.mtimeMs <= options.sinceMs) continue;

    let content: string;
    try {
      content = await fs.readFile(file);
    } catch (error) {
      options?.onWarning?.(`${file} を読めませんでした: ${String(error)}`);
      continue;
    }

    const meta: JsonlConversationMeta = {
      // sourceId は API へ保存される Evidence ID の一部になるため、
      // ローカルの絶対パス（ユーザー名を含みうる）をそのまま入れない。
      sourceId: sha256(file),
      ref: sha256(file),
    };
    const texts: string[] = [];
    let skipped = 0;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        skipped += 1;
        continue;
      }
      if (typeof record !== "object" || record === null) {
        skipped += 1;
        continue;
      }
      const row = record as Record<string, unknown>;
      if (meta.observedAt === undefined && typeof row.timestamp === "string") {
        meta.observedAt = row.timestamp;
      }
      extractLine(row, texts);
    }
    if (skipped > 0) {
      options?.onWarning?.(`${file} の ${String(skipped)} 行を読み飛ばしました（形式が不正）。`);
    }
    const body = texts.join("\n\n").trim();
    if (body.length === 0) continue;
    yield {
      sourceId: meta.sourceId,
      ...(meta.observedAt === undefined ? {} : { observedAt: meta.observedAt }),
      ...(titleFrom(texts[0]) === undefined ? {} : { title: titleFrom(texts[0]) }),
      body: body.slice(0, RAW_BODY_MAX_LENGTH),
      externalRefHash: meta.ref,
    };
  }
}

/** `payload.type === "message"` の content 配列から text を取り出す。 */
function readContentText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (typeof part !== "object" || part === null) continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) texts.push(text);
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Codex（~/.codex/sessions/**/rollout-*.jsonl）
// ---------------------------------------------------------------------------

/** Codex rollout 行から発話テキストを抽出する。 */
function extractCodexLine(row: Record<string, unknown>, texts: string[]): void {
  const payload = row.payload;
  if (typeof payload !== "object" || payload === null) return;
  const data = payload as Record<string, unknown>;
  if (data.type === "message") {
    texts.push(...readContentText(data.content));
    return;
  }
  // event_msg 形式: {type:"user_message", message:"..."} / agent_message
  if (
    (data.type === "user_message" || data.type === "agent_message") &&
    typeof data.message === "string"
  ) {
    texts.push(data.message);
  }
}

export function createCodexAdapter(deps: AdapterDeps): HistorySourceAdapter {
  const roots = deps.roots ?? [path.join(homedir(), ".codex", "sessions")];
  return {
    provider: "codex",
    async detect(): Promise<HistorySourceDetection> {
      const files: string[] = [];
      for (const root of roots) await walkFiles(deps.fs, root, isCodexFile, 0, files);
      return files.length === 0
        ? { available: false, detail: "~/.codex/sessions に会話ログが見つかりませんでした。" }
        : {
            available: true,
            estimatedCount: files.length,
            detail: `${String(files.length)} 件のセッションが見つかりました。`,
          };
    },
    async *scan(options) {
      const files: string[] = [];
      for (const root of roots) await walkFiles(deps.fs, root, isCodexFile, 0, files);
      yield* scanJsonlFiles(deps.fs, files, extractCodexLine, options);
    },
  };
}

function isCodexFile(name: string): boolean {
  return name.endsWith(".jsonl");
}

// ---------------------------------------------------------------------------
// Claude Code（~/.claude/projects/*/*.jsonl）
// ---------------------------------------------------------------------------

/** Claude Code の行から発話テキストを抽出する。 */
function extractClaudeCodeLine(row: Record<string, unknown>, texts: string[]): void {
  const message = row.message;
  if (typeof message !== "object" || message === null) return;
  const content = (message as { content?: unknown }).content;
  texts.push(...readContentText(content));
}

export function createClaudeCodeAdapter(deps: AdapterDeps): HistorySourceAdapter {
  const roots = deps.roots ?? [path.join(homedir(), ".claude", "projects")];
  return {
    provider: "claude-code",
    async detect(): Promise<HistorySourceDetection> {
      const files: string[] = [];
      for (const root of roots) await walkFiles(deps.fs, root, isClaudeCodeFile, 0, files);
      return files.length === 0
        ? { available: false, detail: "~/.claude/projects に会話ログが見つかりませんでした。" }
        : {
            available: true,
            estimatedCount: files.length,
            detail: `${String(files.length)} 件のセッションが見つかりました。`,
          };
    },
    async *scan(options) {
      const files: string[] = [];
      for (const root of roots) await walkFiles(deps.fs, root, isClaudeCodeFile, 0, files);
      yield* scanJsonlFiles(deps.fs, files, extractClaudeCodeLine, options);
    },
  };
}

function isClaudeCodeFile(name: string): boolean {
  return name.endsWith(".jsonl");
}

// ---------------------------------------------------------------------------
// VS Code（workspaceStorage/*/chatSessions/*.json — Copilot チャット履歴）
// ---------------------------------------------------------------------------

function defaultVSCodeRoots(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "Code", "User", "workspaceStorage"),
      path.join(
        home,
        "Library",
        "Application Support",
        "Code - Insiders",
        "User",
        "workspaceStorage",
      ),
    ];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return [path.join(appData, "Code", "User", "workspaceStorage")];
  }
  return [path.join(home, ".config", "Code", "User", "workspaceStorage")];
}

/**
 * chatSessions/*.json の行ではなく1ファイル全体が JSON。
 * requests[].message.text を発話として拾う。形式は VS Code の
 * バージョンで変わりうるため、取れなければ警告して読み飛ばす。
 */
function extractVSCodeSession(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const requests = (value as { requests?: unknown }).requests;
  if (!Array.isArray(requests)) return [];
  const texts: string[] = [];
  for (const request of requests) {
    if (typeof request !== "object" || request === null) continue;
    const message = (request as { message?: unknown }).message;
    if (typeof message === "object" && message !== null) {
      const text = (message as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) texts.push(text);
    }
  }
  return texts;
}

export function createVSCodeAdapter(deps: AdapterDeps): HistorySourceAdapter {
  const roots = deps.roots ?? defaultVSCodeRoots();

  async function collectFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const root of roots) {
      let workspaces: Awaited<ReturnType<ScanFs["readdir"]>>;
      try {
        workspaces = await deps.fs.readdir(root);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
          continue;
        }
        throw error;
      }
      for (const workspace of workspaces) {
        if (!workspace.isDirectory()) continue;
        await walkFiles(
          deps.fs,
          path.join(root, workspace.name, "chatSessions"),
          (name) => name.endsWith(".json"),
          0,
          files,
        );
      }
    }
    return files;
  }

  return {
    provider: "vscode",
    async detect(): Promise<HistorySourceDetection> {
      const files = await collectFiles();
      return files.length === 0
        ? { available: false, detail: "VS Code のチャット履歴が見つかりませんでした。" }
        : {
            available: true,
            estimatedCount: files.length,
            detail: `${String(files.length)} 件のチャットセッションが見つかりました。`,
          };
    },
    async *scan(options) {
      for (const file of await collectFiles()) {
        let stat: Awaited<ReturnType<ScanFs["stat"]>>;
        try {
          stat = await deps.fs.stat(file);
        } catch (error) {
          options?.onWarning?.(`${file} の状態を取得できませんでした: ${String(error)}`);
          continue;
        }
        if (options?.sinceMs !== undefined && stat.mtimeMs <= options.sinceMs) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(await deps.fs.readFile(file));
        } catch (error) {
          options?.onWarning?.(`${file} を読み飛ばしました: ${String(error)}`);
          continue;
        }
        const texts = extractVSCodeSession(parsed);
        const body = texts.join("\n\n").trim();
        if (body.length === 0) continue;
        yield {
          // 絶対パスは保存先へ漏らさない（sourceId は Evidence ID の一部）。
          sourceId: sha256(file),
          observedAt: new Date(stat.mtimeMs).toISOString(),
          ...(titleFrom(texts[0]) === undefined ? {} : { title: titleFrom(texts[0]) }),
          body: body.slice(0, RAW_BODY_MAX_LENGTH),
          externalRefHash: sha256(file),
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// エクスポートファイル（ChatGPT / Claude の conversations.json 等）
// ---------------------------------------------------------------------------

export interface ExportFileDeps {
  fs: ScanFs;
  /** ユーザーが選んだファイルのパス。 */
  filePath: string;
}

function extractExportConversation(value: unknown): { title?: string; texts: string[] } | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;

  // ChatGPT: {title, mapping: {id: {message: {author:{role}, content:{parts:[...]}}}}}
  if (typeof item.mapping === "object" && item.mapping !== null) {
    const texts: string[] = [];
    for (const node of Object.values(item.mapping)) {
      const message = (node as { message?: unknown }).message;
      if (typeof message !== "object" || message === null) continue;
      const role = (message as { author?: unknown }).author;
      const roleName =
        typeof role === "object" && role !== null ? (role as { role?: unknown }).role : undefined;
      if (roleName !== "user" && roleName !== "assistant") continue;
      const content = (message as { content?: unknown }).content;
      const parts =
        typeof content === "object" && content !== null
          ? (content as { parts?: unknown }).parts
          : undefined;
      if (Array.isArray(parts)) {
        texts.push(...parts.filter((part): part is string => typeof part === "string"));
      }
    }
    return {
      ...(titleFrom(typeof item.title === "string" ? item.title : undefined) === undefined
        ? {}
        : { title: titleFrom(item.title as string) }),
      texts,
    };
  }

  // Claude: {name, chat_messages: [{sender: "human"|"assistant", text}]}
  if (Array.isArray(item.chat_messages)) {
    const texts: string[] = [];
    for (const message of item.chat_messages) {
      if (typeof message !== "object" || message === null) continue;
      const text = (message as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) texts.push(text);
    }
    const name = typeof item.name === "string" ? item.name : undefined;
    return { ...(name === undefined ? {} : { title: titleFrom(name) }), texts };
  }

  return null;
}

/**
 * ユーザーが選んだエクスポートファイルを読む Adapter。
 *
 * `provider` は取り込み元の AI（"chatgpt" / "claude" 等）。
 * `importedBy` は呼び出し側が "file" にする。
 */
export function createExportFileAdapter(
  provider: HistoryProviderId,
  deps: ExportFileDeps,
): HistorySourceAdapter {
  return {
    provider,
    async detect(): Promise<HistorySourceDetection> {
      try {
        const stat = await deps.fs.stat(deps.filePath);
        if (!stat.isFile()) {
          return { available: false, detail: "選択されたのはファイルではありません。" };
        }
        return { available: true, detail: deps.filePath };
      } catch {
        return { available: false, detail: "ファイルが見つかりませんでした。" };
      }
    },
    async *scan(options) {
      // エクスポートは全体を読む。増分は毎回同じファイルを処理し、
      // 重複は externalRefHash で潰す（domain の scan 契約）。
      void options?.sinceMs;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await deps.fs.readFile(deps.filePath));
      } catch (error) {
        options?.onWarning?.(`エクスポートファイルを読めませんでした: ${String(error)}`);
        return;
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      let skipped = 0;
      for (const [index, item] of list.entries()) {
        const conversation = extractExportConversation(item);
        if (conversation === null || conversation.texts.length === 0) {
          skipped += 1;
          continue;
        }
        const body = conversation.texts.join("\n\n").trim();
        if (body.length === 0) {
          skipped += 1;
          continue;
        }
        const createdAt = readExportCreatedAt(item);
        yield {
          // 絶対パスは保存先へ漏らさない（sourceId は Evidence ID の一部）。
          sourceId: sha256(`${deps.filePath}#${String(index)}`),
          ...(createdAt === undefined ? {} : { observedAt: createdAt }),
          ...(conversation.title === undefined ? {} : { title: conversation.title }),
          body: body.slice(0, RAW_BODY_MAX_LENGTH),
          externalRefHash: sha256(`${deps.filePath}#${String(index)}`),
        };
      }
      if (skipped > 0) {
        options?.onWarning?.(
          `エクスポート内の ${String(skipped)} 件を読み飛ばしました（形式が不明）。`,
        );
      }
    },
  };
}

/** ChatGPT `create_time` / Claude `created_at` を ISO へ。 */
function readExportCreatedAt(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const record = item as Record<string, unknown>;
  if (typeof record.created_at === "string") return record.created_at;
  if (typeof record.create_time === "number") {
    return new Date(record.create_time * 1000).toISOString();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 既定のソース一覧
// ---------------------------------------------------------------------------

/**
 * 自動検出するソースの一覧を作る。
 * エクスポートファイルはユーザーが都度選ぶためここには含めない。
 */
export function createAutoAdapters(fs: ScanFs): HistorySourceAdapter[] {
  return [createCodexAdapter({ fs }), createClaudeCodeAdapter({ fs }), createVSCodeAdapter({ fs })];
}
