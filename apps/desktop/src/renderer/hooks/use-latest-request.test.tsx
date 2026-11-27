// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useLatestRequest } from "./use-latest-request.js";

describe("useLatestRequest", () => {
  it("marks generations older than the latest begin as stale", () => {
    const { result } = renderHook(() => useLatestRequest());

    const first = result.current.begin();
    expect(result.current.isLatest(first)).toBe(true);

    const second = result.current.begin();
    // 新しい読み込みが始まった時点で、前の世代の応答は捨てる対象になる。
    expect(result.current.isLatest(first)).toBe(false);
    expect(result.current.isLatest(second)).toBe(true);
  });

  it("keeps the same handle across re-renders", () => {
    const { result, rerender } = renderHook(() => useLatestRequest());
    const before = result.current;
    const generation = before.begin();
    rerender();
    expect(result.current).toBe(before);
    expect(result.current.isLatest(generation)).toBe(true);
  });
});
