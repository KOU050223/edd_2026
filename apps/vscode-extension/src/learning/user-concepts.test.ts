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

test("手作りのノードを、表示名にマップの題名を添えた Concept と項目へ変える", () => {
  expect(toUserConcepts({ concepts: [NODE] })).toEqual({
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
  expect(toUserConcepts({ concepts: [] })).toEqual({ concepts: [], objectives: [] });
});

test.each([
  ["concepts が無い", {}],
  ["concepts が配列でない", { concepts: "x" }],
  ["表示名が無い", { concepts: [{ ...NODE, label: undefined }] }],
  ["ID が Concept ID の形でない", { concepts: [{ ...NODE, id: "所有権" }] }],
  ["前提が文字列の配列でない", { concepts: [{ ...NODE, prerequisites: [1] }] }],
  [
    "項目の ID が別のノードのもの",
    { concepts: [{ ...NODE, objectives: [{ id: "mrust0001.other001:x", label: "x" }] }] },
  ],
])("形が契約と違えば、一部だけ使わずに全体を失敗にする（%s）", (_name, body) => {
  expect(toUserConcepts(body)).toBeUndefined();
});
