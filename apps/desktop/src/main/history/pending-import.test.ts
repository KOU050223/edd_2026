import { describe, expect, it, vi } from "vitest";

import type { ImportPreview } from "../../shared/types.js";
import {
  isPendingImportExpired,
  PENDING_IMPORT_TTL_MS,
  PendingImportStore,
} from "./pending-import.js";

const preview = (id = "s1"): ImportPreview => ({
  sessionId: id,
  importedBy: "desktop",
  providers: [],
  conversationCount: 1,
  duplicateCount: 0,
  ignoredCount: 0,
  sanitized: {},
  localCoveredCount: 0,
  unanalyzedCount: 0,
  evidence: [],
  familiarity: {},
  conceptSummaries: [],
  unmapped: [],
  rejected: [],
  warnings: [],
  analyzersUsed: [],
  managedCallsUsed: 0,
});

const pending = () => new Map();

describe("isPendingImportExpired", () => {
  it("is expired exactly at and after the deadline", () => {
    expect(isPendingImportExpired(1000, 999)).toBe(false);
    expect(isPendingImportExpired(1000, 1000)).toBe(true);
    expect(isPendingImportExpired(1000, 1001)).toBe(true);
  });
});

describe("PendingImportStore", () => {
  it("keeps the entry until the deadline and drops it once it passes", () => {
    let now = 1_000;
    const store = new PendingImportStore(
      () => now,
      () => ({ unref: vi.fn() }) as never,
    );
    store.set({ preview: preview(), pending: pending() });

    now += PENDING_IMPORT_TTL_MS - 1;
    expect(store.get()).not.toBeUndefined();

    now += 1;
    expect(store.get()).toBeUndefined();
    expect(() => store.require("先に履歴の分析を実行してください。")).toThrow(
      "期限を過ぎたため破棄されました",
    );
  });

  it("reports the plain analyze-first error when nothing was ever stored", () => {
    const store = new PendingImportStore(
      () => 0,
      () => ({ unref: vi.fn() }) as never,
    );
    expect(() => store.require("先に履歴の分析を実行してください。")).toThrow(
      "先に履歴の分析を実行してください",
    );
    expect(() => store.require("先に履歴の分析を実行してください。")).not.toThrow("期限");
  });

  it("arms an unref'd timer that discards the entry", () => {
    let scheduled: (() => void) | undefined;
    let delay = 0;
    const unref = vi.fn();
    const store = new PendingImportStore(Date.now, (fn, ms) => {
      scheduled = fn;
      delay = ms;
      return { unref } as never;
    });
    store.set({ preview: preview(), pending: pending() });

    expect(delay).toBe(PENDING_IMPORT_TTL_MS);
    expect(unref).toHaveBeenCalled();
    scheduled!();
    expect(store.get()).toBeUndefined();
    // タイマー破棄も期限切れとして扱う。
    expect(() => store.require("x")).toThrow("期限を過ぎたため破棄されました");
  });

  it("drops the previous entry and timer when a new analysis is stored", () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    let scheduled: (() => void) | undefined;
    const store = new PendingImportStore(Date.now, (fn) => {
      scheduled = fn;
      return { unref: vi.fn() } as never;
    });
    store.set({ preview: preview("old"), pending: pending() });
    store.set({ preview: preview("new"), pending: pending() });

    expect(clearSpy).toHaveBeenCalled();
    expect(store.get()?.preview.sessionId).toBe("new");
    // 古いタイマーのコールバックが生きていても、新しいエントリは消さない。
    // （scheduled は新しいタイマーのコールバックに差し替わっている）
    scheduled!();
    expect(store.get()).toBeUndefined();
    clearSpy.mockRestore();
  });

  it("does not extend the deadline when expiresAt is carried over", () => {
    let now = 1_000;
    const store = new PendingImportStore(
      () => now,
      () => ({ unref: vi.fn() }) as never,
    );
    store.set({ preview: preview(), pending: pending() });
    const expiresAt = store.get()!.expiresAt;

    now += 60_000;
    // 貼り戻し相当: set に既存の expiresAt を渡しても期限は伸びない。
    store.set({ preview: preview("merged"), pending: pending() }, expiresAt);
    expect(store.get()!.expiresAt).toBe(expiresAt);

    now = expiresAt;
    expect(store.get()).toBeUndefined();
  });

  it("discard clears the entry for logout and auth changes", () => {
    const store = new PendingImportStore(
      () => 0,
      () => ({ unref: vi.fn() }) as never,
    );
    store.set({ preview: preview(), pending: pending() });

    store.discard();

    expect(store.get()).toBeUndefined();
    // 手動破棄は期限切れではないので「先に分析してください」側の文言になる。
    expect(() => store.require("先に履歴の分析を実行してください。")).toThrow(
      "先に履歴の分析を実行してください",
    );
  });
});
