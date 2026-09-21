/**
 * コード・質問本文の送信に関する同意の文面と版（#119）。
 *
 * 文面はクライアントごとに書き分けない。VS Code / Desktop / Web が同じ内容を
 * 提示できるよう、`vscode` にも Electron にも依存しないこのパッケージへ置く。
 * 正本は docs/architecture.md の「何が誰へ送られるか」で、ここはその要約である。
 * 片方だけ直さないこと。
 */

/**
 * 同意した文面の版。
 *
 * **何を送るかが実質的に変わったら上げる。** 言い回しの修正では上げない。
 * 上げると、保存済みの同意は「古い版への同意」となり再取得の対象になる
 * （`isConsentGranted` が false を返す）。利用者が知らないうちに
 * 送信先や送信内容が増えている状態を作らないための仕掛けである。
 */
export const CONSENT_NOTICE_VERSION = 3;

/** 同意ダイアログの見出し。 */
export const CONSENT_NOTICE_TITLE = "Gakushu Sochi は、選択したコードと質問文を外部へ送ります";

/**
 * 同意ダイアログの本文。送信先ごとに、送るものと保存されるものを分けて示す。
 *
 * 「送る」と「保存する」を混ぜないこと。Copilot へはコード本文が出るが本プロダクトは
 * 保存せず、API Server には本文を送らない。ひとまとめにすると、どちらの事実も
 * 誤って伝わる。
 */
export const CONSENT_NOTICE_DETAIL = [
  "【AI へ送るもの】",
  "送信先は、あなたが VS Code に設定した AI です。GitHub Copilot のほか、",
  "ご自身の API キーを登録している場合は、その提供元（Anthropic / OpenAI / Google など）や、",
  "ローカルで動かしているモデルが送信先になります。",
  "どれが使われるかは VS Code の設定によって決まり、本プロダクトは Copilot を優先します。",
  "",
  "選択したコード本文、その周辺コード、選択範囲のエラー・警告メッセージ、",
  "質問文、同じチャット内の会話履歴、言語とファイル名。",
  "選択範囲から参照した他ファイルの定義コード（最大3件、各最大5行）とファイルパス・シンボル名。",
  "本プロダクトはこれらを保存しません（送信先での扱いは、その提供元の規約によります）。",
  "",
  "【学習記録サーバーへ送るもの】",
  "Concept ID、言語、イベント種別、時刻、セッションID、端末ID。",
  "コード本文・質問文・AIの回答は送りません。保存されるのもこのメタデータだけです。",
  "",
  "同意しない場合、送信は行われません（拡張は動きますが質問できません）。",
  "同意は後から「Gakushu Sochi: 送信内容の同意を取り消す」で取り消せます。",
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
