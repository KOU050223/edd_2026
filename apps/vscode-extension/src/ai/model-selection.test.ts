import { expect, test } from "vitest";
import {
  NO_MODEL_GUIDANCE,
  PREFERRED_FAMILY,
  PREFERRED_VENDOR,
  selectModel,
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

test("優先 family が無くても Copilot のモデルがあればそれを使う", () => {
  const fallback = model({ id: "copilot-utility", family: "copilot-utility" });

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

test("案内は Copilot と BYOK の両方の経路を示す", () => {
  // 「使えません」で終わらせないことが完了条件そのもの。
  expect(NO_MODEL_GUIDANCE).toContain("Copilot");
  expect(NO_MODEL_GUIDANCE).toContain("BYOK");
  expect(NO_MODEL_GUIDANCE).toContain("Manage Models");
});
