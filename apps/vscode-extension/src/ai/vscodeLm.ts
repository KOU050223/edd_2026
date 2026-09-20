/**
 * vscode.lm を使った AIProvider の実装。
 *
 * ユーザー自身の Copilot 等の契約を利用し、開発者側の AI 利用料金を抑える（AI/02 #11）。
 * 実機検証の詳細・未確認事項は docs/lm-api.md を参照。
 *
 * CancellationToken によるキャンセルは未対応。AIProvider.ask() はキャンセル手段を
 * 持たない（AIRequest / AIProvider を VS Code 非依存に保つ設計のため、vscode固有の
 * CancellationToken をここに持ち込めない）。UI側でキャンセルが必要になった時点で
 * 別Issueとして対応する。
 */

import * as vscode from "vscode";
import type { AIProvider } from "./provider";
import { buildPrompt, META_MARKER } from "./prompt";
import {
  CONCEPTS,
  type AIError,
  type AIErrorReason,
  type AIRequest,
  type AIResponse,
  type ConceptId,
} from "@gakushu-sochi/domain";

/**
 * 既定で使う family。
 *
 * docs/lm-api.md の実機検証で、selectChatModels() の一覧には copilot-utility や
 * copilotcli/auto のようなチャット用途ではないモデルが混ざることが分かっている。
 * 何も指定せず先頭を使うと、そうしたモデルに送って応答が空になることがある。
 */
const DEFAULT_FAMILY = "gpt-4o-mini";

/**
 * プロンプトに含める過去の会話ターン数の上限。
 *
 * `AIRequest.history` は会話が続く限り増え続けるため、上限を設けないと
 * 毎回のリクエストが際限なく重くなり、いずれモデルのコンテキスト長を
 * 超えてしまう。理解が解消されたかの判断には直近のやり取りで十分なため、
 * 直近 {@link MAX_HISTORY_TURNS} 件だけを残す（古いものは切り捨てる）。
 */
const MAX_HISTORY_TURNS = 10;

/**
 * 応答本文の末尾に付けさせるメタ情報の開始マーカー。
 *
 * ユーザーへ表示する前にここで切り離すため、Markdownとして自然に読める記号は避け、
 * 通常の説明文には出てこない専用の文字列にする。
 */
const KNOWN_CONCEPT_IDS = new Set(CONCEPTS.map((concept) => concept.id));

/** AIRequest を LanguageModelChatMessage の配列へ変換する。 */
function toMessages(request: AIRequest): vscode.LanguageModelChatMessage[] {
  // 直近 MAX_HISTORY_TURNS 件だけを使う。長い会話をそのまま送り続けると
  // リクエストが際限なく重くなり、モデルのコンテキスト長を超えかねない。
  const history = (request.history ?? []).slice(-MAX_HISTORY_TURNS);

  const historyMessages = history.map((turn) =>
    turn.role === "user"
      ? vscode.LanguageModelChatMessage.User(turn.text)
      : vscode.LanguageModelChatMessage.Assistant(turn.text),
  );

  return [...historyMessages, vscode.LanguageModelChatMessage.User(buildPrompt(request))];
}

/** parseAnswer() の戻り値。 */
interface ParsedAnswer {
  /** ユーザーへ表示する本文。メタ情報は含まない。 */
  text: string;
  conceptIds: ConceptId[];
  resolution?: "resolved" | "unclear";
}

/**
 * モデルの応答から、表示用の本文と末尾のメタ情報(JSON)を分離する。
 *
 * モデルが指示に従わない・JSONが壊れている場合は、本文だけをそのまま使い
 * conceptIds は空配列、resolution は省略にする。出力形式は保証されないため、
 * ここでの失敗が質問フロー自体を止めてはならない。
 */
function parseAnswer(raw: string): ParsedAnswer {
  const markerIndex = raw.indexOf(META_MARKER);

  if (markerIndex === -1) {
    return { text: raw.trim(), conceptIds: [] };
  }

  const text = raw.slice(0, markerIndex).trim();
  const jsonMatch = raw.slice(markerIndex + META_MARKER.length).match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return { text, conceptIds: [] };
  }

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);

    if (typeof parsed !== "object" || parsed === null) {
      return { text, conceptIds: [] };
    }

    const rawConceptIds = (parsed as { conceptIds?: unknown }).conceptIds;
    const conceptIds = Array.isArray(rawConceptIds)
      ? rawConceptIds.filter(
          (id): id is ConceptId => typeof id === "string" && KNOWN_CONCEPT_IDS.has(id),
        )
      : [];

    const rawResolution = (parsed as { resolution?: unknown }).resolution;
    const resolution =
      rawResolution === "resolved" || rawResolution === "unclear" ? rawResolution : undefined;

    return { text, conceptIds, resolution };
  } catch {
    return { text, conceptIds: [] };
  }
}

/**
 * LanguageModelError を AIErrorReason へ分類する。
 *
 * `code` は静的メソッドの関数名と一致する文字列になる。VS Code公式ドキュメントの例
 * （`error.code === vscode.LanguageModelError.NotFound.name`）に倣い、インスタンスを
 * 作らず関数の `.name` で比較する。
 *
 * context-too-long / cancelled は LanguageModelError に対応する種別が無いため、
 * 現状は判別できず unknown に落ちる。実機で該当ケースを確認できたら分岐を追加する。
 */
function classifyError(error: vscode.LanguageModelError): AIErrorReason {
  if (error.code === vscode.LanguageModelError.NoPermissions.name) {
    return "consent-denied";
  }
  if (error.code === vscode.LanguageModelError.Blocked.name) {
    return "rate-limited";
  }
  if (error.code === vscode.LanguageModelError.NotFound.name) {
    return "model-unavailable";
  }
  return "unknown";
}

function toAIError(error: unknown): AIError {
  if (error instanceof vscode.LanguageModelError) {
    return { reason: classifyError(error), detail: error.message };
  }
  return { reason: "unknown", detail: String(error) };
}

export class VSCodeLMProvider implements AIProvider {
  readonly id = "vscode-lm";

  /**
   * デバッグ用のログ出力。
   *
   * Concept抽出（AI/03 #12は本格設計待ちで、現状は既知IDでフィルタする簡易実装）が
   * 期待通り動いているかは、モデルの生の応答を見ないと切り分けられない。
   * 未指定なら何も出力しない。
   */
  constructor(
    private readonly onDebug?: (message: string) => void,
    private readonly canSend: () => boolean = () => true,
  ) {}

  /**
   * デバッグ出力の失敗を質問処理へ波及させない。
   * onDebug は呼び出し側から渡される任意のコールバックで、ここでの出力は
   * あくまで補助情報である。その失敗で回答そのものを落としてはならない。
   */
  private debug(message: string): void {
    try {
      this.onDebug?.(message);
    } catch {
      // 出力先が壊れている場合に報告する手段が無いため、ここは握って続行する。
    }
  }

  async ask(request: AIRequest): Promise<AIResponse> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: "copilot" });

      if (models.length === 0) {
        return {
          ok: false,
          error: {
            reason: "model-unavailable",
            detail:
              "selectChatModels() が空配列を返した。Copilot未契約・未サインインの可能性がある。",
          },
        };
      }

      // 用途外のモデルを避けるため family を指定して選ぶ。selector で Copilot に
      // 限定しているため、family が無ければ Copilot の一覧から選ぶ。
      const model = models.find((m) => m.family === DEFAULT_FAMILY) ?? models[0];

      // 同意の取り消しはモデル選択の待機中にも起こりうる。実際にコードを外へ出す
      // sendRequest の直前で再確認し、取り消し後の送信を防ぐ。
      if (!this.canSend()) {
        return {
          ok: false,
          error: { reason: "consent-denied", detail: "送信の同意が取り消されました。" },
        };
      }

      // sendRequest は初回呼び出し時にユーザーへ同意ダイアログを表示する。
      // ユーザー操作（コマンド実行）への応答として呼ぶ必要があり、ここはその文脈で呼ばれる。
      const response = await model.sendRequest(toMessages(request), {
        justification: "Gakushu Sochi がコードの説明・ヒントを生成するために使用します。",
      });

      let raw = "";
      for await (const chunk of response.text) {
        raw += chunk;
      }

      this.debug(`--- AIの生の応答（model: ${model.id}） ---\n${raw}`);

      const parsed = parseAnswer(raw);

      this.debug(
        `--- Concept抽出結果 ---\nconceptIds: ${JSON.stringify(parsed.conceptIds)}\nresolution: ${String(parsed.resolution)}`,
      );

      return {
        ok: true,
        answer: {
          text: parsed.text,
          conceptIds: parsed.conceptIds,
          mode: request.mode,
          model: model.id,
          ...(parsed.resolution ? { resolution: parsed.resolution } : {}),
        },
      };
    } catch (error) {
      return { ok: false, error: toAIError(error) };
    }
  }
}
