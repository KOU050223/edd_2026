import { expect, test } from "vitest";
import {
  buildNoModelGuidance,
  PREFERRED_FAMILY,
  PREFERRED_VENDOR,
  selectModel,
  supportsByokWithoutCopilot,
  type SelectableModel,
} from "./model-selection";

/** 実機で観測された一覧（docs/lm-api.md）に近い形でモデルを組む。 */
function model(partial: Partial<SelectableModel> & { id: string }): SelectableModel {
  return {
    family: partial.family ?? partial.id,
    vendor: partial.vendor ?? PREFERRED_VENDOR,
    ...partial,
  };
}

test("候補が無ければ undefined を返す", () => {
  expect(selectModel([])).toBeUndefined();
});

test("Copilot の優先 family があればそれを選ぶ", () => {
  const preferred = model({ id: PREFERRED_FAMILY, family: PREFERRED_FAMILY });
  const selected = selectModel([model({ id: "copilot-utility" }), preferred]);

  expect(selected).toBe(preferred);
});

test("maxInputTokens が 0 のモデルは選ばない", () => {
  // 実機で発生したバグ: copilotcli/auto を先頭で掴むと応答が空になる。
  const usable = model({ id: "gpt-4o-mini", family: PREFERRED_FAMILY });
  const selected = selectModel([
    model({ id: "auto", family: "", vendor: "copilotcli", maxInputTokens: 0 }),
    usable,
  ]);

  expect(selected).toBe(usable);
});

test("maxInputTokens が未定義なら候補から外さない", () => {
  // 判断材料が無いだけで、使えないと決まったわけではない。
  const unknown = model({ id: "some-model", vendor: "anthropic" });

  expect(selectModel([unknown])).toBe(unknown);
});

test("優先 family が無くても Copilot のチャットモデルがあればそれを使う", () => {
  // copilot-utility のような用途外の family は別テストで除外を確かめている。
  // ここで見たいのは「gpt-4o-mini が無くても Copilot に留まる」こと。
  const fallback = model({ id: "claude-fable-5.1", family: "claude-fable-5.1" });

  expect(selectModel([fallback])).toBe(fallback);
});

test("Copilot が 1 件も無ければ他 vendor のモデルへ落ちる", () => {
  // #121 の中心。Copilot 未契約の利用者は Copilot の候補が空になるが、
  // BYOK で登録したモデルがあれば拡張は使えるままでなければならない。
  const byok = model({ id: "claude-fable-5.1", family: "claude-fable-5.1", vendor: "anthropic" });

  expect(selectModel([byok])).toBe(byok);
});

test("Copilot と BYOK が両方あるときは Copilot を優先する", () => {
  // 運営が AI 利用料を負担しない構成の要なので、使えるなら Copilot を先に使う。
  const copilot = model({ id: "gpt-4o-mini", family: PREFERRED_FAMILY });
  const byok = model({ id: "gpt-5", family: "gpt-5", vendor: "openai" });

  expect(selectModel([byok, copilot])).toBe(copilot);
});

test("チャット用途でない Copilot のモデルより、他 vendor のモデルを選ぶ", () => {
  // copilot-utility は maxInputTokens が十分にあるため、トークン数だけでは弾けない。
  // ここで弾かないと、Copilot にこれしか無い利用者が BYOK へ落ちられなくなる。
  const byok = model({ id: "claude-fable-5.1", family: "claude-fable-5.1", vendor: "anthropic" });
  const selected = selectModel([
    model({ id: "copilot-utility", family: "copilot-utility", maxInputTokens: 271790 }),
    byok,
  ]);

  expect(selected).toBe(byok);
});

test("dictation 用のモデルも候補から外す", () => {
  const byok = model({ id: "gpt-5", family: "gpt-5", vendor: "openai" });
  const selected = selectModel([
    model({
      id: "copilot-dictation-cleanup-luna",
      family: "copilot-dictation-cleanup-luna",
      maxInputTokens: 921793,
    }),
    byok,
  ]);

  expect(selected).toBe(byok);
});

test("チャット用途でないモデルしか無ければ undefined を返す", () => {
  // 空の応答を返すより、案内を出して次の一手を示したほうがよい。
  const selected = selectModel([
    model({ id: "copilot-utility", family: "copilot-utility", maxInputTokens: 271790 }),
  ]);

  expect(selected).toBeUndefined();
});

test("VS Code 1.122 以降なら Copilot なしの BYOK を案内してよい", () => {
  expect(supportsByokWithoutCopilot("1.122.0")).toBe(true);
  expect(supportsByokWithoutCopilot("1.130.2")).toBe(true);
  expect(supportsByokWithoutCopilot("2.0.0")).toBe(true);
});

test("VS Code 1.122 より前では Copilot なしの BYOK を案内しない", () => {
  expect(supportsByokWithoutCopilot("1.121.9")).toBe(false);
  expect(supportsByokWithoutCopilot("1.90.0")).toBe(false);
});

test("読めない版は古いものとして扱う", () => {
  // 使えない経路を案内して空振りさせるより、慎重な側へ倒す。
  expect(supportsByokWithoutCopilot("")).toBe(false);
  expect(supportsByokWithoutCopilot("unknown")).toBe(false);
});

test("案内は Copilot と BYOK の両方の経路を示す", () => {
  // 「使えません」で終わらせないことが完了条件そのもの。
  const guidance = buildNoModelGuidance("1.122.0");

  expect(guidance).toContain("Copilot");
  expect(guidance).toContain("BYOK");
  expect(guidance).toContain("Manage Models");
  expect(guidance).toContain("Copilot の契約は要りません");
});

test("古い VS Code では、BYOK にサインインが要ることまで案内する", () => {
  // ここで「契約は要りません」と書くと、利用者はその経路を試して空振りする。
  const guidance = buildNoModelGuidance("1.100.0");

  expect(guidance).toContain("BYOK");
  expect(guidance).not.toContain("Copilot の契約は要りません");
  expect(guidance).toContain("サインインが要ります");
  expect(guidance).toContain("1.122");
  // どの版で判断したのかを利用者が確かめられること。
  expect(guidance).toContain("1.100.0");
});
