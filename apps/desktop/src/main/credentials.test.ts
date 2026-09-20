import { describe, expect, it } from "vitest";

import {
  createCredentialStore,
  type CredentialCrypto,
  type CredentialStorage,
} from "./credentials.js";

describe("credential store", () => {
  it("stores and reads an encrypted API key without exposing plaintext", () => {
    let stored = "";
    const crypto: CredentialCrypto = {
      isAvailable: () => true,
      encrypt: (value) => `encrypted:${value}`,
      decrypt: (value) => value.replace("encrypted:", ""),
    };
    const storage: CredentialStorage = {
      read: () => stored,
      write: (value) => {
        stored = value;
      },
    };
    const credentials = createCredentialStore(crypto, storage);

    credentials.set("secret-key");

    expect(stored).toBe("encrypted:secret-key");
    expect(credentials.get()).toBe("secret-key");
  });

  it("clears the stored credential even when encryption is unavailable", () => {
    let stored = "encrypted:secret-key";
    const credentials = createCredentialStore(
      {
        isAvailable: () => false,
        encrypt: (value) => `encrypted:${value}`,
        decrypt: (value) => value.replace("encrypted:", ""),
      },
      {
        read: () => stored,
        write: (value) => {
          stored = value;
        },
      },
    );

    credentials.clear();

    expect(stored).toBe("");
    expect(credentials.get()).toBeUndefined();
  });

  it("fails clearly when secure storage is unavailable", () => {
    const credentials = createCredentialStore(
      { isAvailable: () => false, encrypt: () => "", decrypt: () => "" },
      { read: () => "", write: () => undefined },
    );

    expect(() => credentials.set("secret-key")).toThrow("安全な資格情報ストアを利用できません");
  });
});
