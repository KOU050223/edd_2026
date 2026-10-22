// selection:retry / answer:ask / answer:cancel のハンドラ登録
// （Issue #279 ステップ 3 で index.ts から分離）。
import { randomUUID } from "node:crypto";

import { AnswerInFlight } from "../answer-in-flight.js";
import { apiDeps } from "../api-deps.js";
import { ApiRequestError } from "../api-request.js";
import { appState } from "../app-state.js";
import { askManagedAI } from "../ask.js";
import { openForSelection } from "../clipboard.js";
import { ensureConsent } from "../consent-dialog.js";
import { buildConversation } from "../conversation.js";
import { putConversation } from "../conversations-api.js";
import { normalizeQuestion } from "../question.js";
import { saveSettings } from "../settings-store.js";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../../shared/ipc.js";
import { handle, send } from "./helpers.js";
import { INVOKE_SCHEMAS } from "./schemas.js";

export function registerAnswerIpc(): void {
  const inFlight = new AnswerInFlight();
  handle(INVOKE_CHANNELS.selectionRetry, INVOKE_SCHEMAS["selection:retry"], openForSelection);
  // 生成中でなければ何もしない（多重キャンセルは無害）。
  handle(INVOKE_CHANNELS.answerCancel, INVOKE_SCHEMAS["answer:cancel"], () => {
    inFlight.cancel();
  });
  handle(
    INVOKE_CHANNELS.answerAsk,
    INVOKE_SCHEMAS["answer:ask"],
    async (event, selection, question) => {
      // RULE-007: 送信中の再送信は見た目（renderer の isAsking）に頼らず入口で弾く。
      const signal = inFlight.begin();
      // 送信元が消えたら上流を読み続けても届け先が無いので生成を止める。
      // ウィンドウを閉じる（hide）は破棄ではないので中断しない
      // （裏で生成を続ける既存の挙動を維持する）。
      const abortOnGone = () => {
        console.log("送信元が破棄されたため回答の生成を中断します");
        inFlight.cancel();
      };
      event.sender.once("destroyed", abortOnGone);
      event.sender.once("render-process-gone", abortOnGone);
      // destroyed は後に遡って発火しないので、到着時点で破棄済みならすぐ止める。
      if (event.sender.isDestroyed()) abortOnGone();
      try {
        await askAnswer(event, selection, question, signal);
      } finally {
        event.sender.off("destroyed", abortOnGone);
        event.sender.off("render-process-gone", abortOnGone);
        inFlight.finish();
      }
    },
  );
}

async function askAnswer(
  event: Parameters<Parameters<typeof handle>[2]>[0],
  selection: string,
  question: string,
  signal: AbortSignal,
): Promise<void> {
  // 既に中断済み（送信元が到着時点で破棄されていた場合）は同意確認すら出さない。
  if (signal.aborted) return;
  if (!selection.trim()) throw new Error("選択テキストを取得できませんでした。");
  // #174: 同意の記録があるときだけ送る。選択テキストと質問文が
  // Managed AI 経由で端末の外へ出る唯一の経路なので、ここで止める。
  if (!(await ensureConsent())) {
    throw new Error("送信の同意が得られなかったため、送信を中止しました。");
  }
  const normalizedQuestion = normalizeQuestion(question);
  // #204: 質問履歴の保存が有効なら、回答後に会話としてアップロードする。
  const conversationId = randomUUID();
  const occurredAt = new Date().toISOString();
  let answerText = "";
  let askError: unknown;
  try {
    await askManagedAI(
      selection,
      normalizedQuestion,
      (delta) => {
        // 中断済みなら届いた delta を画面にも累積にも載せない（RULE-005）。
        if (signal.aborted) return;
        answerText += delta;
        send(event.sender, EVENT_CHANNELS.answerDelta, delta);
      },
      signal,
    );
  } catch (error) {
    askError = error;
  }
  // 回答が1文字も届かなかった失敗は履歴にしない（見返す価値がなく、
  // 理由は画面のエラーが担う）。中断した回答は complete:false で残す。
  if (answerText.length > 0 && appState.settings.saveConversationHistory) {
    try {
      const result = await putConversation(
        apiDeps(),
        buildConversation({
          id: conversationId,
          userQuestion: question,
          question: normalizedQuestion,
          selection,
          answer: answerText,
          occurredAt,
          answeredAt: new Date().toISOString(),
          complete: askError === undefined,
        }),
      );
      if (!result.saved) {
        console.warn("質問履歴は既存の新しい会話のため保存されませんでした", result.reason);
      }
    } catch (error) {
      // 履歴の保存失敗で回答の表示を止めない。回答はすでに届いている。
      // ただし黙って落とさず、ログと画面の両方へ出す（RULE-004）。
      console.error("質問履歴の保存に失敗しました", error);
      let message: string;
      if (error instanceof ApiRequestError && error.status === 403) {
        // サーバー側でオプトインが外れている確定情報なので、
        // ローカルキャッシュも false へ戻す（毎回 403 で失敗し続けるのを防ぐ）。
        message =
          "質問履歴の保存がサーバー側で無効になっていたため、ローカルの設定をオフに戻しました。";
        try {
          await saveSettings({ ...appState.settings, saveConversationHistory: false });
        } catch (cacheError) {
          console.error("質問履歴オプトインのローカルキャッシュを戻せませんでした", cacheError);
        }
      } else {
        message = `質問履歴を保存できませんでした: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      send(event.sender, EVENT_CHANNELS.historySaveFailed, message);
    }
  }
  if (signal.aborted) {
    // 利用者のキャンセル・送信元破棄はエラーではない。画面があれば renderer 側が
    // 「回答を停止しました」の通知を出す。破棄時は届け先が無いので記録だけ。
    console.log("回答の生成を中断しました");
    return;
  }
  if (askError !== undefined) throw askError;
}
