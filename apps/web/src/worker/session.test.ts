import { expect, test } from "vitest";
import {
  createLogin,
  createSession,
  deleteSession,
  readSession,
  takeLogin,
  writeSession,
} from "./session.js";

class MemoryKv {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

const kvOf = (kv: MemoryKv) => kv as unknown as KVNamespace;

test("opaque なセッションを KV に保存し、Cookie 値から Refresh Token と sub を取れる", async () => {
  const kv = new MemoryKv();

  const token = await createSession(kvOf(kv), { refreshToken: "rt-1", sub: "auth0|alice" });

  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(readSession(kvOf(kv), token)).resolves.toEqual({
    refreshToken: "rt-1",
    sub: "auth0|alice",
  });
  expect([...kv.values.keys()]).toEqual([`session:${token}`]);
});

test("アクセストークンは KV に書かない（保存されるのは Refresh Token と sub だけ）", async () => {
  const kv = new MemoryKv();

  const token = await createSession(kvOf(kv), { refreshToken: "rt-1", sub: "auth0|alice" });

  expect(JSON.parse(kv.values.get(`session:${token}`) ?? "{}")).toEqual({
    refreshToken: "rt-1",
    sub: "auth0|alice",
  });
});

test("rotation した Refresh Token を同じセッションへ書き戻せる", async () => {
  const kv = new MemoryKv();
  const token = await createSession(kvOf(kv), { refreshToken: "rt-1", sub: "auth0|alice" });

  await writeSession(kvOf(kv), token, { refreshToken: "rt-2", sub: "auth0|alice" });

  await expect(readSession(kvOf(kv), token)).resolves.toEqual({
    refreshToken: "rt-2",
    sub: "auth0|alice",
  });
});

test("失効したセッションは検証できない", async () => {
  const kv = new MemoryKv();
  const token = await createSession(kvOf(kv), { refreshToken: "rt-1", sub: "auth0|alice" });

  await deleteSession(kvOf(kv), token);

  await expect(readSession(kvOf(kv), token)).resolves.toBeUndefined();
});

test("壊れたセッションの値は使えないものとして扱う（既定値へ落とさない）", async () => {
  const kv = new MemoryKv();
  await kv.put("session:broken", "not-json");
  await kv.put("session:legacy", '"1"');
  await kv.put("session:partial", JSON.stringify({ refreshToken: "rt-1" }));

  await expect(readSession(kvOf(kv), "broken")).resolves.toBeUndefined();
  await expect(readSession(kvOf(kv), "legacy")).resolves.toBeUndefined();
  await expect(readSession(kvOf(kv), "partial")).resolves.toBeUndefined();
});

test("ログイン中の state と code_verifier は一度しか取り出せない", async () => {
  const kv = new MemoryKv();
  const token = await createLogin(kvOf(kv), { state: "s-1", codeVerifier: "v-1" });

  await expect(takeLogin(kvOf(kv), token)).resolves.toEqual({
    state: "s-1",
    codeVerifier: "v-1",
  });
  // 二度目は消えている。同じ認可コードの再送で state を通さないため。
  await expect(takeLogin(kvOf(kv), token)).resolves.toBeUndefined();
});

test("ログイン中の状態はセッションとは別の名前空間に置く", async () => {
  const kv = new MemoryKv();

  const loginToken = await createLogin(kvOf(kv), { state: "s-1", codeVerifier: "v-1" });

  // login: の値を session: として読めてしまうと、認可前の状態でセッションが成立する。
  await expect(readSession(kvOf(kv), loginToken)).resolves.toBeUndefined();
  expect([...kv.values.keys()]).toEqual([`login:${loginToken}`]);
});
