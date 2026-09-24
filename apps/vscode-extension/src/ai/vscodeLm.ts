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
import { buildPrompt } from "./prompt";
import { MAX_HISTORY_TURNS, parseAnswer } from "./answer";
import { buildNoModelGuidance, selectModel } from "./model-selection";
import {
  type AIError,
  type AIErrorReason,
  type AIRequest,
  type AIResponse,
} from "@gakushu-sochi/domain";

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
    } catch (error) {
      // 出力先が壊れていても回答自体は続ける。別系統の出力先である
      // 拡張ホストのコンソールへ理由を残し、失敗を握りつぶさない（RULE-004）。
      console.error("デバッグ出力に失敗しました", error);
    }
  }

  async ask(request: AIRequest): Promise<AIResponse> {
    try {
      // selector を渡さず全 vendor を取る（調査/03 #121）。`vendor: "copilot"` で
      // 絞ると、Copilot 未契約の利用者はここで必ず空になり、BYOK で登録済みの
      // モデルがあっても拡張が使えないままになる。優先順位は selectModel() が持つ。
      const models = await vscode.lm.selectChatModels();
      const model = selectModel(models);

      if (!model) {
        // 失敗は失敗のまま型で返し（RULE-004）、そのうえで次の一手を添える。
        // 呼び出し側はこの detail をそのまま利用者へ見せてよい。
        return {
          ok: false,
          error: {
            reason: "model-unavailable",
            // 案内は VS Code の版で変わる（古いホストでは BYOK にもサインインが要る）。
            detail: buildNoModelGuidance(vscode.version),
          },
        };
      }

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
