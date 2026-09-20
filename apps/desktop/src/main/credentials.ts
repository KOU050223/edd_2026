export interface CredentialCrypto {
  isAvailable: () => boolean;
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
}

export interface CredentialStorage {
  read: () => string;
  write: (value: string) => void;
}

export function createCredentialStore(crypto: CredentialCrypto, storage: CredentialStorage) {
  return {
    get(): string | undefined {
      const value = storage.read();
      return value ? crypto.decrypt(value) : undefined;
    },
    set(value: string): void {
      if (!crypto.isAvailable())
        throw new Error(
          "安全な資格情報ストアを利用できません。OS のキーチェーン設定を確認してください。",
        );
      storage.write(crypto.encrypt(value));
    },
    clear(): void {
      // 暗号化を経由しないので、safeStorage が使えない状況でも消せる。
      storage.write("");
    },
  };
}
