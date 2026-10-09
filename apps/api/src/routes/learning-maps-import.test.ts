/**
 * 共有マップの取り込みと取り込み直し（#244 の T3・T4・T6）。
 *
 * user-a が作成者、user-b が取り込む人。取り込みは ID を引き継ぎ、取り込んだあとに作成者が上げても
 * 個人マップは変わらず「更新あり」になること、取り込み直しの差分と既定の削除を確かめる。
 */

import { beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import type { Concept } from "@gakushu-sochi/domain";
import type { AuthVariables } from "../auth/middleware.js";
import { stubAuth } from "../auth/test-auth.js";
import type {
  ImportSharedMapResponse,
  LearningMapView,
  ListClientMapConceptsResponse,
  MapPublishPreview,
  ReimportLearningMapResponse,
  ReimportPreview,
  SaveLearningMapResponse,
  SharedMapView,
} from "../contract/learning-maps.js";
import {
  createInMemoryRepositoryStore,
  InMemoryIdentityRepository,
  InMemoryLearningMapRepository,
  InMemoryPersonalCheckRepository,
  type InMemoryRepositoryStore,
} from "../repository/memory.js";
import { personalCheck } from "../maps/test-map.js";
import { createLearningMapsRoute } from "./learning-maps.js";

let store: InMemoryRepositoryStore;
let maps: InMemoryLearningMapRepository;
let checks: InMemoryPersonalCheckRepository;
let app: Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>;
let keys: number;
let nowMs: number;

const ENV = {} as unknown as CloudflareBindings;
const TOKENS = { "token-a": "user-a", "token-b": "user-b" };
const A = "token-a";
const B = "token-b";

const FIXED_CONCEPTS: Concept[] = [
  {
    id: "go.defer",
    label: "defer",
    language: "go",
    summary: "関数を抜けるときに実行する。",
    prerequisites: [],
    source: { kind: "manual" },
  },
];

beforeEach(() => {
  store = createInMemoryRepositoryStore();
  const identity = new InMemoryIdentityRepository(store);
  maps = new InMemoryLearningMapRepository(store);
  checks = new InMemoryPersonalCheckRepository(store);
  keys = 0;
  nowMs = 1_000;
  app = new Hono<{ Bindings: CloudflareBindings; Variables: AuthVariables }>();
  app.use("/v1/*", stubAuth(TOKENS));
  app.route(
    "/v1",
    createLearningMapsRoute(() => ({
      identity,
      maps,
      checks,
      fixedConcepts: FIXED_CONCEPTS,
      newKey: () => `k${String(++keys).padStart(7, "0")}`,
      nowIso: () => new Date(nowMs).toISOString(),
      nowMs: () => nowMs,
    })),
  );
});

function send(method: string, path: string, token: string, body?: unknown) {
  return app.request(
    `/v1${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    ENV,
  );
}

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}

async function expectConflict(response: Response, code: string) {
  expect(response.status).toBe(409);
  expect(await response.text()).toBe(code);
}

/** 作成者のマップ: 変数 → 所有権 → 借用（所有権にだけ項目が2つ）。 */
async function createSource() {
  const { map } = await json<SaveLearningMapResponse>(
    await send("POST", "/learning-maps", A, {
      title: "Rust 入門",
      description: "所有権まで",
      nodes: [
        { kind: "own", ref: "new:a", label: "変数", summary: "let で束縛する。" },
        { kind: "own", ref: "new:b", label: "所有権", summary: "値の持ち主は1つ。" },
        { kind: "own", ref: "new:c", label: "借用", summary: "参照を貸す。" },
        { kind: "reference", conceptId: "go.defer" },
      ],
      edges: [
        { from: "new:a", to: "new:b" },
        { from: "new:b", to: "new:c" },
      ],
    }),
    201,
  );
  await send("PUT", `/learning-maps/${map.id}/nodes/${map.nodes[1]!.conceptId}/objectives`, A, {
    objectives: [{ label: "代入で移る" }, { label: "スコープで解放" }],
  });
  return json<LearningMapView>(await send("GET", `/learning-maps/${map.id}`, A));
}

async function publish(mapId: string, visibility: "link" | "public" = "public") {
  const shown = await json<MapPublishPreview>(
    await send("GET", `/learning-maps/${mapId}/versions:preview`, A),
  );
  await json(
    await send("POST", `/learning-maps/${mapId}/versions`, A, {
      visibility,
      includeChecks: shown.includeChecks,
      baseVersion: shown.latest?.version ?? null,
      contentHash: shown.contentHash,
    }),
    201,
  );
  return json<LearningMapView>(await send("GET", `/learning-maps/${mapId}`, A));
}

/** 持ち主として手元を保存する。`edit` で中身を書き換える。 */
async function save(
  map: LearningMapView,
  token: string,
  edit: (input: {
    title: string;
    description: string;
    nodes: Record<string, unknown>[];
    edges: { from: string; to: string }[];
  }) => void,
) {
  const input = {
    title: map.title,
    description: map.description,
    nodes: map.nodes.map((node): Record<string, unknown> =>
      node.kind === "own"
        ? { kind: "own", ref: node.conceptId, label: node.label, summary: node.summary }
        : { kind: "reference", conceptId: node.conceptId },
    ),
    edges: map.edges.map((edge) => ({ ...edge })),
  };
  edit(input);
  return json<SaveLearningMapResponse>(await send("PUT", `/learning-maps/${map.id}`, token, input));
}

async function importMap(mapId: string, body: unknown = {}) {
  return json<ImportSharedMapResponse>(
    await send("POST", `/shared-maps/${mapId}/import`, B, body),
    201,
  );
}

describe("取り込み（T3）", () => {
  test("ID を引き継いで個人マップを作り、取り込み元と版を記録する", async () => {
    const source = await publish((await createSource()).id);
    const { map } = await importMap(source.id);

    expect(map.id).not.toBe(source.id);
    expect(map.title).toBe("Rust 入門");
    expect(map.visibility).toBe("private");
    expect(map.source).toEqual({
      mapId: source.id,
      title: "Rust 入門",
      version: 1,
      latestVersion: 1,
    });
    // ノードと項目の ID は元のまま。
    expect(map.nodes).toEqual(source.nodes);
    expect(map.edges).toEqual(source.edges);

    // 取り込んだノードは自分の Concept になる（VS Code の一覧に入る）。マップの ID は個人マップ。
    const concepts = await json<ListClientMapConceptsResponse>(
      await send("GET", "/learning-maps:concepts", B),
    );
    expect(concepts.concepts.map((concept) => [concept.id, concept.mapId])).toEqual(
      source.nodes.filter((node) => node.kind === "own").map((node) => [node.conceptId, map.id]),
    );
  });

  test("取り込んだあとに作成者が上げても個人マップは変わらず、「更新あり」になる", async () => {
    let source = await publish((await createSource()).id);
    const { map } = await importMap(source.id);
    source = (await save(source, A, (input) => (input.nodes[0]!.label = "束縛"))).map;
    await publish(source.id);

    const mine = await json<LearningMapView>(await send("GET", `/learning-maps/${map.id}`, B));
    expect(mine.nodes[0]).toMatchObject({ label: "変数" });
    expect(mine.source).toMatchObject({ version: 1, latestVersion: 2 });
    const listed = await json<{ maps: { id: string; source: unknown }[] }>(
      await send("GET", "/learning-maps", B),
    );
    expect(listed.maps[0]!.source).toMatchObject({ version: 1, latestVersion: 2 });
  });

  test("個人マップは自分だけが自由に直せ、元のマップは変わらない", async () => {
    const source = await publish((await createSource()).id);
    const { map } = await importMap(source.id);
    await save(map, B, (input) => (input.nodes[0]!.label = "自分の言葉"));
    const objectives = await json<{ objectives: { id: string }[] }>(
      await send("PUT", `/learning-maps/${map.id}/nodes/${map.nodes[1]!.conceptId}/objectives`, B, {
        objectives: [{ label: "自分の項目" }],
      }),
    );
    expect(objectives.objectives).toHaveLength(1);

    const original = await json<LearningMapView>(
      await send("GET", `/learning-maps/${source.id}`, A),
    );
    expect(original.nodes[0]).toMatchObject({ label: "変数" });
    expect(original.nodes[1]).toMatchObject({ objectives: [{}, {}] });
  });

  test("公開の確認問題を個人マップへ写す（T6）", async () => {
    const source = await createSource();
    const target = source.nodes[1]!;
    if (target.kind !== "own") throw new Error("own node expected");
    await checks.put("user-a", personalCheck(target.conceptId, target.objectives[0]!.id), 0, {
      mapId: source.id,
      origin: "map_creation",
    });
    await publish(source.id);
    const { map } = await importMap(source.id);
    expect(
      (await maps.listImportedChecks("user-b", map.id)).map((check) => check.objectiveId),
    ).toEqual([target.objectives[0]!.id]);
    // 取り込んだ人の自分の確認問題にはしない（#250 で「マップの問題」として出す）。
    expect(await checks.listAllByUser("user-b")).toEqual([]);
  });

  test("「リンクだけ」は鍵が要り、自分のマップ・二重・非公開は取り込めない", async () => {
    const linked = await publish((await createSource()).id, "link");
    expect((await send("POST", `/shared-maps/${linked.id}/import`, B, {})).status).toBe(404);
    expect(
      (await send("POST", `/shared-maps/${linked.id}/import`, B, { key: "wrong" })).status,
    ).toBe(404);
    await importMap(linked.id, { key: linked.shareKey });
    await expectConflict(
      await send("POST", `/shared-maps/${linked.id}/import`, B, { key: linked.shareKey }),
      "already_imported",
    );
    await expectConflict(
      await send("POST", `/shared-maps/${linked.id}/import`, A, { key: linked.shareKey }),
      "own_map",
    );

    const hidden = await createSource();
    expect((await send("POST", `/shared-maps/${hidden.id}/import`, B, {})).status).toBe(404);
  });

  test("同じ ID のノードがすでに自分のマップにあれば取り込まない", async () => {
    const first = await publish((await createSource()).id);
    // 作成者の別のマップが、first のノードを参照で置く（共有の側では自分のノードとして写る）。
    const { map: second } = await json<SaveLearningMapResponse>(
      await send("POST", "/learning-maps", A, {
        title: "参照つき",
        nodes: [{ kind: "reference", conceptId: first.nodes[0]!.conceptId }],
      }),
      201,
    );
    await publish(second.id);
    await importMap(first.id);
    await expectConflict(
      await send("POST", `/shared-maps/${second.id}/import`, B, {}),
      "concept_conflict",
    );
  });
});

describe("フォークの公開（#246）", () => {
  /** 取り込んだ人として、確認画面を通して上げる。 */
  async function publishAs(token: string, mapId: string, visibility: "link" | "public" = "public") {
    const shown = await json<MapPublishPreview>(
      await send("GET", `/learning-maps/${mapId}/versions:preview`, token),
    );
    await json(
      await send("POST", `/learning-maps/${mapId}/versions`, token, {
        visibility,
        includeChecks: shown.includeChecks,
        baseVersion: shown.latest?.version ?? null,
        contentHash: shown.contentHash,
      }),
      201,
    );
    return shown;
  }

  test("取り込んで直したマップを別の共有マップとして公開でき、元のマップは変わらない（V1）", async () => {
    const source = await publish((await createSource()).id);
    const { map } = await importMap(source.id);
    await save(map, B, (input) => {
      input.title = "Rust 入門（改）";
      input.nodes[0]!.label = "自分の言葉";
    });
    await publishAs(B, map.id);

    const fork = await json<SharedMapView>(await send("GET", `/shared-maps/${map.id}`, A));
    expect(fork).toMatchObject({ title: "Rust 入門（改）", isOwner: false, version: 1 });
    expect(fork.nodes[0]).toMatchObject({ label: "自分の言葉" });
    // もとにしたマップ（V3-a）。元が全員に共有されているのでリンクを付ける。
    expect(fork.forkedFrom).toEqual({ title: "Rust 入門", mapId: source.id });

    const original = await json<SharedMapView>(await send("GET", `/shared-maps/${source.id}`, B));
    expect(original.nodes[0]).toMatchObject({ label: "変数" });
    expect(original.version).toBe(1);
    expect(original.forkedFrom).toBeUndefined();
  });

  test("元が「リンクだけ」なら、もとにしたマップは題名だけを出す（V3-a）", async () => {
    const linked = await publish((await createSource()).id, "link");
    const { map } = await importMap(linked.id, { key: linked.shareKey });
    await publishAs(B, map.id);
    const fork = await json<SharedMapView>(await send("GET", `/shared-maps/${map.id}`, A));
    expect(fork.forkedFrom).toEqual({ title: "Rust 入門", mapId: null });
  });

  test("公開したあとも元とのつながりは残り、取り込み直して上げるとフォークの新しい版になる（V2）", async () => {
    let source = await publish((await createSource()).id);
    const { map } = await importMap(source.id);
    await publishAs(B, map.id);
    source = (await save(source, A, (input) => (input.nodes[0]!.label = "変数と束縛"))).map;
    nowMs += 1_000;
    await publish(source.id);

    const mine = await json<LearningMapView>(await send("GET", `/learning-maps/${map.id}`, B));
    expect(mine.source).toMatchObject({ version: 1, latestVersion: 2 });
    const preview = await json<ReimportPreview>(
      await send("GET", `/learning-maps/${map.id}/reimport:preview`, B),
    );
    await json(
      await send("POST", `/learning-maps/${map.id}/reimport`, B, {
        version: 2,
        revision: preview.revision,
        keep: [],
      }),
    );
    const shown = await publishAs(B, map.id);
    expect(shown.latest?.version).toBe(1);
    const fork = await json<SharedMapView>(await send("GET", `/shared-maps/${map.id}`, A));
    expect(fork.version).toBe(2);
    expect(fork.nodes[0]).toMatchObject({ label: "変数と束縛" });
  });

  test("元の公開の問題を、今もマップにあるものだけ引き継ぐ（V4-a）", async () => {
    const source = await createSource();
    const [first, second] = source.nodes;
    if (first?.kind !== "own" || second?.kind !== "own") throw new Error("own nodes expected");
    await checks.put("user-a", personalCheck(first.conceptId), 0, {
      mapId: source.id,
      origin: "map_creation",
    });
    await checks.put("user-a", personalCheck(second.conceptId, second.objectives[0]!.id), 0, {
      mapId: source.id,
      origin: "map_creation",
    });
    await publish(source.id);
    const { map } = await importMap(source.id);
    // 取り込んだ人が2つ目のノードの項目を消した。その項目を狙った問題は引き継がない。
    await send("PUT", `/learning-maps/${map.id}/nodes/${second.conceptId}/objectives`, B, {
      objectives: [{ label: "自分の項目" }],
    });
    const shown = await publishAs(B, map.id);
    expect(shown.availableChecks).toBe(1);
    expect(shown.content.checks.map((check) => check.conceptId)).toEqual([first.conceptId]);
    const fork = await json<SharedMapView>(await send("GET", `/shared-maps/${map.id}`, A));
    expect(fork.checkCount).toBe(1);
  });

  test("元とフォークの両方は取り込めない（V5）", async () => {
    const source = await publish((await createSource()).id);
    const { map } = await importMap(source.id);
    await publishAs(B, map.id);
    // 元の作成者がフォークを取り込もうとすると、自分の元のマップと同じ ID のノードがある。
    await expectConflict(
      await send("POST", `/shared-maps/${map.id}/import`, A, {}),
      "concept_conflict",
    );
  });
});

describe("取り込み直し（T4）", () => {
  /**
   * 作成者が版 2 で「変数」の表示名を変え、「借用」を消し、「ライフタイム」を足す。
   * 取り込んだ人は「所有権」を自分で直し、自分のノード「メモ」を「借用」の後ろに足している。
   */
  async function scenario() {
    let source = await publish((await createSource()).id);
    const { map } = await importMap(source.id);
    const [variable, ownership, borrow] = map.nodes;
    const personal = await save(map, B, (input) => {
      input.nodes[1]!.label = "所有権（自分の言葉）";
      input.nodes.push({ kind: "own", ref: "new:memo", label: "メモ", summary: "自分で足した。" });
      input.edges.push({ from: borrow!.conceptId, to: "new:memo" });
    });
    source = (
      await save(source, A, (input) => {
        input.nodes[0]!.label = "変数と束縛";
        input.nodes.splice(2, 1);
        input.edges = input.edges.filter((edge) => edge.to !== borrow!.conceptId);
        input.nodes.push({
          kind: "own",
          ref: "new:life",
          label: "ライフタイム",
          summary: "参照の寿命。",
        });
        input.edges.push({ from: ownership!.conceptId, to: "new:life" });
      })
    ).map;
    nowMs += 1_000;
    await publish(source.id);
    return {
      source,
      map: personal.map,
      variable: variable!.conceptId,
      ownership: ownership!.conceptId,
      borrow: borrow!.conceptId,
      memo: personal.assigned["new:memo"]!,
      life: source.nodes.find((node) => node.kind === "own" && node.label === "ライフタイム")!
        .conceptId,
    };
  }

  test("差分は、足された・共有の側で消された・上書きされるノードと、自分で直したノードを出す", async () => {
    const { map, variable, ownership, borrow, life } = await scenario();
    const preview = await json<ReimportPreview>(
      await send("GET", `/learning-maps/${map.id}/reimport:preview`, B),
    );
    expect(preview.source).toMatchObject({ version: 1, latestVersion: 2 });
    expect(preview.latest.version).toBe(2);
    expect(preview.diff.added.map((node) => node.conceptId)).toEqual([life]);
    // 自分で足した「メモ」は消えないので、消えるノードには入らない。
    expect(preview.diff.removed.map((node) => node.conceptId)).toEqual([borrow]);
    expect(preview.diff.changed.map((change) => change.conceptId).sort()).toEqual(
      [variable, ownership].sort(),
    );
    expect(preview.personallyEdited).toEqual([ownership]);
  });

  test("取り込み直すと共有の側の中身になり、消されたノードは既定で消え、自分のノードは残る", async () => {
    const { map, variable, ownership, borrow, memo, life } = await scenario();
    const preview = await json<ReimportPreview>(
      await send("GET", `/learning-maps/${map.id}/reimport:preview`, B),
    );
    const { map: after } = await json<ReimportLearningMapResponse>(
      await send("POST", `/learning-maps/${map.id}/reimport`, B, {
        version: preview.latest.version,
        revision: preview.revision,
        keep: [],
      }),
    );
    expect(after.nodes.map((node) => node.conceptId)).toEqual([
      variable,
      ownership,
      "go.defer",
      life,
      memo,
    ]);
    expect(after.nodes[0]).toMatchObject({ label: "変数と束縛" });
    expect(after.nodes[1]).toMatchObject({ label: "所有権" });
    expect(after.nodes.some((node) => node.conceptId === borrow)).toBe(false);
    // 「メモ」の前提だった「借用」が消えたので、「メモ」は前提を持たない。
    expect(after.edges.some((edge) => edge.to === memo)).toBe(false);
    expect(after.source).toMatchObject({ version: 2, latestVersion: 2 });
  });

  test("消されたノードを残すと、自分のノードとして持ち続ける", async () => {
    const { map, borrow, memo } = await scenario();
    const preview = await json<ReimportPreview>(
      await send("GET", `/learning-maps/${map.id}/reimport:preview`, B),
    );
    const { map: after } = await json<ReimportLearningMapResponse>(
      await send("POST", `/learning-maps/${map.id}/reimport`, B, {
        version: 2,
        revision: preview.revision,
        keep: [borrow],
      }),
    );
    expect(after.nodes.slice(-2).map((node) => node.conceptId)).toEqual([borrow, memo]);
    expect(after.edges).toContainEqual({ from: borrow, to: memo });

    // 次の取り込み直しでは、残したノードは自分のノードとして扱う（消えるノードに入らない）。
    const source = await json<LearningMapView>(
      await send("GET", `/learning-maps/${map.source ? map.source.mapId : ""}`, A),
    );
    await save(source, A, (input) => (input.description = "版 3"));
    nowMs += 1_000;
    await publish(source.id);
    const next = await json<ReimportPreview>(
      await send("GET", `/learning-maps/${map.id}/reimport:preview`, B),
    );
    expect(next.diff.removed).toEqual([]);
  });

  test("差分を見たあとに版が上がった・手元を直したら、取り込み直さない", async () => {
    const { source, map } = await scenario();
    const preview = await json<ReimportPreview>(
      await send("GET", `/learning-maps/${map.id}/reimport:preview`, B),
    );
    await save(source, A, (input) => (input.description = "版 3"));
    nowMs += 1_000;
    await publish(source.id);
    await expectConflict(
      await send("POST", `/learning-maps/${map.id}/reimport`, B, {
        version: preview.latest.version,
        revision: preview.revision,
        keep: [],
      }),
      "version_conflict",
    );

    const fresh = await json<ReimportPreview>(
      await send("GET", `/learning-maps/${map.id}/reimport:preview`, B),
    );
    const current = await json<LearningMapView>(await send("GET", `/learning-maps/${map.id}`, B));
    await save(current, B, (input) => (input.title = "別の画面で直した"));
    await expectConflict(
      await send("POST", `/learning-maps/${map.id}/reimport`, B, {
        version: fresh.latest.version,
        revision: fresh.revision,
        keep: [],
      }),
      "content_changed",
    );
  });

  test("消えるノード・項目の自分の確認問題は消え、残るノードの確認問題は残る", async () => {
    const { map, borrow, variable } = await scenario();
    await checks.put("user-b", personalCheck(borrow), 0, { mapId: map.id });
    await checks.put("user-b", personalCheck(variable), 0, { mapId: map.id });
    const preview = await json<ReimportPreview>(
      await send("GET", `/learning-maps/${map.id}/reimport:preview`, B),
    );
    await json(
      await send("POST", `/learning-maps/${map.id}/reimport`, B, {
        version: 2,
        revision: preview.revision,
        keep: [],
      }),
    );
    expect((await checks.listAllByUser("user-b")).map((check) => check.conceptId)).toEqual([
      variable,
    ]);
  });

  test("元が共有をやめた・リンクの鍵を作り直したら、取り込み直せない", async () => {
    const linked = await publish((await createSource()).id, "link");
    const { map } = await importMap(linked.id, { key: linked.shareKey });
    await json(
      await send("PUT", `/learning-maps/${linked.id}/visibility`, A, { visibility: "public" }),
    );
    await json(
      await send("PUT", `/learning-maps/${linked.id}/visibility`, A, { visibility: "link" }),
    );
    const mine = await json<LearningMapView>(await send("GET", `/learning-maps/${map.id}`, B));
    expect(mine.source).toMatchObject({ version: 1, latestVersion: null });
    // 版を読むときも、今読めるかを同じ操作で確かめる（間に共有をやめられても中身を返さない）。
    expect(await maps.getSharedVersion(linked.id, 1, linked.shareKey)).toBeNull();
    const relinked = await json<LearningMapView>(
      await send("GET", `/learning-maps/${linked.id}`, A),
    );
    expect(await maps.getSharedVersion(linked.id, 1, relinked.shareKey)).not.toBeNull();
    await expectConflict(
      await send("GET", `/learning-maps/${map.id}/reimport:preview`, B),
      "source_unavailable",
    );
  });
});
