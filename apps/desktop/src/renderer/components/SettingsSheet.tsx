// 設定シート。renderer.js が #settings-form に持っていた状態（各入力・同意・
// 履歴オプトイン）をここに寄せる。開閉と inert・フォーカス復帰は親が管轄する。
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { ConsentStatus, SettingsState } from "../../shared/types.js";
import type { AuthView } from "../auth-status.js";

interface Props {
  open: boolean;
  // 親が getSettings/getConsentStatus の結果を置いてくる。変わるたびに
  // フォームを初期化する（開くたびに新しいオブジェクトが入る）。
  initial: { settings: SettingsState; consent: ConsentStatus } | null;
  authView: AuthView;
  authStatusText: string;
  onLogin: () => void;
  onLogout: () => void;
  onClose: () => void;
  showError: (message?: string) => void;
  showNotice: (message?: string) => void;
}

interface Fields {
  apiBaseUrl: string;
  shortcut: string;
  model: string;
  temperature: string;
  maxTokens: string;
  persona: string;
  restoreClipboard: boolean;
  launchAtLogin: boolean;
}

const fieldsFrom = (settings: SettingsState | undefined): Fields => ({
  apiBaseUrl: settings?.apiBaseUrl ?? "",
  shortcut: settings?.shortcut ?? "",
  model: settings?.model ?? "",
  temperature: settings === undefined ? "" : String(settings.temperature),
  maxTokens: settings === undefined ? "" : String(settings.maxTokens),
  persona: settings?.persona ?? "",
  restoreClipboard: settings?.restoreClipboard ?? false,
  launchAtLogin: settings?.launchAtLogin ?? false,
});

interface OptInState {
  value: boolean;
  status: string;
  disabled: boolean;
}

export function SettingsSheet({
  open,
  initial,
  authView,
  authStatusText,
  onLogin,
  onLogout,
  onClose,
  showError,
  showNotice,
}: Props) {
  // 開くたびに親が key を更新するため、このコンポーネントは開いた回数だけ
  // 再マウントされる。初期値は useState の初期化子から取ればよく、
  // effect でフォーム状態を書き換える必要はない。
  const [fields, setFields] = useState<Fields>(() => fieldsFrom(initial?.settings));
  const [consent, setConsent] = useState<ConsentStatus | null>(initial?.consent ?? null);
  // 「質問履歴の保存」オプトイン（Issue #204）。正はサーバーの user-settings。
  // value はフォーム送信でローカルキャッシュを維持するために持つ。
  const [optIn, setOptIn] = useState<OptInState>(() => {
    // ローカルキャッシュの値を先に出し、サーバーの値が読めたら上書きする。
    const cached = initial?.settings.saveConversationHistory === true;
    return { value: cached, status: cached ? "オン" : "オフ", disabled: true };
  });
  const optInBusyRef = useRef(false);
  const apiBaseUrlRef = useRef<HTMLInputElement>(null);

  // 読み込み失敗時は操作不能のまま残す（オフラインでは変更できない設計）。
  const loadHistoryOptIn = useCallback(async () => {
    setOptIn((previous) => ({ ...previous, disabled: true }));
    try {
      const remote = await window.desktop.getConversationHistoryOptIn();
      setOptIn({
        value: remote.saveConversationHistory,
        status: remote.saveConversationHistory ? "オン" : "オフ",
        disabled: false,
      });
    } catch (e) {
      setOptIn((previous) => ({ ...previous, status: "読み込めませんでした" }));
      showError(
        `質問履歴の設定を読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [showError]);

  // 開いたとき（再マウント時）に、最初の入力へフォーカスし、
  // オプトインをサーバーの値で読み直す。失敗は中でエラー表示するので待たない。
  useEffect(() => {
    if (initial === null) return;
    apiBaseUrlRef.current?.focus();
    void (async () => {
      await loadHistoryOptIn();
    })();
  }, [initial, loadHistoryOptIn]);

  const changeOptIn = useCallback(
    async (next: boolean) => {
      // 入口で弾く。disabled が反映される前の二度押しを ref で止める。
      if (optInBusyRef.current) return;
      optInBusyRef.current = true;
      setOptIn((previous) => ({ ...previous, disabled: true }));
      try {
        const result = await window.desktop.setConversationHistoryOptIn(next);
        // キャンセル時は main が現在値を返すので、戻った値に合わせて表示を戻す。
        setOptIn({
          value: result.saveConversationHistory,
          status: result.saveConversationHistory ? "オン" : "オフ",
          disabled: false,
        });
      } catch (e) {
        // 失敗時は表示を元に戻してから、サーバーの現在値で復元する。
        // 無条件に再有効化すると、戻りチェックが反映される前に
        // 次の変更を受け付けてしまう。
        setOptIn({ value: !next, status: !next ? "オン" : "オフ", disabled: true });
        showError(
          `質問履歴の設定を変更できませんでした: ${e instanceof Error ? e.message : String(e)}`,
        );
        void loadHistoryOptIn();
      } finally {
        optInBusyRef.current = false;
      }
    },
    [loadHistoryOptIn, showError],
  );

  const reviewConsent = useCallback(async () => {
    try {
      // 文面の提示と取り消しは main 側のダイアログが担う。ここでは結果の状態だけ反映する。
      setConsent(await window.desktop.reviewConsent());
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  }, [showError]);

  const openAccessibilitySettings = useCallback(async () => {
    try {
      await window.desktop.openAccessibilitySettings();
    } catch (e) {
      showError(
        `アクセシビリティ設定を開けませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [showError]);

  const save = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      try {
        await window.desktop.saveSettings({
          apiBaseUrl: fields.apiBaseUrl,
          shortcut: fields.shortcut,
          model: fields.model,
          temperature: Number(fields.temperature),
          maxTokens: Number(fields.maxTokens),
          restoreClipboard: fields.restoreClipboard,
          launchAtLogin: fields.launchAtLogin,
          persona: fields.persona,
          // 履歴オプトインのローカルキャッシュ。フォームが持たないので
          // 送り忘れると false に正規化され、サーバーの値とずれたまま残る。
          saveConversationHistory: optIn.value,
        });
        onClose();
        showNotice("設定を保存しました。");
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e));
      }
    },
    [fields, optIn.value, onClose, showError, showNotice],
  );

  const patchField = useCallback(<K extends keyof Fields>(key: K, value: Fields[K]) => {
    setFields((previous) => ({ ...previous, [key]: value }));
  }, []);

  return (
    <form
      id="settings-form"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      hidden={!open}
      onSubmit={(event) => void save(event)}
    >
      <div className="settings-panel">
        <h2 id="settings-title">設定</h2>
        <label>
          API URL
          <input
            id="api-base-url"
            type="url"
            required
            ref={apiBaseUrlRef}
            value={fields.apiBaseUrl}
            onChange={(event) => patchField("apiBaseUrl", event.target.value)}
          />
        </label>
        {/* .auth-settings 内はインライン並び。旧 HTML と同じ見た目にするため
            要素間の空白を {" "} で明示する（JSX は行またぎの空白を消す）。 */}
        <div className="auth-settings">
          <span>アカウント</span>{" "}
          <button
            type="button"
            id="auth-login"
            disabled={authView.loggingIn || authView.loggingOut}
            onClick={onLogin}
          >
            ブラウザでログイン
          </button>{" "}
          <button type="button" id="auth-logout" disabled={authView.loggingOut} onClick={onLogout}>
            ログアウト
          </button>{" "}
          <span id="auth-status" role="status">
            {authStatusText}
          </span>
        </div>
        <div className="auth-settings">
          <span>送信の同意</span>{" "}
          <span id="consent-status" role="status">
            {consent === null
              ? ""
              : consent.granted
                ? `同意しています（${new Date(consent.grantedAt ?? "").toLocaleString("ja-JP")}）`
                : "同意していません"}
          </span>{" "}
          <button type="button" id="consent-review" onClick={() => void reviewConsent()}>
            内容を確認
          </button>
        </div>
        <div className="auth-settings">
          <span>質問履歴の保存</span>{" "}
          {/* サーバーから値を読めるまで操作させない（オフラインでは変更できない）。 */}
          <label>
            <input
              id="save-history"
              type="checkbox"
              disabled={optIn.disabled}
              checked={optIn.value}
              onChange={(event) => void changeOptIn(event.target.checked)}
            />{" "}
            質問と回答を履歴に残す
          </label>{" "}
          <span id="history-optin-status" role="status">
            {optIn.status}
          </span>
        </div>
        <label>
          ショートカット
          <input
            id="shortcut"
            required
            value={fields.shortcut}
            onChange={(event) => patchField("shortcut", event.target.value)}
          />
        </label>
        {/* 自由入力にしない。サーバーの allowlist（apps/api/src/contract/ai-usage.ts）に
            無い値は送信時に 400 で弾かれるので、選べる時点で絞る。 */}
        <label>
          モデル
          <select
            id="model"
            required
            value={fields.model}
            onChange={(event) => patchField("model", event.target.value)}
          >
            <option value="gemini-3.6-flash">gemini-3.6-flash</option>
            <option value="gemini-3.8-flash">gemini-3.8-flash</option>
          </select>
        </label>
        <label>
          温度
          <input
            id="temperature"
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={fields.temperature}
            onChange={(event) => patchField("temperature", event.target.value)}
          />
        </label>
        <label>
          最大トークン
          <input
            id="max-tokens"
            type="number"
            min="1"
            max="2048"
            value={fields.maxTokens}
            onChange={(event) => patchField("maxTokens", event.target.value)}
          />
        </label>
        {/* maxlength はサーバーのスキーマ（apps/api/src/routes/ai.ts の
            PERSONA_MAX_LENGTH）と揃える。超える値は送信時に 400 で弾かれる。 */}
        <label>
          人格（任意）
          <input
            id="persona"
            type="text"
            maxLength={500}
            placeholder="例: 優しい先生、幼馴染"
            value={fields.persona}
            onChange={(event) => patchField("persona", event.target.value)}
          />
        </label>
        <label>
          <input
            id="restore"
            type="checkbox"
            checked={fields.restoreClipboard}
            onChange={(event) => patchField("restoreClipboard", event.target.checked)}
          />{" "}
          クリップボードを復元する
        </label>
        <label>
          <input
            id="login"
            type="checkbox"
            checked={fields.launchAtLogin}
            onChange={(event) => patchField("launchAtLogin", event.target.checked)}
          />{" "}
          ログイン時に起動する
        </label>
        <div className="settings-actions">
          {/* type を明示しないと submit 扱いになり、primary のスタイルも拾ってしまう。 */}
          <button type="button" onClick={() => void openAccessibilitySettings()}>
            アクセシビリティ設定を開く
          </button>
          <button type="button" id="settings-cancel" onClick={onClose}>
            閉じる
          </button>
          <button>保存</button>
        </div>
      </div>
    </form>
  );
}
