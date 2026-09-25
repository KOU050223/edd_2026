/**
 * packages/domain/concepts.md の Concept 一覧テーブルから src/concepts.generated.ts を書き出す。
 *
 * Concept 一覧の正典は packages/domain/concepts.md である。このスクリプトは新しい情報を作らず、
 * 同じ内容を実行時に import できる形へ写すだけである。
 * 命名規則や追加手順といったルールは docs/concepts.md にある。
 *
 *   npm run gen:concepts          生成する
 *   npm run gen:concepts -- --check   生成せず、既存ファイルとの差分があれば失敗する（CI用）
 */

import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "concepts.md";
const TARGET = "src/concepts.generated.ts";
const CONCEPT_ID_PATTERN = /^[a-z0-9]+\.[a-z0-9_]+$/;

/**
 * concepts.md の一覧テーブルから1行ずつ Concept を読む。
 *
 * 列は `ID | 表示名 | 概要 | 前提` の順で、**位置で読む。** 見出しの文字列では引かない。
 * 列を増やすときは、この正規表現と下の分解、`docs/concepts.md` の手順を揃えて変えること。
 * 4列に足りない行は1件も拾わないので、列を足しただけで中身を書き忘れれば
 * `concepts.length === 0` として validate() で落ちる。
 *
 * ID と前提 ID はバッククォートで囲まれていれば形式を問わず拾う。
 * ここで妥当な形式だけに絞ると、`go.pointer-receiver` のような書き間違いが
 * 行ごと（前提なら値ごと）黙って消え、検証を素通りして生成が成功してしまう。
 * 妥当性の判断は validate() に一本化する。
 */
function parseConcepts(markdown) {
  const rows = [...markdown.matchAll(/^\|\s*`([^`|]*)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/gm)];
  return rows.map(([, id, label, summary, prerequisites]) => ({
    id: id.trim(),
    // 表示名は UI にそのまま出す。md のインラインコード記法は表示上の装飾なので剥がす。
    label: label.replaceAll("`", "").trim(),
    language: id.trim().split(".")[0],
    // 概要も同じ理由で剥がす。UI と AI へのプロンプトの両方へ素のまま渡る（#184）。
    summary: summary.replaceAll("`", "").trim(),
    prerequisites: [...prerequisites.matchAll(/`([^`|]*)`/g)].map((m) => m[1].trim()),
    source: { kind: "manual" },
  }));
}

/** 一覧そのものの妥当性を検査する。生成前に落とし、壊れた定義をコミットさせない。 */
function validate(concepts) {
  const errors = [];
  const ids = concepts.map((c) => c.id);

  if (concepts.length === 0) {
    errors.push(`${SOURCE} から Concept 一覧を抽出できなかった`);
  }

  for (const c of concepts) {
    if (!CONCEPT_ID_PATTERN.test(c.id)) {
      errors.push(`命名規則違反: ${c.id}`);
    }
    if (c.label === "") {
      errors.push(`表示名が空: ${c.id}`);
    }
    // 生成物では表示名を二重引用符で囲むため、含まれていると壊れる。
    if (c.label.includes('"') || c.label.includes("\\")) {
      errors.push(`表示名に " または \\ を含められない: ${c.id}`);
    }
    // 概要は全件が持つ。型は summary?: string だが、空欄を許すと確認問題の生成（#184）が
    // 表示名1行だけを入力に走り、問題の粒度が Concept ごとにばらける。
    // 「まだ書いていない」を undefined として通すのではなく、ここで落とす。
    if (c.summary === "") {
      errors.push(`概要が空: ${c.id}`);
    }
    if (c.summary.includes('"') || c.summary.includes("\\")) {
      errors.push(`概要に " または \\ を含められない: ${c.id}`);
    }
  }

  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    errors.push(`重複した Concept ID: ${id}`);
  }

  const known = new Set(ids);
  for (const c of concepts) {
    const prefix = c.id.split(".")[0];
    for (const p of c.prerequisites) {
      if (!CONCEPT_ID_PATTERN.test(p)) {
        errors.push(`前提の命名規則違反: ${c.id} -> ${p}`);
      } else if (!known.has(p)) {
        errors.push(`未定義の前提を参照している: ${c.id} -> ${p}`);
      } else if (p.split(".")[0] !== prefix) {
        // プレフィックスをまたぐ前提は Learning Map の木に描かれない（layoutTree は
        // プレフィックスごとに定義を絞る）。受理すると辺が静かに落ちるため拒否する。
        errors.push(`前提は同じプレフィックスに限る: ${c.id} -> ${p}`);
      }
    }
  }

  // 前提が循環すると Skill Tree を辿る処理が停止しなくなる。
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const state = new Map();
  const walk = (id, path) => {
    if (state.get(id) === "done") {
      return;
    }
    if (state.get(id) === "visiting") {
      errors.push(`前提が循環している: ${[...path, id].join(" -> ")}`);
      return;
    }
    state.set(id, "visiting");
    for (const p of byId.get(id)?.prerequisites ?? []) {
      walk(p, [...path, id]);
    }
    state.set(id, "done");
  };
  for (const id of ids) {
    walk(id, []);
  }

  return errors;
}

function render(concepts) {
  const entries = concepts
    .map((c) => {
      const prerequisites = c.prerequisites.map((p) => `"${p}"`).join(", ");
      return [
        "  {",
        `    id: "${c.id}",`,
        `    label: "${c.label}",`,
        `    language: "${c.language}",`,
        `    summary: "${c.summary}",`,
        `    prerequisites: [${prerequisites}],`,
        `    source: { kind: "manual" },`,
        "  },",
      ].join("\n");
    })
    .join("\n");

  return [
    "// このファイルは自動生成される。直接編集しない。",
    `// 一覧の正典は ${SOURCE}。編集したら npm run gen:concepts を実行する。`,
    "",
    'import type { Concept, ConceptId } from "./profile";',
    "",
    `/** ${SOURCE} で定義された Concept の一覧。定義順は学習の推奨順を兼ねる。 */`,
    "export const CONCEPTS: readonly Concept[] = [",
    entries,
    "];",
    "",
    "/** Concept ID から定義を引く。未知の ID では undefined を返す。 */",
    "export const CONCEPT_BY_ID: ReadonlyMap<ConceptId, Concept> = new Map(",
    "  CONCEPTS.map((concept) => [concept.id, concept]),",
    ");",
    "",
  ].join("\n");
}

const concepts = parseConcepts(readFileSync(SOURCE, "utf8"));
const errors = validate(concepts);

if (errors.length > 0) {
  console.error(`${SOURCE} の Concept 一覧に問題があります:`);
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

const rendered = render(concepts);

if (process.argv.includes("--check")) {
  let current = null;
  try {
    current = readFileSync(TARGET, "utf8");
  } catch {
    console.error(`${TARGET} がありません。npm run gen:concepts を実行してください。`);
    process.exit(1);
  }
  if (current !== rendered) {
    console.error(
      `${TARGET} が ${SOURCE} と一致しません。npm run gen:concepts を実行してください。`,
    );
    process.exit(1);
  }
  console.log(`OK: ${TARGET} は ${SOURCE} と一致しています（Concept ${concepts.length}件）`);
} else {
  writeFileSync(TARGET, rendered);
  console.log(`生成しました: ${TARGET}（Concept ${concepts.length}件）`);
}
