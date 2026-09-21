/**
 * `vscode.lm` から実際に使うモデルを選ぶ方針（調査/03 #121）。
 *
 * ここを vscodeLm.ts から分けているのは、選択方針そのものを VS Code の
 * 実行環境なしに検証できるようにするため。「Copilot 未契約でも使えるか」は
 * この方針で決まるので、実装の奥に埋めずに単体で置く。
 *
 * 背景と一次情報の確認日は docs/lm-api.md を参照。
 */

/**
 * 選択に必要な最小限のモデル情報。
 *
 * `vscode.LanguageModelChat` をそのまま受けず構造的な部分型にする。
 * 選択方針のテストに `vscode` のモックを要求しないため。
 */
export interface SelectableModel {
  id: string;
  family: string;
  vendor: string;
  maxInputTokens?: number;
}

/**
 * 第一候補の vendor。利用者自身の Copilot 契約を使う（AI/02 #11）。
 *
 * 運営側が AI 利用料を負担しない構成の要であり、使えるなら最優先で使う。
 */
export const PREFERRED_VENDOR = "copilot";

/**
 * Copilot で優先する family。
 *
 * docs/lm-api.md の実機検証で、Copilot の一覧には copilot-utility や
 * copilotcli/auto のようなチャット用途ではないモデルが混ざると分かっている。
 * 何も指定せず先頭を使うと、そうしたモデルへ送って応答が空になる。
 */
export const PREFERRED_FAMILY = "gpt-4o-mini";

/**
 * チャット用途に耐えないモデルを弾く。
 *
 * `maxInputTokens` が 0 のモデル（実機で見つかった `copilotcli/auto`）へ送ると
 * 応答が空で返る。未定義の場合は判断材料が無いだけなので除外しない
 * ——「情報が無い」を「使えない」と同じ扱いにすると、将来 vendor が増えたときに
 * 黙って候補が消える。
 */
function isUsable(model: SelectableModel): boolean {
  return model.maxInputTokens === undefined || model.maxInputTokens > 0;
}

/**
 * 使うモデルを 1 つ選ぶ。候補が無ければ `undefined`。
 *
 * 優先順位は次の通り。
 *
 * 1. Copilot の {@link PREFERRED_FAMILY}
 * 2. Copilot のその他のモデル
 * 3. Copilot 以外の vendor のモデル（利用者が VS Code へ登録した BYOK など）
 *
 * 3 があることが、この Issue の答えの中心である。Copilot 未契約の利用者は
 * 1・2 が空になるが、VS Code 本体の BYOK で登録したモデルは Copilot プラン
 * なしで動く（docs/lm-api.md）。そこへ落とせるなら、拡張は使えるままになる。
 */
export function selectModel<T extends SelectableModel>(models: readonly T[]): T | undefined {
  const usable = models.filter(isUsable);

  const copilot = usable.filter((model) => model.vendor === PREFERRED_VENDOR);
  const preferred = copilot.find((model) => model.family === PREFERRED_FAMILY);

  return preferred ?? copilot[0] ?? usable[0];
}

/**
 * モデルが 1 つも無いときに利用者へ出す案内。
 *
 * ここで「使えません」だけを返すと、利用者は次に何をすればよいか分からない。
 * 完了条件が求めているのは失敗の報告ではなく、**使える経路への誘導**である。
 * 失敗そのものは握りつぶさず（RULE-004）、理由と次の一手を両方渡す。
 */
export const NO_MODEL_GUIDANCE = [
  "利用できる AI モデルが 1 つも見つかりませんでした。",
  "次のいずれかで使えるようになります。",
  "",
  "1. **GitHub Copilot にサインインする。** 契約があるならこれが最短です。",
  "2. **自分の API キーを VS Code に登録する（BYOK）。** Copilot の契約は要りません。",
  "   チャットのモデル選択から「Manage Models...」を開き、Anthropic / OpenAI / Gemini などの",
  "   キーを登録するか、Ollama でローカルモデルを使ってください。",
  "",
  "登録し直したあとは、もう一度質問してください。",
].join("\n");
