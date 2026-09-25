import { expect, test } from "vitest";
import { knownConceptsFor } from "./known-concepts.js";

test("言語のConceptに加えて、領域横断のConceptも対象に含める", () => {
  const ids = knownConceptsFor("typescript").map((concept) => concept.id);

  // languageId が typescript なら ts.* と領域横断の Concept が載り、
  // 他言語の Concept は載らない。
  expect(ids).toContain("ts.variable_declaration");
  expect(ids).toContain("git.commit");
  expect(ids).toContain("db.relational_model");
  expect(ids).toContain("design.naming");
  expect(ids).toContain("http.request_response");
  expect(ids).not.toContain("go.variable_declaration");
  expect(ids).not.toContain("python.control_flow");
});

test("javascript は ts.* の Concept へ統一する", () => {
  const ids = knownConceptsFor("javascript").map((concept) => concept.id);

  // TypeScript と JavaScript の共通概念は、習熟度が分散しないよう ts.* に統一する。
  expect(ids).toContain("ts.async_await");
  expect(ids).not.toContain("go.variable_declaration");
});

test("go のときは go.* と領域横断だけが対象になる", () => {
  const ids = knownConceptsFor("go").map((concept) => concept.id);

  expect(ids).toContain("go.error_handling");
  expect(ids).toContain("git.commit");
  expect(ids).not.toContain("ts.variable_declaration");
});

test("languageId が取れないときは領域横断の Concept だけが対象になる", () => {
  const ids = knownConceptsFor(undefined).map((concept) => concept.id);

  expect(ids).toContain("git.commit");
  expect(ids).toContain("db.relational_model");
  expect(ids).not.toContain("go.variable_declaration");
  expect(ids).not.toContain("ts.variable_declaration");
});

test("Concept 一覧に無い言語でも領域横断の Concept だけは対象になる", () => {
  const ids = knownConceptsFor("brainfuck").map((concept) => concept.id);

  expect(ids.length).toBeGreaterThan(0);
  expect(ids).toContain("design.naming");
  expect(ids.every((id) => !id.startsWith("go.") && !id.startsWith("ts."))).toBe(true);
});
