import { expect, test } from "vitest";
import { ApiError } from "./api.js";
import {
  describeChangedFields,
  describeSummary,
  fetchPublishPreview,
  publishLearningMap,
  restoreMapVersion,
  setMapVisibility,
  shareConflictText,
  ShareConflictError,
} from "./map-sharing.js";

function respond(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const PUBLISH = {
  visibility: "link" as const,
  includeChecks: true,
  baseVersion: null,
  contentHash: "a".repeat(64),
};

test("上げると、確認画面で見た中身と版を送る", async () => {
  const { fetcher, calls } = respond(201, { version: { version: 1 }, visibility: "link" });
  await publishLearningMap("mrust0001", PUBLISH, fetcher);
  expect(calls[0]!.url).toBe("/api/v1/learning-maps/mrust0001/versions");
  expect(calls[0]!.init?.method).toBe("POST");
  expect(JSON.parse(calls[0]!.init?.body as string)).toEqual(PUBLISH);
});

test("409 は理由ごとの衝突に、404 は対象が無いに分ける", async () => {
  await expect(
    publishLearningMap("m1", PUBLISH, respond(409, { error: "content_changed" }).fetcher),
  ).rejects.toEqual(new ShareConflictError("content_changed"));
  await expect(
    restoreMapVersion("m1", 1, 2, respond(409, { error: "version_conflict" }).fetcher),
  ).rejects.toEqual(new ShareConflictError("version_conflict"));
  await expect(
    setMapVisibility("m1", "link", respond(409, { error: "not_published" }).fetcher),
  ).rejects.toEqual(new ShareConflictError("not_published"));
  const missing = publishLearningMap("m1", PUBLISH, respond(404, { error: "x" }).fetcher);
  await expect(missing).rejects.toEqual(new ApiError("not_found"));
});

test("2xx でも本文が読めなければ失敗にする", async () => {
  const fetcher = (() =>
    Promise.resolve(new Response("not json", { status: 201 }))) as unknown as typeof fetch;
  await expect(publishLearningMap("m1", PUBLISH, fetcher)).rejects.toEqual(
    new ApiError("unavailable"),
  );
});

test("確認画面は、確認問題を含めるかを選んだときだけ指定する", async () => {
  const first = respond(200, {});
  await fetchPublishPreview("m1", undefined, first.fetcher);
  expect(first.calls[0]!.url).toBe("/api/v1/learning-maps/m1/versions:preview");
  const second = respond(200, {});
  await fetchPublishPreview("m1", false, second.fetcher);
  expect(second.calls[0]!.url).toBe(
    "/api/v1/learning-maps/m1/versions:preview?includeChecks=false",
  );
});

test("履歴の要約と変わったところの文", () => {
  expect(
    describeSummary({
      added: 2,
      removed: 0,
      changed: 1,
      titleChanged: true,
      checksAdded: 1,
      checksRemoved: 0,
    }),
  ).toBe("題名・説明・2 ノードを追加・1 ノードを変更・確認問題 +1 / −0");
  expect(
    describeSummary({
      added: 0,
      removed: 0,
      changed: 0,
      titleChanged: false,
      checksAdded: 0,
      checksRemoved: 0,
    }),
  ).toBe("変更なし");
  expect(describeChangedFields(["label", "objectives"])).toBe("表示名・理解すること");
  expect(shareConflictText(new ShareConflictError("unknown_code"))).toContain("unknown_code");
});
