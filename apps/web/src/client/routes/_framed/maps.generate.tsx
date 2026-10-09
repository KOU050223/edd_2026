import { CHECK_LEVEL_LABELS, CHECK_LEVELS } from "@gakushu-sochi/domain";
import type { CheckLevel } from "@gakushu-sochi/domain";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { fetchAiUsage } from "../../ai-usage.js";
import { ApiError, createSubmitGuard } from "../../api.js";
import { changeGenerationConsent, fetchGenerationConsent } from "../../check.js";
import type { CheckGenerationConsent } from "../../check.js";
import { toErrorText } from "../../errors.js";
import { ConsentPrompt } from "../../map-consent.js";
import { fetchLearningMaps, MAP_LIMITS, MapLimitError } from "../../learning-maps.js";
import {
  buildMapGenerateRequest,
  creationChecksSummary,
  CreationChecksError,
  generateCreationChecks,
  generateLearningMap,
  generationCost,
  MAP_GENERATION_CONSENT_PATH,
  MAP_GENERATION_KIND_LABELS,
  MAP_GENERATION_LIMITS,
  MapConsentRequiredError,
  MapGenerationError,
  remainingRequests,
  type MapGenerateRequest,
  type MapGenerationKind,
} from "../../map-generation.js";
import { takeLoginRetry } from "../../session.js";

/** 生成の進み具合。確認問題で失敗したときは、できたマップを開くか作り直すかを選ばせる。 */
type Phase =
  | { kind: "idle" }
  | { kind: "map" }
  | { kind: "checks"; mapId: string }
  | { kind: "checks-failed"; mapId: string; message: string; retryable: boolean };

/** 失敗を生成の画面向けの文にする。 */
function generationErrorText(error: unknown): string {
  if (error instanceof MapGenerationError || error instanceof CreationChecksError) {
    return error.detail;
  }
  if (error instanceof MapLimitError) {
    return `マップは ${String(MAP_LIMITS.maps)} 個までです。使っていないマップを消してから作ってください。`;
  }
  if (error instanceof ApiError && error.kind === "unavailable") {
    return "マップを作れませんでした。時間をおいて、もう一度お試しください。";
  }
  return toErrorText(error);
}

/**
 * テーマ・目標から AI で学習マップを作る（Issue #243 / Web/19）。
 * できたマップは Web/18 の編集画面で開き、そのまま手で直せる。
 */
function GenerateMapPage() {
  const loaded = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const [kind, setKind] = useState<MapGenerationKind>("goal");
  const [theme, setTheme] = useState("");
  const [goal, setGoal] = useState("");
  const [level, setLevel] = useState<CheckLevel>("basic");
  const [withChecks, setWithChecks] = useState(true);
  const [consent, setConsent] = useState<CheckGenerationConsent>(loaded.consent);
  const [asking, setAsking] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);
  const [consentError, setConsentError] = useState<string>();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string>();
  const guard = useRef(createSubmitGuard());

  const full = loaded.mapCount >= MAP_LIMITS.maps;
  const cost = generationCost(withChecks);
  const remaining = loaded.remaining;
  const request = buildMapGenerateRequest({ kind, theme, goal, level, checks: withChecks });
  const busy = phase.kind === "map" || phase.kind === "checks";
  const canSubmit = request !== undefined && !full && !busy && remaining >= cost;

  const openMap = (mapId: string) => navigate({ to: "/maps/$mapId/edit", params: { mapId } });

  /** マップの作成時の確認問題を作る。失敗してもマップは残っているので、開くか作り直すかを選ばせる。 */
  const makeChecks = async (mapId: string) => {
    setPhase({ kind: "checks", mapId });
    try {
      const result = await generateCreationChecks(mapId);
      // 結果は編集画面の上に出せないので、作れなかった組があるときだけここで知らせてから開く。
      if (result.failedCount + result.skippedCount > 0) window.alert(creationChecksSummary(result));
      await openMap(mapId);
    } catch (value: unknown) {
      if (value instanceof ApiError && value.kind === "session_expired") {
        window.location.href = "/login";
        return;
      }
      // 回数の残りが変わったので読み直す。
      await router.invalidate();
      setPhase({
        kind: "checks-failed",
        mapId,
        message: generationErrorText(value),
        retryable: value instanceof CreationChecksError && value.retryable,
      });
    }
  };

  const run = (body: MapGenerateRequest) => {
    // 送信中は入口で弾く（RULE-007）。
    if (guard.current.isRunning("generate")) return;
    setError(undefined);
    setPhase({ kind: "map" });
    void guard.current.run("generate", async () => {
      let map: Awaited<ReturnType<typeof generateLearningMap>>;
      try {
        map = await generateLearningMap(body);
      } catch (value: unknown) {
        if (value instanceof ApiError && value.kind === "session_expired") {
          window.location.href = "/login";
          return;
        }
        // 上流へ送ったあとの失敗でも回数は使われている。残りの回数とマップの数を読み直し、
        // 古い値のまま作り直させない（PR #285 のレビュー）。
        await router.invalidate();
        setPhase({ kind: "idle" });
        if (value instanceof MapConsentRequiredError) {
          // 文面の版が変わった、または記録が取り消された。同意を取り直す。
          setConsent({ version: value.version, granted: false });
          setAsking(true);
          return;
        }
        setError(generationErrorText(value));
        return;
      }
      // 確認問題を頼んでも、参照のノードだけのマップでは作れるノードが無く、API は頼まなかったとして保存する。
      if (map.creationChecks?.status === "pending") {
        await makeChecks(map.id);
        return;
      }
      if (body.checks) {
        window.alert(
          "既存の概念を参照したノードだけのマップなので、作成時の確認問題は作りませんでした。" +
            "確認問題は各ノードの確認問題の画面から作れます。",
        );
      }
      await openMap(map.id);
    });
  };

  /** 作る。同意の記録が無ければ、先に送る内容を示す。 */
  const submit = () => {
    if (!canSubmit || request === undefined) return;
    if (consent.granted) {
      run(request);
      return;
    }
    setConsentError(undefined);
    setAsking(true);
  };

  const agree = (remember: boolean) => {
    if (request === undefined || consentSaving) return;
    const version = consent.version;
    if (!remember) {
      setAsking(false);
      run({ ...request, consentVersion: version });
      return;
    }
    setConsentSaving(true);
    setConsentError(undefined);
    changeGenerationConsent({ grant: version }, fetch, MAP_GENERATION_CONSENT_PATH)
      .then((saved) => {
        setConsent(saved);
        setAsking(false);
        run({ ...request, consentVersion: version });
      })
      .catch((value: unknown) => {
        if (value instanceof ApiError && value.kind === "session_expired") {
          window.location.href = "/login";
          return;
        }
        setConsentError(toErrorText(value));
      })
      .finally(() => setConsentSaving(false));
  };

  const retryChecks = (mapId: string) => {
    if (guard.current.isRunning("generate")) return;
    void guard.current.run("generate", () => makeChecks(mapId));
  };

  return (
    <>
      <p className="map-head">
        <Link to="/maps" className="link">
          ← 自分のマップ
        </Link>
        <h1>AI でマップを作る</h1>
      </p>
      <form
        className="map-create"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset disabled={busy || asking}>
          <legend>作るマップ</legend>
          {(["goal", "field"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="kind"
                checked={kind === value}
                onChange={() => setKind(value)}
              />
              {MAP_GENERATION_KIND_LABELS[value]}
            </label>
          ))}
          <p className="muted">
            {kind === "goal"
              ? "目標を達成するのに要る概念を、学ぶ順に並べます。"
              : "言語や技術の名前から、基礎から応用までの全体を並べます。"}
          </p>
        </fieldset>
        <label>
          {kind === "goal" ? "テーマ（例: Go）" : "言語・技術の名前（例: Kotlin）"}
          <input
            value={theme}
            maxLength={MAP_GENERATION_LIMITS.theme}
            required
            disabled={busy || asking}
            onChange={(event) => setTheme(event.target.value)}
          />
        </label>
        {kind === "goal" && (
          <label>
            目標（例: 認証付きの Web API を作れるようになる）
            <textarea
              value={goal}
              maxLength={MAP_GENERATION_LIMITS.goal}
              rows={2}
              required
              disabled={busy || asking}
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>
        )}
        <label>
          技術レベル
          <select
            value={level}
            disabled={busy || asking}
            onChange={(event) => setLevel(event.target.value as CheckLevel)}
          >
            {CHECK_LEVELS.map((value) => (
              <option key={value} value={value}>
                {CHECK_LEVEL_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="check-consent-remember">
          <input
            type="checkbox"
            checked={withChecks}
            disabled={busy || asking}
            onChange={(event) => setWithChecks(event.target.checked)}
          />
          確認問題も作る（手前のノードから最大 10 組）
        </label>
        <p className="muted">
          AI の利用回数を {cost} 回使います（残り {remaining} 回）。あなたの理解度を AI
          に渡し、分かっているところを前提にしたマップにします。数分かかることがあります。
        </p>

        {asking ? (
          <ConsentPrompt
            saving={consentSaving}
            error={consentError}
            onAgree={agree}
            onCancel={() => setAsking(false)}
          />
        ) : (
          <div className="actions">
            <button type="submit" disabled={!canSubmit}>
              {phase.kind === "map"
                ? "マップを作っています…"
                : phase.kind === "checks"
                  ? "確認問題を作っています…"
                  : "作る"}
            </button>
          </div>
        )}
        {busy && (
          <p className="muted" role="status">
            {phase.kind === "map"
              ? "AI がマップと各ノードの「理解すること」を作っています。画面を閉じずにお待ちください。"
              : "マップを保存しました。続けて確認問題を作っています。"}
          </p>
        )}
        {full && (
          <p className="muted">
            マップは {MAP_LIMITS.maps} 個までです。使っていないマップを消すと作れます。
          </p>
        )}
        {!full && remaining < cost && (
          <p className="muted">
            AI の利用回数が足りません（{cost} 回必要、残り {remaining} 回）。
            {withChecks
              ? "確認問題を作らないなら " + String(generationCost(false)) + " 回で作れます。"
              : ""}
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>

      {phase.kind === "checks-failed" && (
        <section className="message error" role="alert">
          <p>マップは作れましたが、確認問題を作れませんでした：{phase.message}</p>
          <div className="actions">
            {phase.retryable && (
              <button type="button" onClick={() => retryChecks(phase.mapId)}>
                確認問題をもう一度作る
              </button>
            )}
            <button type="button" className="secondary" onClick={() => void openMap(phase.mapId)}>
              マップを開く
            </button>
          </div>
        </section>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/maps/generate")({
  // 回数とマップの数は、作ったあとに戻ってきたときに古い値を見せない。
  staleTime: 0,
  loader: async () => {
    const retry = takeLoginRetry();
    const [usage, consent, { maps }] = await Promise.all([
      fetchAiUsage(fetch, retry),
      fetchGenerationConsent(fetch, retry, MAP_GENERATION_CONSENT_PATH),
      fetchLearningMaps(fetch, retry),
    ]);
    return { remaining: remainingRequests(usage), consent, mapCount: maps.length };
  },
  component: GenerateMapPage,
});
