// @vitest-environment happy-dom
import { StrictMode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useDesktopEvent } from "./use-desktop-event.js";

type Subscribe = (listener: (payload: string) => void) => () => void;

/** 登録・解除を数えられる購読の偽物。window.desktop.onXxx と同じ形。 */
function createSubscribe() {
  const active = new Set<(payload: string) => void>();
  const subscribe = vi.fn<Subscribe>((listener) => {
    active.add(listener);
    return () => {
      active.delete(listener);
    };
  });
  const emit = (payload: string) => {
    for (const listener of active) listener(payload);
  };
  return { subscribe, emit, activeCount: () => active.size };
}

describe("useDesktopEvent", () => {
  it("keeps exactly one subscription under StrictMode double-mounting", () => {
    const { subscribe, activeCount } = createSubscribe();
    const listener = vi.fn();

    const view = renderHook(() => useDesktopEvent(subscribe, listener), {
      wrapper: StrictMode,
    });

    // 二重マウントの effect は 登録→解除→登録 と走るので、購読呼び出しは
    // 複数回でも最終的に生きているリスナーは 1 つだけ。
    expect(activeCount()).toBe(1);
    view.unmount();
    expect(activeCount()).toBe(0);
  });

  it("calls the latest listener without re-subscribing", () => {
    const { subscribe, emit, activeCount } = createSubscribe();
    const first = vi.fn();
    const second = vi.fn();

    const view = renderHook(({ listener }) => useDesktopEvent(subscribe, listener), {
      initialProps: { listener: first },
    });
    emit("one");
    view.rerender({ listener: second });
    emit("two");

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(activeCount()).toBe(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith("one");
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith("two");
  });
});
