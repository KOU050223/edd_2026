// 資格情報ストアの生成（Issue #279 ステップ 3 で index.ts から分離）。
// API トークンは OS の資格情報ストア相当へ暗号化して預ける。
import { app, safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createCredentialStore } from "./credentials.js";

function credentialStore(fileName: string) {
  const filePath = path.join(app.getPath("userData"), fileName);
  return createCredentialStore(
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    },
    {
      read: () => (existsSync(filePath) ? readFileSync(filePath, "utf8") : ""),
      write: (value) => writeFileSync(filePath, value, { encoding: "utf8", mode: 0o600 }),
    },
  );
}

export function refreshTokenStore() {
  return credentialStore("refresh-token.enc");
}
