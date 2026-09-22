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
  applyOverrides,
  MASTERY_STATUSES,
  type MasteryOverrides,
  type MasteryStatus,
  type OverlaidConcept,
} from "../../overrides.js";
import { summarizeConcepts, type Concept } from "../../profile.js";
import { toErrorText } from "../../errors.js";
import { takeLoginRetry } from "../../session.js";

type Profile = { derivedAt: string; eventCount: number; concepts: Concept[] };

const OVERRIDES_PATH = "/api/v1/mastery-overrides";

const statusLabel: Record<MasteryStatus, string> = {
  confirmed: "確認済み",
  learning: "学習中",
  unobserved: "未観測",
};

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
  const { profile, overrides } = Route.useLoaderData();
  const router = useRouter();
  const [saveError, setSaveError] = useState<string>();
  const [pending, setPending] = useState<readonly string[]>([]);
  const submitGuard = useRef(createSubmitGuard());
  const overrideQueue = useRef(createOperationQueue());

  const changeStatus = (conceptId: string, status: MasteryStatus | null) => {
    // 入口で弾く（.agents/rules/rules.md RULE-007）。ここを通さずに setPending すると、
    // 同じ Concept が二重に積まれ、弾かれた側の finally が両方を消すため、
    // 最初の保存がまだ終わっていないのに入力が有効へ戻る。
    if (submitGuard.current.isRunning(conceptId)) return;
    setSaveError(undefined);
    setPending((current) => [...current, conceptId]);
    void submitGuard.current
      .run(conceptId, async () => {
        try {
          await overrideQueue.current.run(() =>
            putJson<MasteryOverrides>(OVERRIDES_PATH, { conceptId, status }),
          );
          // 保存できたら loader を捨てて取り直す。応答をそのまま state へ入れると、
          // 以後の再読み込みが表示へ届かなくなる（保存した値が固定されてしまう）。
          // 取り直しの間も画面は残るので、表示が空に戻ることはない。
          await router.invalidate();
        } catch (value: unknown) {
          // 保存の失敗を黙って飲み込まない（RULE-004）。
          // 読み込みエラーとは別に出し、表示は自動算出のまま保つ。
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setSaveError(toErrorText(value));
        }
      })
      .finally(() => {
        setPending((current) => current.filter((id) => id !== conceptId));
      });
  };

  const concepts = applyOverrides(profile.concepts, overrides);
  const summary = summarizeConcepts(concepts);
  if (profile.eventCount === 0)
    return <section className="message">まだ学習イベントがありません</section>;
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
        <button onClick={() => router.invalidate()} disabled={pending.length > 0}>
          再読み込み
        </button>
      </section>
      {saveError && (
        <section className="message error">
          <p>理解度の保存に失敗しました：{saveError}</p>
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

export const Route = createFileRoute("/_framed/")({
  // 習熟度と手動上書きは別の要求だが、loader が1つの結果にまとめるので、
  // 片方だけ古い組み合わせが表示されることがない（RULE-005）。
  loader: async () => {
    const retry = takeLoginRetry();
    const [profile, overrides] = await Promise.all([
      requestJson<Profile>("/api/v1/learning-profile", fetch, retry),
      requestJson<MasteryOverrides>(OVERRIDES_PATH, fetch, retry),
    ]);
    return { profile, overrides };
  },
  component: LearningMap,
});
