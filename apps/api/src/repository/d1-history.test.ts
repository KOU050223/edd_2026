/// <reference types="node" />
import { afterEach, expect, test } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { D1ImportSessionRepository, D1LearningEvidenceRepository } from "./d1.js";
import type { StoredImportSessionInput } from "./types.js";
import type { LearningEvidence } from "@gakushu-sochi/domain";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** Executes the actual repository SQL against SQLite, without starting D1. */
function repositories() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('a'), ('b'); CREATE TABLE account_deletions(user_id TEXT, started_at_ms INTEGER);",
  );
  sqlite.exec(
    readFileSync(new URL("../../migrations/0008_history_import.sql", import.meta.url), "utf8"),
  );
  sqlite.exec(
    readFileSync(
      new URL("../../migrations/0021_history_observation_keys.sql", import.meta.url),
      "utf8",
    ),
  );
  function prepare(sql: string) {
    let params: SQLInputValue[] = [];
    const statement = {
      bind(...values: SQLInputValue[]) {
        params = values;
        return statement;
      },
      async first() {
        return sqlite.prepare(sql).get(...params) ?? null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...params) };
      },
      async run() {
        return { meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } };
      },
    };
    return statement;
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return {
    sessions: new D1ImportSessionRepository(db),
    evidence: new D1LearningEvidenceRepository(db),
    sqlite,
  };
}

const session = (id: string): StoredImportSessionInput => ({
  id,
  importedBy: "file",
  providers: ["claude-code"],
  conversationCount: 1,
  ignoredCount: 0,
  unmappedCandidates: [],
  evidenceCount: 1,
  conceptCount: 1,
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});
const item = (id: string, conceptId = "go.defer"): LearningEvidence => ({
  id: `${id}:claude-code:question:${conceptId}`,
  observationKey: "a".repeat(64),
  conceptIds: [conceptId],
  source: { provider: "claude-code", importedBy: "file" },
  kind: "question",
  confidence: 0.8,
  importSessionId: id,
  observedAt: "2025-01-01T00:00:00Z",
});

test("SQL の一意制約で別セッションへの二重計上を防ぎ、実際の追加件数を返す", async () => {
  const { sessions, evidence } = repositories();
  await sessions.createWithEvidence("a", session("s1"), [item("s1")]);
  await sessions.createWithEvidence("a", session("s2"), [item("s2")]);

  expect(await evidence.listByUser("a")).toHaveLength(1);
  expect((await sessions.getById("a", "s2"))!.session.evidenceCount).toBe(0);
  expect((await sessions.getById("a", "s2"))!.session.conceptCount).toBe(0);
  expect((await evidence.listByUser("a"))[0]!.observationKey).toBe("a".repeat(64));
});

test("別 Concept・別利用者は同じ観測キーでも追加でき、Undo は既存の観測を残す", async () => {
  const { sessions, evidence } = repositories();
  await sessions.createWithEvidence("a", session("s1"), [item("s1")]);
  await sessions.createWithEvidence("a", session("s2"), [item("s2", "go.error")]);
  await sessions.createWithEvidence("b", session("s1"), [item("s1")]);
  await sessions.undo("a", "s2", "2026-10-11T00:00:00Z");

  expect((await evidence.listByUser("a")).map((entry) => entry.conceptIds)).toEqual([["go.defer"]]);
  expect(await evidence.listByUser("b")).toHaveLength(1);
  await sessions.undo("a", "s1", "2026-10-11T00:00:00Z");
  await sessions.createWithEvidence("a", session("s3"), [item("s3")]);
  expect(await evidence.listByUser("a")).toHaveLength(1);
});

test("取り消し済みセッションを再送しても観測を復活させない", async () => {
  const { sessions, evidence } = repositories();
  await sessions.createWithEvidence("a", session("s1"), [item("s1")]);
  await sessions.undo("a", "s1", "2026-10-11T00:00:00Z");
  const retry = await sessions.createWithEvidence("a", session("s1"), [item("s1")]);

  expect(retry.alreadyExisted).toBe(true);
  expect(await evidence.listByUser("a")).toEqual([]);
  expect((await sessions.getById("a", "s1"))!.session.status).toBe("undone");
});
