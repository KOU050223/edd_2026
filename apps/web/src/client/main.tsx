import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ApiError,
  createOperationQueue,
  createRequestTracker,
  createSubmitGuard,
  fillActivityDays,
  putJson,
  requestJson,
  type ActivityDay,
} from "./api.js";
import {
  applyOverrides,
  MASTERY_STATUSES,
  type MasteryOverrides,
  type MasteryStatus,
  type OverlaidConcept,
} from "./overrides.js";
import { summarizeConcepts, type Concept } from "./profile.js";
import {
  ACTIVITY_PERIOD_DAYS,
  DISPLAY_NAME_MAX_LENGTH,
  toSettingsInput,
  type UserSettings,
} from "../shared/settings.js";
import "./style.css";

type Profile = { derivedAt: string; eventCount: number; concepts: Concept[] };

const OVERRIDES_PATH = "/api/v1/mastery-overrides";
const SETTINGS_PATH = "/api/v1/user-settings";
const statusLabel: Record<MasteryStatus, string> = {
  confirmed: "確認済み",
  learning: "学習中",
  unobserved: "未観測",
};
type Activity = { from: string; to: string; days: ActivityDay[] };

// ログイン・ログアウトは単発リクエスト。応答が返らないまま待ち続けると
// 画面が固まるので、締め切りを設ける（.agents/rules/rules.md RULE-001）。
const AUTH_REQUEST_TIMEOUT_MS = 10_000;

const errorText: Record<ApiError["kind"], string> = {
  session_expired: "ログインの有効期限が切れました",
  auth_unavailable: "認証サーバーへ一時的に接続できません。少し待って再試行してください。",
  rate_limited: "短時間に要求が多すぎます。しばらく待って再読み込みしてください。",
  unavailable: "学習データの取得に失敗しました",
};

/**
 * ログイン直後の最初の 401 を 1 回だけ再試行してよいかを返す。
 *
 * Workers KV は結果整合で、`/callback` が張ったセッションが別のエッジへ伝わるまで
 * 遅れうる（docs/web-viewer.md）。Worker は `/?login=1` へ戻してこれを伝える。
 * 印は sessionStorage へ移して URL から消し、**再読み込みで再試行が復活しない**
 * ようにする。無限に再試行しないための一度きりの印である。
 */
function takeLoginRetry(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get("login") === "1") {
    sessionStorage.setItem("web-login-retry", "1");
    params.delete("login");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }
  if (sessionStorage.getItem("web-login-retry") !== "1") return false;
  sessionStorage.removeItem("web-login-retry");
  return true;
}

function ErrorPanel({ error, retry }: { error: ApiError; retry: () => void }) {
  useEffect(() => {
    if (error.kind === "session_expired")
      window.setTimeout(() => {
        window.location.href = "/login";
      }, 500);
  }, [error]);
  return (
    <section className="message error">
      <p>{errorText[error.kind]}</p>
      {error.kind !== "session_expired" && <button onClick={retry}>再試行</button>}
    </section>
  );
}

function Header() {
  return (
    <header>
      <a href="/" className="brand">
        学習装置 <small>Learning Map</small>
      </a>
      <nav>
        <a href="/">マップ</a>
        <a href="/activity">推移</a>
        <a href="/settings">設定</a>
        <button
          onClick={() =>
            fetch("/logout", {
              method: "POST",
              signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
            }).finally(() => {
              window.location.href = "/login";
            })
          }
        >
          ログアウト
        </button>
      </nav>
    </header>
  );
}

/** 1 つの Concept の理解度を手動で選び直す。送信中は入口で弾く（RULE-007）。 */
function MasteryPicker({
  concept,
  pending,
  onChange,
}: {
  concept: OverlaidConcept;
  pending: boolean;
  onChange: (status: MasteryStatus | null) => void;
}) {
  return (
    <div className="mastery-edit">
      <label>
        理解度を修正
        <select
          value={concept.status}
          disabled={pending}
          onChange={(event) => onChange(event.target.value as MasteryStatus)}
        >
          {MASTERY_STATUSES.map((status) => (
            <option value={status} key={status}>
              {statusLabel[status]}
            </option>
          ))}
        </select>
      </label>
      {concept.manual && (
        <button className="link" disabled={pending} onClick={() => onChange(null)}>
          自動算出（{statusLabel[concept.derived.status]}）へ戻す
        </button>
      )}
    </div>
  );
}

function LearningMap() {
  const [profile, setProfile] = useState<Profile>();
  const [overrides, setOverrides] = useState<MasteryOverrides>({});
  const [error, setError] = useState<ApiError>();
  const [saveError, setSaveError] = useState<ApiError>();
  const [pending, setPending] = useState<readonly string[]>([]);
  const requestTracker = useRef(createRequestTracker());
  const overrideTracker = useRef(createRequestTracker());
  const submitGuard = useRef(createSubmitGuard());
  const overrideQueue = useRef(createOperationQueue());

  // 習熟度と手動上書きは別の要求だが、**同じ世代**で追う。
  // 別々に追うと、古い片方が新しいもう片方と混ざった表示になる
  // （.agents/rules/rules.md RULE-005）。
  const load = () => {
    const isLatestProfile = requestTracker.current.start();
    const isLatestOverrides = overrideTracker.current.start();
    setError(undefined);
    const retry = takeLoginRetry();
    Promise.all([
      requestJson<Profile>("/api/v1/learning-profile", fetch, retry),
      overrideQueue.current.run(() => requestJson<MasteryOverrides>(OVERRIDES_PATH, fetch, retry)),
    ])
      .then(([loadedProfile, loadedOverrides]) => {
        if (isLatestProfile()) setProfile(loadedProfile);
        if (isLatestOverrides()) setOverrides(loadedOverrides);
      })
      .catch((value: unknown) => {
        if (isLatestProfile() || isLatestOverrides()) setError(value as ApiError);
      });
  };
  useEffect(load, []);

  const changeStatus = (conceptId: string, status: MasteryStatus | null) => {
    // 入口で弾く（.agents/rules/rules.md RULE-007）。ここを通さずに setPending すると、
    // 同じ Concept が二重に積まれ、弾かれた側の finally が両方を消すため、
    // 最初の保存がまだ終わっていないのに入力が有効へ戻る。
    if (submitGuard.current.isRunning(conceptId)) return;
    const isLatestSave = overrideTracker.current.start();
    setSaveError(undefined);
    setPending((current) => [...current, conceptId]);
    void submitGuard.current
      .run(conceptId, async () => {
        try {
          // 応答は保存後の上書き一覧。これをそのまま採用するので、
          // 画面の状態と保存された内容が食い違わない。
          const saved = await overrideQueue.current.run(() =>
            putJson<MasteryOverrides>(OVERRIDES_PATH, { conceptId, status }),
          );
          if (isLatestSave()) setOverrides(saved);
        } catch (value: unknown) {
          // 保存の失敗を黙って飲み込まない（RULE-004）。
          // 一覧の読み込みエラーとは別に出し、表示は自動算出のまま保つ。
          const saveError = value as ApiError;
          if (saveError.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setSaveError(saveError);
        }
      })
      .finally(() => {
        setPending((current) => current.filter((id) => id !== conceptId));
      });
  };

  if (error) return <ErrorPanel error={error} retry={load} />;
  if (!profile) return <p className="message">読み込み中…</p>;
  const concepts = applyOverrides(profile.concepts, overrides);
  const summary = summarizeConcepts(concepts);
  if (profile.eventCount === 0)
    return (
      <>
        <section className="message">まだ学習イベントがありません</section>
      </>
    );
  return (
    <>
      <section className="summary">
        <div>
          <strong>{summary.confirmed}</strong>確認済み
        </div>
        <div>
          <strong>{summary.learning}</strong>学習中
        </div>
        <div>
          <strong>{summary.unobserved}</strong>未観測
        </div>
        <button onClick={load} disabled={pending.length > 0}>
          再読み込み
        </button>
      </section>
      {saveError && (
        <section className="message error">
          <p>理解度の保存に失敗しました：{errorText[saveError.kind]}</p>
        </section>
      )}
      <section className="concepts">
        {concepts.map((item) => (
          <article className="concept" key={item.conceptId}>
            <div>
              <h2>{item.label ?? item.conceptId}</h2>
              <span className={`status ${item.status}`}>
                {statusLabel[item.status]}
                {item.manual && <em className="manual">手動</em>}
              </span>
            </div>
            <div className="meter">
              {item.score !== null && <i style={{ width: `${Math.round(item.score * 100)}%` }} />}
            </div>
            <b>{item.score === null ? "—" : `${Math.round(item.score * 100)}%`}</b>
            <p>
              自力解決 {item.evidence.solvedIndependentlyCount} 回・ヒント利用{" "}
              {item.evidence.hintUsedCount} 回
              {item.manual && `（自動算出では ${statusLabel[item.derived.status]}）`}
            </p>
            <MasteryPicker
              concept={item}
              pending={pending.includes(item.conceptId)}
              onChange={(status) => changeStatus(item.conceptId, status)}
            />
          </article>
        ))}
      </section>
      <footer>
        {profile.eventCount} 件のイベントから導出 ·{" "}
        {new Date(profile.derivedAt).toLocaleString("ja-JP")}
      </footer>
    </>
  );
}

function Chart({ days }: { days: ActivityDay[] }) {
  const kinds = ["solved_independently", "hint_used", "error_recurred"];
  const max = Math.max(
    1,
    ...days.map((day) => Object.values(day.counts).reduce((sum, count) => sum + count, 0)),
  );
  return (
    <div className="chart">
      {days.map((day) => (
        <div
          className="bar"
          title={`${day.date}: ${Object.values(day.counts).reduce((a, b) => a + b, 0)} 件`}
          key={day.date}
        >
          {kinds.map((kind) => (
            <i
              key={kind}
              className={kind}
              style={{ height: `${((day.counts[kind] ?? 0) / max) * 100}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Activity() {
  // 既定の期間は設定から来る。設定が読めるまで期間は決まらないので `undefined` で
  // 始める。ここで 30 を仮置きすると、設定した期間が表示される前に
  // 30 日分の要求が1回走り、利用者には一瞬だけ違う期間が見える。
  const [period, setPeriod] = useState<number>();
  const [activity, setActivity] = useState<Activity>();
  const [error, setError] = useState<ApiError>();
  const requestTracker = useRef(createRequestTracker());

  // 設定の読み込みは1回きり。失敗しても推移そのものは見せたいので、
  // 既定値へ倒して先へ進む。**これは失敗を隠すフォールバックではない**：
  // 設定は「どの期間を最初に出すか」でしかなく、取得できなくても
  // 利用者は期間を選び直せる。握りつぶさないようログへは残す（RULE-004）。
  useEffect(() => {
    let current = true;
    requestJson<UserSettings>(SETTINGS_PATH, fetch, takeLoginRetry())
      .then((settings) => {
        if (current) setPeriod(settings.activityPeriodDays);
      })
      .catch((value: unknown) => {
        console.warn("failed to load the default activity period", value);
        if (current) setPeriod(30);
      });
    return () => {
      current = false;
    };
  }, []);

  const load = () => {
    if (period === undefined) return;
    const isLatest = requestTracker.current.start();
    setError(undefined);
    requestJson<Activity>(`/api/v1/learning-activity?days=${period}`, fetch, takeLoginRetry())
      .then((value) => {
        if (isLatest()) setActivity(value);
      })
      .catch((value: unknown) => {
        if (isLatest()) setError(value as ApiError);
      });
  };
  useEffect(load, [period]);
  if (error) return <ErrorPanel error={error} retry={load} />;
  if (period === undefined || !activity) return <p className="message">読み込み中…</p>;
  const days = fillActivityDays(activity);
  return (
    <>
      <section className="periods">
        {ACTIVITY_PERIOD_DAYS.map((value) => (
          <button
            className={period === value ? "selected" : ""}
            onClick={() => setPeriod(value)}
            key={value}
          >
            {value} 日
          </button>
        ))}
        <button onClick={load}>再読み込み</button>
      </section>
      {activity.days.length === 0 ? (
        <section className="message">まだ学習イベントがありません</section>
      ) : (
        <>
          <Chart days={days} />
          <p className="legend">
            <i className="solved_independently" />
            自力解決 <i className="hint_used" />
            ヒント利用 <i className="error_recurred" />
            エラー再発
          </p>
        </>
      )}
    </>
  );
}

/**
 * 認可に失敗して Worker から戻された画面。
 *
 * `/login` と `/callback` は Worker が処理するので、ここへ来るのは失敗した経路だけ。
 * 理由をそのまま出さず、利用者がやり直せる導線に倒す（原因はサーバーのログにある）。
 */
function LoginFailed() {
  const reason = new URLSearchParams(window.location.search).get("reason");
  return (
    <main className="login">
      <section className="card">
        <h1>学習装置</h1>
        <p>ログインを完了できませんでした。</p>
        {reason === "state_mismatch" && (
          <p className="error-text">
            ログインの途中で情報が食い違いました。最初からやり直してください。
          </p>
        )}
        {reason === "login_state_missing" && (
          <p className="error-text">ログインの有効期限が切れました。もう一度お試しください。</p>
        )}
        {reason === "unsolicited" && (
          <p className="error-text">
            このログイン要求には心当たりがありません。もう一度お試しください。
          </p>
        )}
        {reason === "token_exchange_failed" && (
          <p className="error-text">
            認証サーバーへ接続できませんでした。少し待ってからお試しください。
          </p>
        )}
        <a className="button" href="/login">
          ログインし直す
        </a>
      </section>
    </main>
  );
}

/**
 * ユーザー設定の編集画面。
 *
 * **実装済みの設定だけを並べる。** 未実装の機能の欄を先に作らない（Issue #123）。
 * 空の欄は利用者から見れば壊れているのと区別がつかず、保存しても何も起きないことが
 * そのまま不具合の報告になる。項目が増えるのは、それを尊重する側が動いてからでよい。
 */
function Settings() {
  const [saved, setSaved] = useState<UserSettings>();
  const [displayName, setDisplayName] = useState("");
  const [periodDays, setPeriodDays] = useState<number>(30);
  const [error, setError] = useState<ApiError>();
  const [saveError, setSaveError] = useState<string>();
  const [savedAt, setSavedAt] = useState<string>();
  const [saving, setSaving] = useState(false);
  const requestTracker = useRef(createRequestTracker());
  const submitGuard = useRef(createSubmitGuard());
  const queue = useRef(createOperationQueue());

  // 読み込みは再実行されうる（再試行ボタン）。古い応答で新しい表示を
  // 上書きしないよう、最新の要求だけが state を更新する
  // （.agents/rules/rules.md RULE-005）。
  const load = () => {
    const isLatest = requestTracker.current.start();
    setError(undefined);
    queue.current
      .run(() => requestJson<UserSettings>(SETTINGS_PATH, fetch, takeLoginRetry()))
      .then((value) => {
        if (!isLatest()) return;
        setSaved(value);
        setDisplayName(value.displayName ?? "");
        setPeriodDays(value.activityPeriodDays);
      })
      .catch((value: unknown) => {
        if (isLatest()) setError(value as ApiError);
      });
  };
  useEffect(load, []);

  const save = () => {
    // 入口で弾く（RULE-007）。`disabled` は見た目でしかなく、
    // キーボードからの submit は素通りする。
    if (submitGuard.current.isRunning("settings")) return;
    // 送る値は画面の状態そのものから作る。別に持った変数から組み立てると、
    // 直前の入力が送信内容へ反映されない。
    const input = toSettingsInput({ displayName, activityPeriodDays: periodDays });
    if (!input.ok) {
      setSaveError(input.message);
      return;
    }
    const isLatestSave = requestTracker.current.start();
    setSaveError(undefined);
    setSavedAt(undefined);
    setSaving(true);
    void submitGuard.current
      .run("settings", async () => {
        try {
          // 応答は保存後の設定。これをそのまま採用するので、
          // 画面の状態と保存された内容が食い違わない。
          const result = await queue.current.run(() =>
            putJson<UserSettings>(SETTINGS_PATH, input.value),
          );
          if (!isLatestSave()) return;
          setSaved(result);
          setDisplayName(result.displayName ?? "");
          setPeriodDays(result.activityPeriodDays);
          setSavedAt(result.updatedAt ?? undefined);
        } catch (value: unknown) {
          // 保存の失敗を黙って飲み込まない（RULE-004）。
          const failure = value as ApiError;
          if (failure.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          if (isLatestSave()) setSaveError(errorText[failure.kind]);
        }
      })
      .finally(() => {
        // 解除は finally で行う。try の末尾に置くと、失敗したときに
        // 入力が無効のまま固まる（RULE-007）。
        setSaving(false);
      });
  };

  if (error) return <ErrorPanel error={error} retry={load} />;
  if (!saved) return <p className="message">読み込み中…</p>;
  const dirty =
    (saved.displayName ?? "") !== displayName || saved.activityPeriodDays !== periodDays;
  return (
    <section className="settings">
      <h1>設定</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label className="field">
          <span>表示名</span>
          <input
            type="text"
            value={displayName}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            placeholder="未設定"
            disabled={saving}
            onChange={(event) => setDisplayName(event.target.value)}
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
                  checked={periodDays === value}
                  disabled={saving}
                  onChange={() => setPeriodDays(value)}
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
        {savedAt && !dirty && (
          <p className="message saved" role="status">
            保存しました（{new Date(savedAt).toLocaleString("ja-JP")}）
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

function App() {
  const path = window.location.pathname;
  if (path === "/login-failed") return <LoginFailed />;
  return (
    <>
      <Header />
      <main>
        {path === "/activity" ? (
          <Activity />
        ) : path === "/settings" ? (
          <Settings />
        ) : (
          <LearningMap />
        )}
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
