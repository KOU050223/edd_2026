/**
 * コード・質問本文の送信に関する同意の文面と版（#119、横展開は #174）。
 *
 * 文面はクライアントごとに書き分けない。VS Code / Desktop / Web が同じ内容を
 * 提示できるよう、`vscode` にも Electron にも依存しないこのパッケージへ置く。
 * 正本は docs/data-privacy.md の「何が誰へ送られるか」で、ここはその要約である。
 * 片方だけ直さないこと。
 */

/**
 * 同意した文面の版。
 *
 * **何を送るかが実質的に変わったら上げる。** 言い回しの修正では上げない。
 * 上げると、保存済みの同意は「古い版への同意」となり再取得の対象になる
 * （`isConsentGranted` が false を返す）。利用者が知らないうちに
 * 送信先や送信内容が増えている状態を作らないための仕掛けである。
 *
 * 版の履歴:
 * - 3: 送信先が Copilot 以外の BYOK / ローカルモデルへ広がった（#121）
 * - 4: Desktop の Managed AI 経路と Web の書き込みを文面へ含めた（#174）
 */
export const CONSENT_NOTICE_VERSION = 4;

/** 同意ダイアログの見出し。 */
export const CONSENT_NOTICE_TITLE = "Gakushu Sochi は、コードや質問文を外部へ送ることがあります";

/**
 * 同意ダイアログの本文。送信先ごとに、送るものと保存されるものを分けて示す。
 *
 * 「送る」と「保存する」を混ぜないこと。コード本文は AI へ出るが本プロダクトは
 * 保存せず、学習記録サーバーへ保存されるのはメタデータだけである。
 * ひとまとめにすると、どちらの事実も誤って伝わる。
 *
 * クライアントで送信経路が違うため、経路ごとに送信先を書き分ける。
 * どのクライアントから見ても文面が事実とずれないことが、同意の前提である。
 */
export const CONSENT_NOTICE_DETAIL = [
  "【AI へ送るもの】",
  "VS Code 拡張では、送信先はあなたが VS Code に設定した AI です。GitHub Copilot のほか、",
  "ご自身の API キーを登録している場合は、その提供元（Anthropic / OpenAI / Google など）や、",
  "ローカルで動かしているモデルが送信先になります。",
  "どれが使われるかは VS Code の設定によって決まり、本プロダクトは Copilot を優先します。",
  "",
  "デスクトップアプリでは Managed AI を使います。選択テキストと質問文は本プロダクトの",
  "サーバーを経由して、運営が契約する AI プロバイダ（Google Gemini）へ送られます。",
  "サーバーは本文を保存せず、利用回数とトークン量だけを記録します。",
  "",
  "Web 版からはコードや質問文を AI へ送りません。",
  "",
  "送るもの（お使いのクライアントが持つもののうち、該当するもの）:",
  "選択したコード・テキスト本文、質問文、AI 応答の口調設定（人格）。",
  "VS Code 拡張ではこれに加えて、その周辺コード、選択範囲のエラー・警告メッセージ、",
  "同じチャット内の会話履歴、言語とファイル名、選択範囲から参照した他ファイルの",
  "定義コード（最大3件、各最大5行）とファイルパス・シンボル名。",
  "本プロダクトはこれらの本文を保存しません（送信先での扱いは、その提供元の規約によります）。",
  "",
  "【学習記録サーバーへ送るもの】",
  "Concept ID、言語、イベント種別、時刻、セッションID、端末ID。",
  "設定画面で入力した項目（表示名など）や Managed AI の利用回数・トークン量も含みます。",
  "コード本文・質問文・AIの回答を学習記録として保存することはありません。",
  "",
  "同意しない場合、AI への送信と学習データの書き込みは行われません",
  "（VS Code 拡張とデスクトップアプリは質問できません。Web では閲覧とデータの削除だけが使えます）。",
  "同意は後から取り消せます（VS Code 拡張はコマンド「Gakushu Sochi: 送信内容の同意を取り消す」、",
  "デスクトップアプリと Web は設定画面から）。",
  "取り消すと以降の送信は止まりますが、すでに送った分の削除は別途対応します。",
].join("\n");

/** 保存する同意の記録。クライアント側の保存先（VS Code なら globalState）に依らない形にする。 */
export interface ConsentRecord {
  /** 同意した文面の版。 */
  readonly version: number;
  /** 同意した時刻（ISO 8601）。 */
  readonly grantedAt: string;
}

/**
 * 保存値が、現在の文面に対する有効な同意かを判定する。
 *
 * **判定できないものはすべて「同意していない」に倒す。** 壊れた値や未知の版を
 * 同意とみなすと、同意の無い送信が起きる。フォールバックで通さない（RULE-004）。
 */
export function isConsentGranted(stored: unknown): stored is ConsentRecord {
  if (typeof stored !== "object" || stored === null) {
    return false;
  }

  const candidate = stored as Partial<ConsentRecord>;
  return (
    candidate.version === CONSENT_NOTICE_VERSION &&
    typeof candidate.grantedAt === "string" &&
    candidate.grantedAt.length > 0
  );
}

/** 今この瞬間の同意を表す記録を作る。 */
export function createConsentRecord(grantedAt: string): ConsentRecord {
  return { version: CONSENT_NOTICE_VERSION, grantedAt };
}
