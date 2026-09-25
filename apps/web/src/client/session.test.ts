import { expect, test } from "vitest";
import { ApiError } from "./api.js";
import { fetchLoggedIn } from "./session.js";

test("ログイン状態の応答を真偽値として返す", async () => {
  await expect(fetchLoggedIn(async () => Response.json({ loggedIn: true }))).resolves.toBe(true);
  await expect(fetchLoggedIn(async () => Response.json({ loggedIn: false }))).resolves.toBe(false);
});

test("2xx でも loggedIn が真偽値でなければ失敗として扱う", async () => {
  await expect(fetchLoggedIn(async () => Response.json({ loggedIn: "yes" }))).rejects.toEqual(
    new ApiError("unavailable"),
  );
});
