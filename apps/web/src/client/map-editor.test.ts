import { expect, test } from "vitest";
import { layoutTrees } from "./learning-map.js";
import type { LearningMapView } from "./learning-maps.js";
import {
  addOwnNode,
  addReference,
  draftFromMap,
  draftProblems,
  EDITOR_LIMITS,
  isDirty,
  prerequisiteCandidates,
  previewDefinitions,
  removedSavedNodes,
  removeNode,
  toContentRequest,
  togglePrerequisite,
  updateOwnNode,
  type MapDraft,
} from "./map-editor.js";

const MAP: LearningMapView = {
  id: "mrust0001",
  title: "Rust 入門",
  description: "所有権まで",
  visibility: "private",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  nodes: [
    {
      kind: "own",
      conceptId: "mrust0001.binding1",
      label: "変数",
      summary: "let で束縛する。",
      objectives: [],
    },
    {
      kind: "reference",
      conceptId: "go.defer",
      origin: { label: "defer", mapId: null, objectives: [] },
    },
    {
      kind: "own",
      conceptId: "mrust0001.owner001",
      label: "所有権",
      summary: "持ち主は1つ。",
      objectives: [{ id: "mrust0001.owner001:move", label: "move", source: "manual" }],
    },
  ],
  edges: [{ from: "mrust0001.binding1", to: "mrust0001.owner001" }],
};

const [BINDING, DEFER, OWNER] = ["mrust0001.binding1", "go.defer", "mrust0001.owner001"];

test("保存済みのマップから下書きを作り、そのまま戻すと同じ本文になる", () => {
  const draft = draftFromMap(MAP);
  expect(draft.nodes.map((node) => [node.ref, node.kind, node.label, node.prerequisites])).toEqual([
    [BINDING, "own", "変数", []],
    [DEFER, "reference", "defer", []],
    [OWNER, "own", "所有権", [BINDING]],
  ]);
  expect(toContentRequest(draft)).toEqual({
    title: "Rust 入門",
    description: "所有権まで",
    nodes: [
      { kind: "own", ref: BINDING, label: "変数", summary: "let で束縛する。" },
      { kind: "reference", conceptId: DEFER },
      { kind: "own", ref: OWNER, label: "所有権", summary: "持ち主は1つ。" },
    ],
    edges: [{ from: BINDING, to: OWNER }],
  });
  expect(isDirty(MAP, draft)).toBe(false);
});

test("新しいノードは使っていない仮の番号で足し、変更ありになる", () => {
  const first = addOwnNode(draftFromMap(MAP));
  const second = addOwnNode(first.draft);
  expect([first.ref, second.ref]).toEqual(["new:1", "new:2"]);
  expect(isDirty(MAP, first.draft)).toBe(true);
});

test("同じ Concept は2度参照で足さない", () => {
  const draft = draftFromMap(MAP);
  expect(addReference(draft, DEFER, "defer")).toBe(draft);
  expect(addReference(draft, "go.slice_basics", "スライス").nodes.at(-1)).toEqual({
    kind: "reference",
    ref: "go.slice_basics",
    label: "スライス",
    prerequisites: [],
  });
});

test("ノードを外すと、ほかのノードの前提からも外れる", () => {
  const draft = removeNode(draftFromMap(MAP), BINDING);
  expect(draft.nodes.find((node) => node.ref === OWNER)?.prerequisites).toEqual([]);
  expect(toContentRequest(draft).edges).toEqual([]);
});

test("表示名・概要は手で作ったノードだけ書き換える", () => {
  const draft = updateOwnNode(updateOwnNode(draftFromMap(MAP), BINDING, { label: "束縛" }), DEFER, {
    label: "書き換え",
  });
  expect(draft.nodes.map((node) => node.label)).toEqual(["束縛", "defer", "所有権"]);
});

test("前提の候補から、自分と、自分を前提に辿れるノードを外す（循環させない）", () => {
  // 変数 → 所有権。所有権 → 借用 を足す。
  let draft = draftFromMap(MAP);
  const added = addOwnNode(draft);
  draft = togglePrerequisite(added.draft, added.ref, OWNER);

  // 変数の前提に、所有権・借用（どちらも変数を前提に辿れる）は選べない。
  expect(prerequisiteCandidates(draft, BINDING).map((node) => node.ref)).toEqual([DEFER]);
  // 候補に無い組み合わせは、入口でも付けない。
  expect(togglePrerequisite(draft, BINDING, added.ref)).toBe(draft);
  // 付けてある前提は外せる。
  expect(
    togglePrerequisite(draft, OWNER, BINDING).nodes.find((node) => node.ref === OWNER)
      ?.prerequisites,
  ).toEqual([]);
});

test("合流（前提を2つ持つ）は付けられる", () => {
  const draft = togglePrerequisite(draftFromMap(MAP), OWNER, DEFER);
  expect(draft.nodes.find((node) => node.ref === OWNER)?.prerequisites).toEqual([BINDING, DEFER]);
  expect(layoutTrees(previewDefinitions(draft))).toHaveLength(1);
});

test("保存できない理由を挙げる（空の題名・表示名・概要、上限）", () => {
  const base = draftFromMap(MAP);
  expect(draftProblems(base)).toEqual([]);

  const added = addOwnNode({ ...base, title: "  " });
  expect(draftProblems(added.draft)).toEqual([
    "題名を入力してください。",
    "4 番目のノード：表示名を入力してください。",
    "4 番目のノード：概要を入力してください。",
  ]);

  const tooLong: MapDraft = updateOwnNode(base, BINDING, {
    label: "あ".repeat(EDITOR_LIMITS.label + 1),
  });
  expect(draftProblems(tooLong)).toEqual([
    `${"あ".repeat(EDITOR_LIMITS.label + 1)}：表示名は ${String(EDITOR_LIMITS.label)} 文字までです。`,
  ]);
});

test("保存すると消える保存済みのノードを挙げる（新しいノード・参照は数えない）", () => {
  let draft = removeNode(draftFromMap(MAP), OWNER);
  draft = removeNode(draft, DEFER);
  draft = addOwnNode(draft).draft;
  expect(removedSavedNodes(MAP, draft)).toEqual(["所有権"]);
});

test("保存する本文では、前後の空白を落とす", () => {
  const draft = updateOwnNode(draftFromMap(MAP), BINDING, { label: "  変数  ", summary: " s " });
  expect(toContentRequest(draft).nodes[0]).toEqual({
    kind: "own",
    ref: BINDING,
    label: "変数",
    summary: "s",
  });
  // 空白だけの違いは変更とみなさない。
  expect(isDirty(MAP, updateOwnNode(draftFromMap(MAP), BINDING, { label: "変数 " }))).toBe(false);
});

test("プレビューは空の表示名を「（無題）」で出す", () => {
  const added = addOwnNode(draftFromMap(MAP));
  expect(previewDefinitions(added.draft).at(-1)?.label).toBe("（無題）");
});
