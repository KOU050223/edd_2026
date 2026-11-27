import { describe, expect, it, vi } from "vitest";

import { send } from "./helpers.js";

// webContents は Electron の実物を立てず、send が触る面だけを持つスタブにする。
const stubWebContents = (destroyed: boolean) => ({
  isDestroyed: () => destroyed,
  send: vi.fn(),
});

describe("send", () => {
  it("delivers the payload to a live webContents", () => {
    const webContents = stubWebContents(false);

    send(webContents as never, "answer:delta", "途中");

    expect(webContents.send).toHaveBeenCalledWith("answer:delta", "途中");
  });

  it("drops the event instead of throwing when the webContents is destroyed", () => {
    const webContents = stubWebContents(true);

    expect(() => send(webContents as never, "answer:delta", "残り")).not.toThrow();
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("does nothing without a webContents", () => {
    expect(() => send(undefined, "answer:delta", "残り")).not.toThrow();
  });
});
