import { describe, expect, it } from "vitest";

import type { RawConversation } from "@gakushu-sochi/domain";

import {
  createClaudeCodeAdapter,
  createCodexAdapter,
  createExportFileAdapter,
  createVSCodeAdapter,
  type ScanFs,
} from "./sources.js";

interface FakeEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** { "dir/file.jsonl": "content" } のフラットな表から ScanFs を作る。 */
function fakeFs(files: Record<string, string>, mtimes: Record<string, number> = {}): ScanFs {
  const dirs = new Map<string, Set<string>>();
  const fileSet = new Set(Object.keys(files));
  for (const key of Object.keys(files)) {
    const parts = key.split("/");
    for (let i = 1; i <= parts.length; i += 1) {
      const parent = parts.slice(0, i).join("/");
      const child = parts[i];
      if (child === undefined) continue;
      if (!dirs.has(parent)) dirs.set(parent, new Set());
      dirs.get(parent)?.add(child);
    }
  }
  return {
    readdir: (dir) => {
      const children = dirs.get(dir);
      if (!children) {
        return Promise.reject(Object.assign(new Error(`ENOENT: ${dir}`), { code: "ENOENT" }));
      }
      const entries: FakeEntry[] = [...children].map((name) => {
        const full = `${dir}/${name}`;
        const isFile = fileSet.has(full);
        return {
          name,
          isFile: () => isFile,
          isDirectory: () => !isFile,
        };
      });
      return Promise.resolve(entries);
    },
    readFile: (file) => {
      if (!(file in files)) {
        return Promise.reject(Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" }));
      }
      return Promise.resolve(files[file] ?? "");
    },
    stat: (file) => {
      const isFile = fileSet.has(file);
      const isDir = dirs.has(file);
      if (!isFile && !isDir) {
        return Promise.reject(Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" }));
      }
      return Promise.resolve({
        mtimeMs: mtimes[file] ?? 1_000,
        isFile: () => isFile,
        isDirectory: () => isDir,
      });
    },
  };
}

async function collect(iter: AsyncIterable<RawConversation>): Promise<RawConversation[]> {
  const result: RawConversation[] = [];
  for await (const item of iter) result.push(item);
  return result;
}

describe("createCodexAdapter", () => {
  const rollout = [
    JSON.stringify({
      timestamp: "2024-01-02T03:04:05Z",
      type: "session_meta",
      payload: { id: "abc" },
    }),
    JSON.stringify({
      timestamp: "2024-01-02T03:04:06Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "pointer receiver について教えて" }],
      },
    }),
    JSON.stringify({
      timestamp: "2024-01-02T03:04:07Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "pointer receiver は…" }],
      },
    }),
  ].join("\n");

  it("detects sessions under ~/.codex/sessions", async () => {
    const fs = fakeFs({ "sessions/2024/01/02/rollout-a.jsonl": rollout });
    const adapter = createCodexAdapter({ fs, roots: ["sessions"] });
    const detection = await adapter.detect();
    expect(detection.available).toBe(true);
    expect(detection.estimatedCount).toBe(1);
  });

  it("is unavailable when no logs exist", async () => {
    const fs = fakeFs({});
    const adapter = createCodexAdapter({ fs, roots: ["sessions"] });
    expect((await adapter.detect()).available).toBe(false);
  });

  it("yields one conversation per rollout file", async () => {
    const fs = fakeFs({ "sessions/a.jsonl": rollout });
    const adapter = createCodexAdapter({ fs, roots: ["sessions"] });
    const conversations = await collect(adapter.scan());
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.body).toContain("pointer receiver について教えて");
    expect(conversations[0]?.body).toContain("pointer receiver は…");
    expect(conversations[0]?.observedAt).toBe("2024-01-02T03:04:05Z");
  });

  it("reports malformed lines via onWarning without aborting", async () => {
    const fs = fakeFs({ "sessions/a.jsonl": `${rollout}\n{broken` });
    const adapter = createCodexAdapter({ fs, roots: ["sessions"] });
    const warnings: string[] = [];
    const conversations = await collect(adapter.scan({ onWarning: (w) => warnings.push(w) }));
    expect(conversations).toHaveLength(1);
    expect(warnings.some((w) => w.includes("読み飛ば"))).toBe(true);
  });

  it("skips files older than sinceMs", async () => {
    const fs = fakeFs(
      { "sessions/old.jsonl": rollout, "sessions/new.jsonl": rollout },
      { "sessions/old.jsonl": 100, "sessions/new.jsonl": 5_000 },
    );
    const adapter = createCodexAdapter({ fs, roots: ["sessions"] });
    const conversations = await collect(adapter.scan({ sinceMs: 1_000 }));
    expect(conversations).toHaveLength(1);
    // sourceId は Evidence ID の一部として API へ保存されるため、
    // ローカルパスではなく決定的なハッシュであること。
    expect(conversations[0]?.sourceId).toMatch(/^[0-9a-f]{64}$/);
    expect(conversations[0]?.sourceId).not.toBe("sessions/new.jsonl");
  });
});

describe("createClaudeCodeAdapter", () => {
  const session = [
    JSON.stringify({
      type: "user",
      timestamp: "2024-02-01T00:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "error handling の書き方" }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "if err != nil で…" }] },
    }),
  ].join("\n");

  it("reads conversations from project jsonl files", async () => {
    const fs = fakeFs({ "projects/p1/session.jsonl": session });
    const adapter = createClaudeCodeAdapter({ fs, roots: ["projects"] });
    expect((await adapter.detect()).available).toBe(true);
    const conversations = await collect(adapter.scan());
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.body).toContain("error handling の書き方");
    expect(conversations[0]?.observedAt).toBe("2024-02-01T00:00:00Z");
  });
});

describe("createVSCodeAdapter", () => {
  const chat = JSON.stringify({
    requests: [
      { message: { text: "React の useState について" } },
      { message: { text: "useEffect との違いは?" } },
    ],
  });

  it("reads requests[].message.text from chatSessions", async () => {
    const fs = fakeFs({
      "ws/w1/chatSessions/s1.json": chat,
    });
    const adapter = createVSCodeAdapter({ fs, roots: ["ws"] });
    expect((await adapter.detect()).available).toBe(true);
    const conversations = await collect(adapter.scan());
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.body).toContain("useState");
  });

  it("warns and skips unreadable session files", async () => {
    const fs = fakeFs({ "ws/w1/chatSessions/broken.json": "{not json" });
    const adapter = createVSCodeAdapter({ fs, roots: ["ws"] });
    const warnings: string[] = [];
    const conversations = await collect(adapter.scan({ onWarning: (w) => warnings.push(w) }));
    expect(conversations).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});

describe("createExportFileAdapter", () => {
  it("reads ChatGPT conversations.json exports", async () => {
    const exportJson = JSON.stringify([
      {
        title: "Go の質問",
        create_time: 1_704_000_000,
        mapping: {
          n1: {
            message: {
              author: { role: "user" },
              content: { parts: ["goroutine について教えて"] },
            },
          },
          n2: {
            message: {
              author: { role: "assistant" },
              content: { parts: ["goroutine は軽量な…"] },
            },
          },
        },
      },
    ]);
    const fs = fakeFs({ "exports/conversations.json": exportJson });
    const adapter = createExportFileAdapter("chatgpt", {
      fs,
      filePath: "exports/conversations.json",
    });
    expect((await adapter.detect()).available).toBe(true);
    const conversations = await collect(adapter.scan());
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe("Go の質問");
    expect(conversations[0]?.body).toContain("goroutine について教えて");
    expect(conversations[0]?.observedAt).toBe(new Date(1_704_000_000_000).toISOString());
  });

  it("reads Claude exports with chat_messages", async () => {
    const exportJson = JSON.stringify([
      {
        name: "TypeScript の質問",
        created_at: "2024-03-01T00:00:00Z",
        chat_messages: [
          { sender: "human", text: "型の絞り込みを教えて" },
          { sender: "assistant", text: "typeof や instanceof で…" },
        ],
      },
    ]);
    const fs = fakeFs({ "exports/claude.json": exportJson });
    const adapter = createExportFileAdapter("claude", { fs, filePath: "exports/claude.json" });
    const conversations = await collect(adapter.scan());
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.observedAt).toBe("2024-03-01T00:00:00Z");
  });

  it("warns about unparseable export files", async () => {
    const fs = fakeFs({ "exports/broken.json": '[{"unexpected": true}]' });
    const adapter = createExportFileAdapter("chatgpt", { fs, filePath: "exports/broken.json" });
    const warnings: string[] = [];
    const conversations = await collect(adapter.scan({ onWarning: (w) => warnings.push(w) }));
    expect(conversations).toHaveLength(0);
    expect(warnings.some((w) => w.includes("読み飛ば"))).toBe(true);
  });
});
