import { expect, test } from "vitest";
import {
  filterHistory,
  historyLines,
  historyQuestions,
  maskHistory,
  parseClaudeHistory,
  HISTORY_LIMITS,
} from "./local-history.js";

async function* lines(records: unknown[]) {
  for (const record of records) yield typeof record === "string" ? record : JSON.stringify(record);
}
const user = (uuid = "u1", text = "Go の defer は？", timestamp = "2025-01-01T00:00:00Z") => ({
  type: "user",
  uuid,
  sessionId: "s1",
  timestamp,
  message: { role: "user", content: text },
});

test.each(["isMeta", "isSidechain", "isCompactSummary"])(
  "%s の質問に続く回答を前の質問へ添えない",
  async (flag) => {
    const result = await parseClaudeHistory(
      lines([
        user(),
        { ...user("meta", "context summary"), [flag]: true },
        { type: "assistant", message: { role: "assistant", content: "unrelated summary" } },
      ]),
      "p",
      "s",
    );
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]!.body).toBe("ユーザーの質問 (1/1): Go の defer は？");
  },
);

test("本人の質問に周辺回答を添え、ツール出力やシステム挿入文を質問にしない", async () => {
  const result = await parseClaudeHistory(
    lines([
      user(),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", input: "秘密" },
            { type: "text", text: "遅延実行です" },
          ],
        },
      },
      user("u2", "<system-reminder>隠し指示"),
      { ...user("u3"), isMeta: true },
      {
        ...user("u4"),
        message: { role: "user", content: [{ type: "tool_result", content: "API キー" }] },
      },
    ]),
    "p1",
    "s1",
  );

  expect(result.questions).toHaveLength(1);
  expect(result.questions[0]!.body).toBe(
    "ユーザーの質問 (1/1): Go の defer は？\n周辺回答: 遅延実行です",
  );
  expect(result.warnings).toHaveLength(3);
});

test("本文のマスクやフォルダ移動で観測キーが変わらず、入力指紋だけが変わる", async () => {
  const before = await parseClaudeHistory(
    lines([user("u1", "Go /Users/me/private/a")]),
    "p1",
    "old",
  );
  const after = await parseClaudeHistory(
    lines([user("u1", "Go /Users/you/private/b を説明")]),
    "p2",
    "new",
  );

  expect(after.questions[0]!.key).toBe(before.questions[0]!.key);
  expect(after.questions[0]!.fingerprint).not.toBe(before.questions[0]!.fingerprint);
  expect(after.questions[0]!.body).not.toContain("/Users");
});

test("形式不正、未対応、質問なしを成功の0件として隠さない", async () => {
  const broken = await parseClaudeHistory(lines(["{oops", { other: true }]), "p", "s");
  const empty = await parseClaudeHistory(lines([]), "p", "s");
  const missingId = await parseClaudeHistory(lines([{ ...user(), uuid: undefined }]), "p", "s");

  expect(broken.warnings).toContain("行 1: JSON が不正");
  expect(broken.warnings).toContain("Claude Code の発話がない / 未対応形式");
  expect(empty.warnings).toEqual(["履歴なし"]);
  expect(missingId.questions).toEqual([]);
  expect(missingId.warnings[0]).toContain("安定した発話 ID");
});

test("資格情報、メール、Windows と POSIX パスを保存前にマスクする", () => {
  const masked = maskHistory(
    "me@example.com Bearer abcdefghijklmnopqrstuvwxyz C:\\Users\\me\\secret /Users/me/secret password=abcdef",
  );

  expect(masked).toBe("<email> <token> <path> <path> <credential>");
});

test("日時の両端を含み、境界外と別プロジェクトを除外する", async () => {
  const parsed = await parseClaudeHistory(
    lines([
      user("a", "a", "2024-12-31T23:59:59Z"),
      user("b", "b", "2025-01-01T00:00:00Z"),
      user("c", "c", "2025-01-02T23:59:59Z"),
      user("d", "d", "2025-01-03T00:00:00Z"),
    ]),
    "p1",
    "s1",
  );
  const questions = [...parsed.questions, { ...parsed.questions[1]!, key: "other", project: "p2" }];

  const result = filterHistory(questions, "p1", "2025-01-01", "2025-01-02");

  expect(result.map((question) => question.key)).toEqual(
    parsed.questions.slice(1, 3).map((question) => question.key),
  );
  expect(() => filterHistory(questions, "", "2025-01-02", "2025-01-01")).toThrow("期間");
});

test("UTF-8 の分割と末尾の改行なしを読み取り、長すぎる行は拒否する", async () => {
  const result: string[] = [];
  for await (const line of historyLines(new Blob(["日本語\n末尾"]), new AbortController().signal))
    result.push(line);

  expect(result).toEqual(["日本語", "末尾"]);
  const consume = async () => {
    for await (const line of historyLines(
      new Blob(["a".repeat(HISTORY_LIMITS.lineChars + 1)]),
      new AbortController().signal,
    ))
      void line;
  };
  await expect(consume()).rejects.toThrow("上限");
});

test("同じ発話 ID を重複計上せず、後から追加された過去日時の質問も残す", async () => {
  const parsed = await parseClaudeHistory(
    lines([user(), user(), user("late", "過去の追加", "2020-01-01T00:00:00Z")]),
    "p",
    "s",
  );
  const file = { key: "f", project: "p", fingerprint: "hash", size: 1, lastModified: 0, ...parsed };

  const result = historyQuestions([file, { ...file, key: "copy" }]);

  expect(result).toHaveLength(2);
  expect(result[0]!.observedAt).toBe("2020-01-01T00:00:00.000Z");
});

test("同じ発話内のシステム挿入部分を除き、本人の質問を残す", async () => {
  const result = await parseClaudeHistory(
    lines([user("q", "<ide_opened_file>/Users/me/secret</ide_opened_file>\nGo defer を説明して")]),
    "p",
    "s",
  );

  expect(result.questions).toHaveLength(1);
  expect(result.questions[0]!.body).toContain("Go defer を説明して");
  expect(result.questions[0]!.body).not.toContain("ide_opened_file");
  expect(result.warnings[0]).toContain("システム挿入部分");
});

test("長い質問は解析用に分割し、元の観測キーを共有する", async () => {
  const result = await parseClaudeHistory(lines([user("q", "あ".repeat(1_001))]), "p", "s");

  expect(result.questions).toHaveLength(3);
  expect(new Set(result.questions.map((part) => part.observationKey)).size).toBe(1);
  expect(new Set(result.questions.map((part) => part.key)).size).toBe(3);
  expect(result.warnings.at(-1)).toContain("分割");
});
