import { describe, expect, test } from "vitest";
import {
  FixedObjectivesError,
  fetchFixedMaps,
  generateFixedObjectives,
  itemProblems,
  itemsChanged,
  itemsFromDraft,
  itemsFromSaved,
  objectivesByConcept,
  reassign,
  relabel,
  removedOnSave,
  saveFixedObjectives,
  toSaveRequest,
  type FixedObjectiveView,
} from "./fixed-maps.js";

const SAVED: FixedObjectiveView[] = [
  { id: "go.defer:timing", conceptId: "go.defer", label: "実行タイミング", source: "manual" },
  { id: "go.defer:lifo", conceptId: "go.defer", label: "実行順", source: "manual" },
];

function respond(body: unknown, status = 200): typeof fetch {
  return (() => Promise.resolve(Response.json(body, { status }))) as unknown as typeof fetch;
}

describe("読み取り", () => {
  test("Concept ごとにまとめ、保存した順を保つ", () => {
    expect(objectivesByConcept(SAVED).get("go.defer")).toEqual([
      { id: "go.defer:timing", conceptId: "go.defer", label: "実行タイミング" },
      { id: "go.defer:lifo", conceptId: "go.defer", label: "実行順" },
    ]);
  });

  test("形が契約と違えば、一部だけ使わずに失敗にする", async () => {
    await expect(
      fetchFixedMaps(respond({ objectives: SAVED, editableLanguages: ["go"] })),
    ).resolves.toEqual({ objectives: SAVED, editableLanguages: ["go"] });
    await expect(fetchFixedMaps(respond({ objectives: SAVED }))).rejects.toThrow();
    await expect(
      fetchFixedMaps(
        respond({ objectives: [{ ...SAVED[0], source: "x" }], editableLanguages: [] }),
      ),
    ).rejects.toThrow();
  });
});

describe("編集", () => {
  const draft = {
    conceptId: "go.defer",
    objectives: [
      {
        kind: "kept" as const,
        id: "go.defer:timing",
        label: "関数を抜けるときに実行",
        previousLabel: "実行タイミング",
      },
      { kind: "kept" as const, id: "go.defer:lifo", label: "実行順", previousLabel: "実行順" },
      { kind: "new" as const, label: "引数はその場で評価" },
    ],
    removed: [],
  };

  test("案の項目は AI の出どころで、書き換わった表示名だけ前の名前を添える", () => {
    expect(itemsFromDraft(draft)).toEqual([
      {
        id: "go.defer:timing",
        label: "関数を抜けるときに実行",
        fromAi: true,
        previousLabel: "実行タイミング",
      },
      { id: "go.defer:lifo", label: "実行順", fromAi: true },
      { label: "引数はその場で評価", fromAi: true },
    ]);
  });

  test("AI の案のままの項目だけ ai として送り、手で書き換えたら出どころを API に任せる", () => {
    const [first, second, third] = itemsFromDraft(draft);
    expect(toSaveRequest([relabel(first!, " 手で直した "), second!, third!])).toEqual({
      objectives: [
        { id: "go.defer:timing", label: "手で直した" },
        { id: "go.defer:lifo", label: "実行順", source: "ai" },
        { label: "引数はその場で評価", source: "ai" },
      ],
    });
  });

  test("引き継ぐ今の項目を付け替えると、AI が示した前の表示名は外す", () => {
    const [first] = itemsFromDraft(draft);

    expect(reassign(first!, "go.defer:lifo")).toEqual({
      id: "go.defer:lifo",
      label: "関数を抜けるときに実行",
      fromAi: true,
    });
    expect(reassign(first!, undefined)).toEqual({ label: "関数を抜けるときに実行", fromAi: true });
  });

  test("引き継がれない今の項目は、確定すると消える", () => {
    expect(removedOnSave(SAVED, [{ id: "go.defer:lifo", label: "x", fromAi: false }])).toEqual([
      SAVED[0],
    ]);
  });

  test("保存済みと同じなら変更なし（前後の空白は数えない）", () => {
    expect(itemsChanged(SAVED, itemsFromSaved(SAVED))).toBe(false);
    expect(
      itemsChanged(SAVED, [
        { id: "go.defer:timing", label: " 実行タイミング ", fromAi: false },
        { id: "go.defer:lifo", label: "実行順", fromAi: true },
      ]),
    ).toBe(false);
    expect(itemsChanged(SAVED, itemsFromDraft(draft))).toBe(true);
  });

  test("空の一覧・空の項目・同じ今の項目への二重の引き継ぎは確定できない", () => {
    expect(itemProblems(itemsFromSaved(SAVED))).toEqual([]);
    expect(itemProblems([])).toHaveLength(1);
    expect(itemProblems([{ label: " ", fromAi: false }])).toHaveLength(1);
    expect(
      itemProblems([
        { id: "go.defer:timing", label: "a", fromAi: false },
        { id: "go.defer:timing", label: "b", fromAi: false },
      ]),
    ).toEqual(["同じ今の項目を、2つの項目に引き継がせています。"]);
  });
});

describe("送信", () => {
  test("作り直しの案を読む。形が違えば失敗にする", async () => {
    const concepts = [
      {
        conceptId: "go.defer",
        objectives: [{ kind: "new", label: "a" }],
        removed: [{ id: "go.defer:timing", label: "実行タイミング" }],
      },
    ];
    await expect(generateFixedObjectives("go", undefined, respond({ concepts }))).resolves.toEqual(
      concepts,
    );
    await expect(
      generateFixedObjectives(
        "go",
        undefined,
        respond({ concepts: [{ ...concepts[0], objectives: [{ kind: "kept", label: "a" }] }] }),
      ),
    ).rejects.toThrow();
  });

  test("回数の上限や生成の失敗は、API の文面をそのまま出す", async () => {
    const error = await generateFixedObjectives(
      "go",
      ["go.defer"],
      respond({ error: "ai usage limit reached", message: "回数が足りません。" }, 429),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FixedObjectivesError);
    expect((error as FixedObjectivesError).detail).toBe("回数が足りません。");
  });

  test("作成者でなければ、そう伝える", async () => {
    const error = await saveFixedObjectives(
      "go",
      "go.defer",
      [],
      respond({ error: "only the creator of this map can edit it" }, 403),
    ).catch((caught: unknown) => caught);

    expect((error as FixedObjectivesError).detail).toContain("作成者だけ");
  });

  test("確定した一覧に Concept ID を付けて返す", async () => {
    await expect(
      saveFixedObjectives(
        "go",
        "go.defer",
        itemsFromSaved(SAVED),
        respond({ objectives: SAVED.map(({ id, label, source }) => ({ id, label, source })) }),
      ),
    ).resolves.toEqual(SAVED);
  });
});
