import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  ApiError,
  createOperationQueue,
  createSubmitGuard,
  putJson,
  requestJson,
} from "../../api.js";
import {
  DISPLAY_NAME_MAX_LENGTH,
  ACTIVITY_PERIOD_DAYS,
  sameSettings,
  toDraft,
  toSettingsInput,
  type SettingsDraft,
  type UserSettings,
} from "../../../shared/settings.js";
import { toErrorText } from "../../errors.js";
import { takeLoginRetry } from "../../session.js";

const SETTINGS_PATH = "/api/v1/user-settings";

/**
 * ユーザー設定の編集画面。
 *
 * **実装済みの設定だけを並べる。** 未実装の機能の欄を先に作らない（Issue #123）。
 * 空の欄は利用者から見れば壊れているのと区別がつかず、保存しても何も起きないことが
 * そのまま不具合の報告になる。項目が増えるのは、それを尊重する側が動いてからでよい。
 */
function Settings() {
  const loaded = Route.useLoaderData();
  const router = useRouter();
  // 保存済みの値と編集中の値の2つだけを持つ。項目ごとに state を増やすと、
  // 差分の判定と「読み込んだ値を入力欄へ戻す」処理が項目の数だけ散らばり、
  // 設定が増えたときに直し忘れる場所が増える。
  const [saved, setSaved] = useState<UserSettings>(loaded);
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(loaded));
  const [saveError, setSaveError] = useState<string>();
  // 「保存しました」を出すのはこの画面で保存したときだけ。`saved.updatedAt` は
  // 過去の保存でも値を持つので、これを流用すると開いた直後に出てしまう。
  const [justSaved, setJustSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const submitGuard = useRef(createSubmitGuard());
  const queue = useRef(createOperationQueue());

  const save = (current: SettingsDraft) => {
    // 入口で弾く（RULE-007）。`disabled` は見た目でしかなく、
    // キーボードからの submit は素通りする。
    if (submitGuard.current.isRunning("settings")) return;
    // 送る値は画面の状態そのものから作る。別に持った変数から組み立てると、
    // 直前の入力が送信内容へ反映されない。
    const input = toSettingsInput(current);
    if (!input.ok) {
      setSaveError(input.message);
      return;
    }
    setSaveError(undefined);
    setJustSaved(false);
    setSaving(true);
    void submitGuard.current
      .run("settings", async () => {
        try {
          // 応答は保存後の設定。これをそのまま採用するので、
          // 画面の状態と保存された内容が食い違わない。
          const result = await queue.current.run(() =>
            putJson<UserSettings>(SETTINGS_PATH, input.value),
          );
          setSaved(result);
          setDraft(toDraft(result));
          setJustSaved(true);
          // **loader のキャッシュも捨てる。** ここを忘れると、`defaultStaleTime` の
          // 間に他の画面へ移って戻ったとき、保存前の値で読み直されて
          // 保存が取り消されたように見える（RULE-005）。
          await router.invalidate();
        } catch (value: unknown) {
          // 保存の失敗を黙って飲み込まない（RULE-004）。
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setSaveError(toErrorText(value));
        }
      })
      .finally(() => {
        // 解除は finally で行う。try の末尾に置くと、失敗したときに
        // 入力が無効のまま固まる（RULE-007）。
        setSaving(false);
      });
  };

  // 項目ごとの比較は `shared/settings.ts` に閉じ込めてある。ここで式を組み立てると、
  // 設定が増えたときに直し忘れても型が通ってしまう。
  const dirty = !sameSettings(saved, draft);
  const update = (change: Partial<SettingsDraft>) => {
    setDraft({ ...draft, ...change });
    setJustSaved(false);
  };
  return (
    <section className="settings">
      <h1>{draft.displayName ? `${draft.displayName}さんの設定` : "設定"}</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save(draft);
        }}
      >
        <label className="field">
          <span>表示名</span>
          <input
            type="text"
            value={draft.displayName}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            placeholder="未設定"
            disabled={saving}
            onChange={(event) => update({ displayName: event.target.value })}
          />
          <small>
            画面に表示される名前。空にすると未設定へ戻ります（{DISPLAY_NAME_MAX_LENGTH} 文字まで）。
          </small>
        </label>

        <fieldset className="field">
          <legend>推移の既定の期間</legend>
          <div className="choices">
            {ACTIVITY_PERIOD_DAYS.map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="activityPeriodDays"
                  value={value}
                  checked={draft.activityPeriodDays === value}
                  disabled={saving}
                  onChange={() => update({ activityPeriodDays: value })}
                />
                {value} 日
              </label>
            ))}
          </div>
          <small>「推移」を開いたときに最初に選ばれる期間。</small>
        </fieldset>

        {saveError && (
          <p className="message error" role="alert">
            設定を保存できませんでした：{saveError}
          </p>
        )}
        {justSaved && !dirty && saved.updatedAt && (
          <p className="message saved" role="status">
            保存しました（{new Date(saved.updatedAt).toLocaleString("ja-JP")}）
          </p>
        )}

        <div className="actions">
          <button type="submit" disabled={saving || !dirty}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
      <p className="note">
        {saved.updatedAt
          ? `最終更新 ${new Date(saved.updatedAt).toLocaleString("ja-JP")}`
          : "まだ保存していません"}
      </p>
    </section>
  );
}

export const Route = createFileRoute("/_framed/settings")({
  loader: () => requestJson<UserSettings>(SETTINGS_PATH, fetch, takeLoginRetry()),
  component: Settings,
});
