import { expect, test } from "vitest";
import { toUserConcepts } from "./user-concepts";

const NODE = {
  id: "mrust0001.owner001",
  label: "所有権",
  summary: "値の持ち主は1つ。",
  mapId: "mrust0001",
  mapTitle: "Rust 入門",
  prerequisites: ["mrust0001.binding1"],
  objectives: [{ id: "mrust0001.owner001:move", label: "代入で持ち主が移る" }],
};

const FIXED = { id: "go.defer:lifo_order", conceptId: "go.defer", label: "実行順" };

test("手作りのノードを、表示名にマップの題名を添えた Concept と項目へ変える", () => {
  expect(toUserConcepts({ concepts: [NODE], fixedObjectives: [] })).toEqual({
    concepts: [
      {
        id: "mrust0001.owner001",
        label: "所有権（Rust 入門）",
        language: "mrust0001",
        summary: "値の持ち主は1つ。",
        prerequisites: ["mrust0001.binding1"],
        source: { kind: "manual" },
      },
    ],
    objectives: [
      {
        id: "mrust0001.owner001:move",
        conceptId: "mrust0001.owner001",
        label: "代入で持ち主が移る",
      },
    ],
  });
  expect(toUserConcepts({ concepts: [], fixedObjectives: [] })).toEqual({
    concepts: [],
    objectives: [],
  });
});

test("固定の Concept の項目（#245）を、手作りのノードの項目の前に並べる", () => {
  expect(toUserConcepts({ concepts: [NODE], fixedObjectives: [FIXED] })?.objectives).toEqual([
    FIXED,
    { id: "mrust0001.owner001:move", conceptId: "mrust0001.owner001", label: "代入で持ち主が移る" },
  ]);
});

test.each([
  ["concepts が無い", { fixedObjectives: [] }],
  ["concepts が配列でない", { concepts: "x", fixedObjectives: [] }],
  ["表示名が無い", { concepts: [{ ...NODE, label: undefined }], fixedObjectives: [] }],
  ["ID が Concept ID の形でない", { concepts: [{ ...NODE, id: "所有権" }], fixedObjectives: [] }],
  [
    "前提が文字列の配列でない",
    { concepts: [{ ...NODE, prerequisites: [1] }], fixedObjectives: [] },
  ],
  [
    "項目の ID が別のノードのもの",
    {
      concepts: [{ ...NODE, objectives: [{ id: "mrust0001.other001:x", label: "x" }] }],
      fixedObjectives: [],
    },
  ],
  ["固定の項目が無い（古い API）", { concepts: [] }],
  [
    "固定の項目の ID が別の Concept のもの",
    { concepts: [], fixedObjectives: [{ ...FIXED, conceptId: "go.select" }] },
  ],
  ["固定の項目の表示名が無い", { concepts: [], fixedObjectives: [{ ...FIXED, label: undefined }] }],
])("形が契約と違えば、一部だけ使わずに全体を失敗にする（%s）", (_name, body) => {
  expect(toUserConcepts(body)).toBeUndefined();
});
