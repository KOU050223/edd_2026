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
 * チャット用途ではない family を見分ける接頭辞。
 *
 * docs/lm-api.md の実機検証で、Copilot の一覧には `copilot-utility`（271790）や
 * `copilot-dictation-cleanup-luna`（921793）のような、**maxInputTokens は十分なのに
 * チャット用途ではない**モデルが混ざると分かっている。トークン数では弾けないため、
 * family の名前で除外する。
 *
 * ここを外すと、Copilot にこれらしか無い利用者が BYOK へ落ちられず、
 * 用途外のモデルへ送って空の応答を受け取る。
 */
const NON_CHAT_FAMILY_PREFIXES = ["copilot-utility", "copilot-dictation"] as const;

/** 名前からチャット用途ではないと分かるモデルか。 */
function isNonChatFamily(model: SelectableModel): boolean {
  return NON_CHAT_FAMILY_PREFIXES.some((prefix) => model.family.startsWith(prefix));
}

/**
 * チャット用途に耐えないモデルを弾く。
 *
 * 除外する条件は 2 つあり、どちらも実機で確認された事実に基づく。
 *
 * 1. `maxInputTokens` が 0（`copilotcli/auto`）。送ると応答が空で返る。
 *    未定義の場合は判断材料が無いだけなので除外しない ——「情報が無い」を
 *    「使えない」と同じ扱いにすると、将来 vendor が増えたときに黙って候補が消える。
 * 2. family がチャット用途ではないと名前から分かるもの（{@link NON_CHAT_FAMILY_PREFIXES}）。
 */
function isUsable(model: SelectableModel): boolean {
  if (isNonChatFamily(model)) {
    return false;
  }
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
 * Copilot 契約なしで BYOK が使えるようになった VS Code の版。
 *
 * これより前の版では BYOK に GitHub サインインが要る（docs/lm-api.md）。
 * `engines.vscode` は `^1.90.0` なので、**案内を出す相手が必ずこの版以降とは限らない。**
 */
const BYOK_WITHOUT_COPILOT_SINCE = { major: 1, minor: 122 };

/** `1.122.3` のような版文字列が {@link BYOK_WITHOUT_COPILOT_SINCE} 以降かを判定する。 */
export function supportsByokWithoutCopilot(version: string): boolean {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));

  // 読めない版を「新しい」と決めつけない。使えない経路を案内するより、
  // 契約が要る前提の案内を出すほうが、利用者を空振りさせない。
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return false;
  }

  if (major !== BYOK_WITHOUT_COPILOT_SINCE.major) {
    return major > BYOK_WITHOUT_COPILOT_SINCE.major;
  }
  return minor >= BYOK_WITHOUT_COPILOT_SINCE.minor;
}

/**
 * モデルが 1 つも無いときに利用者へ出す案内を組み立てる。
 *
 * ここで「使えません」だけを返すと、利用者は次に何をすればよいか分からない。
 * 完了条件が求めているのは失敗の報告ではなく、**使える経路への誘導**である。
 * 失敗そのものは握りつぶさず（RULE-004）、理由と次の一手を両方渡す。
 *
 * BYOK の案内は VS Code の版で書き分ける。古いホストで「Copilot の契約は要りません」と
 * 書くと、利用者はその経路を試して空振りする。案内は、その環境で実際に通る道だけを示す。
 *
 * @param vscodeVersion `vscode.version` の値。
 */
export function buildNoModelGuidance(vscodeVersion: string): string {
  const byokNeedsCopilot = !supportsByokWithoutCopilot(vscodeVersion);

  return [
    "利用できる AI モデルが 1 つも見つかりませんでした。",
    "次のいずれかで使えるようになります。",
    "",
    "1. **GitHub Copilot にサインインする。** 契約があるならこれが最短です。",
    byokNeedsCopilot
      ? "2. **自分の API キーを VS Code に登録する（BYOK）。** チャットのモデル選択から"
      : "2. **自分の API キーを VS Code に登録する（BYOK）。** Copilot の契約は要りません。",
    byokNeedsCopilot
      ? "   「Manage Models...」を開き、Anthropic / OpenAI / Gemini などのキーを登録するか、"
      : "   チャットのモデル選択から「Manage Models...」を開き、Anthropic / OpenAI / Gemini などの",
    byokNeedsCopilot
      ? "   Ollama でローカルモデルを使ってください。"
      : "   キーを登録するか、Ollama でローカルモデルを使ってください。",
    ...(byokNeedsCopilot
      ? [
          `   なお、お使いの VS Code ${vscodeVersion} では BYOK にも GitHub へのサインインが要ります。`,
          `   Copilot の契約なしで BYOK を使うには VS Code ${BYOK_WITHOUT_COPILOT_SINCE.major}.${BYOK_WITHOUT_COPILOT_SINCE.minor} 以降へ更新してください。`,
        ]
      : []),
    "",
    "登録し直したあとは、もう一度質問してください。",
  ].join("\n");
}
