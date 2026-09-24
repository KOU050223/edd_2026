import { describe, expect, it, vi } from "vitest";
import { CONSENT_NOTICE_VERSION } from "@gakushu-sochi/domain";

import { createConsentStore, type ConsentStorage } from "./consent.js";

const memoryStorage = (initial = ""): ConsentStorage & { value: string } => {
  const storage = {
    value: initial,
    read() {
      return this.value;
    },
    write(next: string) {
      this.value = next;
    },
  };
  return storage;
};

describe("consent store", () => {
  it("treats a record for the current notice as granted", () => {
    const store = createConsentStore(memoryStorage());

    store.grant("2026-09-25T00:00:00.000Z");

    expect(store.has()).toBe(true);
    expect(store.grantedAt()).toBe("2026-09-25T00:00:00.000Z");
  });

  it("treats a missing record as not granted", () => {
    const store = createConsentStore(memoryStorage());

    expect(store.has()).toBe(false);
  });

  it("treats a record for an older notice version as not granted", () => {
    const storage = memoryStorage(
      JSON.stringify({
        version: CONSENT_NOTICE_VERSION - 1,
        grantedAt: "2026-09-21T00:00:00.000Z",
      }),
    );
    const store = createConsentStore(storage);

    expect(store.has()).toBe(false);
  });

  it("treats a corrupt record as not granted and reports it instead of swallowing", () => {
    const onUnreadable = vi.fn();
    const store = createConsentStore(memoryStorage("not-json{"), onUnreadable);

    expect(store.has()).toBe(false);
    expect(onUnreadable).toHaveBeenCalledWith("not-json{");
  });

  it("blocks sends again once consent is revoked", () => {
    const store = createConsentStore(memoryStorage());
    store.grant("2026-09-25T00:00:00.000Z");

    store.revoke();

    expect(store.has()).toBe(false);
  });
});
