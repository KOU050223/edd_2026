import { describe, expect, it, vi } from "vitest";

import { BOOKMARK_TYPE, captureSelection, toClipboardEntries } from "./selection.js";

describe("captureSelection", () => {
  it("returns the copied selection and restores the prior clipboard", async () => {
    let clipboard = "prior clipboard";
    const copy = vi.fn(async () => {
      clipboard = "  selected source  ";
    });

    await expect(
      captureSelection({
        readText: () => clipboard,
        writeText: (text) => {
          clipboard = text;
        },
        copy,
        wait: async () => undefined,
      }),
    ).resolves.toBe("selected source");

    expect(copy).toHaveBeenCalledOnce();
    expect(clipboard).toBe("prior clipboard");
  });

  it("reports an empty selection while still restoring the clipboard", async () => {
    let clipboard = "prior clipboard";

    await expect(
      captureSelection({
        readText: () => clipboard,
        writeText: (text) => {
          clipboard = text;
        },
        copy: async () => undefined,
        wait: async () => undefined,
      }),
    ).rejects.toThrow("選択されたテキストを取得できませんでした");

    expect(clipboard).toBe("prior clipboard");
  });

  it("can leave the copied text in the clipboard when restoration is disabled", async () => {
    let clipboard = "prior clipboard";
    await captureSelection({
      readText: () => clipboard,
      writeText: (text) => {
        clipboard = text;
      },
      copy: async () => {
        clipboard = "selected source";
      },
      wait: async () => undefined,
      restoreClipboard: false,
    });
    expect(clipboard).toBe("selected source");
  });

  it("waits for asynchronous clipboard writes before copying", async () => {
    let clipboard = "prior clipboard";
    const selection = await captureSelection({
      readText: () => clipboard,
      writeText: async (text) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        clipboard = text;
      },
      copy: async () => {
        if (clipboard === "") clipboard = "selected source";
      },
      wait: async () => undefined,
    });
    expect(selection).toBe("selected source");
    expect(clipboard).toBe("prior clipboard");
  });

  it("restores the complete clipboard snapshot", async () => {
    const originalItems = [
      { types: ["text/plain", "text/html"], getType: async () => new Blob([]) },
    ];
    const selectedItems = [{ types: ["text/plain"], getType: async () => new Blob([]) }];
    let current = { items: originalItems, fingerprint: "original" };
    let restoredItems: readonly unknown[] | undefined;

    await expect(
      captureSelection({
        readText: () => "selected source",
        readClipboard: async () => current,
        writeClipboard: async (items) => {
          if (items.length === 0) return;
          restoredItems = items;
        },
        copy: async () => {
          current = { items: selectedItems, fingerprint: "selected" };
        },
        wait: async () => undefined,
        restoreClipboard: true,
      }),
    ).resolves.toBe("selected source");

    expect(restoredItems).toEqual(originalItems);
  });

  it("does not overwrite clipboard content changed during capture", async () => {
    const originalItems = [{ types: ["text/plain"], getType: async () => new Blob([]) }];
    let current = { items: originalItems, fingerprint: "original" };
    let restoreCount = 0;

    await captureSelection({
      readText: () => "selected source",
      readClipboard: async () => current,
      writeClipboard: async (items) => {
        if (items.length > 0) restoreCount += 1;
      },
      copy: async () => {
        current = { items: originalItems, fingerprint: "selected" };
      },
      wait: async () => {
        current = { items: originalItems, fingerprint: "newer content" };
      },
    });

    expect(restoreCount).toBe(0);
  });
});

describe("toClipboardEntries", () => {
  it("unwraps each type into a writable value", async () => {
    const html = new Blob(["<b>hi</b>"], { type: "text/html" });
    const text = new Blob(["hi"], { type: "text/plain" });
    const items = [
      {
        types: ["text/plain", "text/html"],
        getType: async (type: string) => (type === "text/html" ? html : text),
      },
    ];

    const entries = await toClipboardEntries(items);

    expect(entries).toEqual([
      [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    ]);
  });

  it("drops values that cannot be reconstructed", async () => {
    const items = [{ types: ["text/uri-list"], getType: async () => "https://example.com" }];
    const dropped = vi.fn();

    expect(await toClipboardEntries(items, dropped)).toEqual([]);
    expect(dropped).toHaveBeenCalledWith("text/uri-list", "https://example.com");
  });

  it("keeps a bookmark-only snapshot", async () => {
    const bookmark = { title: "Electron", url: "https://electronjs.org" };
    const items = [{ types: [BOOKMARK_TYPE], getType: async () => bookmark }];

    expect(await toClipboardEntries(items)).toEqual([[{ type: BOOKMARK_TYPE, value: bookmark }]]);
  });

  it("keeps both blob and bookmark values in a mixed snapshot", async () => {
    const text = new Blob(["hi"], { type: "text/plain" });
    const bookmark = { title: "Electron", url: "https://electronjs.org" };
    const items = [
      {
        types: ["text/plain", BOOKMARK_TYPE],
        getType: async (type: string) => (type === BOOKMARK_TYPE ? bookmark : text),
      },
    ];

    expect(await toClipboardEntries(items)).toEqual([
      [
        { type: "text/plain", value: text },
        { type: BOOKMARK_TYPE, value: bookmark },
      ],
    ]);
  });

  it("drops a bookmark type whose value is not a bookmark", async () => {
    const items = [{ types: [BOOKMARK_TYPE], getType: async () => ({ title: "no url" }) }];

    expect(await toClipboardEntries(items)).toEqual([]);
  });

  it("returns entries that are not the original ClipboardItem objects", async () => {
    const blob = new Blob(["hi"], { type: "text/plain" });
    const original = { types: ["text/plain"], getType: async () => blob };

    const entries = await toClipboardEntries([original]);

    // clipboard.write() へ渡すのは元オブジェクトであってはならない。
    expect(entries[0]).not.toBe(original);
    expect(entries[0]?.[0]?.value).toBe(blob);
  });
});
