import { createFileRoute, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  type Concept as DomainConcept,
  type LearningObjective,
  CHECK_GENERATION_NOTICE,
  CHECK_LEVEL_LABELS,
  CHECK_LEVELS,
  CHECK_SCOPE_LABELS,
  CHECK_SCOPES,
  checkQuestionsOf,
  checkTargetOf,
  type CheckLevel,
  type CheckQuestionKind,
  type CheckScope,
  type LearningEvent,
  type PersonalConceptCheck,
} from "@gakushu-sochi/domain";
import { ApiError, createSubmitGuard, requestJson } from "../../api.js";
import {
  allObjectivesUnderstood,
  CheckConsentRequiredError,
  changeGenerationConsent,
  checkErrorText,
  checkSetKey,
  checkTally,
  defaultObjectiveSelection,
  fetchGenerationConsent,
  fetchSavedChecks,
  generateCheck,
  generationTargets,
  gradeCheck,
  nextCheckIndex,
  orderedChecks,
  recommendedLevel,
  savedTargetsOf,
  shownMapChecks,
  upsertCheck,
  type CheckAnswers,
  type CheckGenerationConsent,
  type CheckTarget,
} from "../../check.js";
import { checkResultEvent, recordCheckResult, type CheckCorrectness } from "../../check-result.js";
import { ErrorPanel } from "../../errors.js";
import { fetchFixedMaps, objectivesByConcept } from "../../fixed-maps.js";
import {
  AREAS,
  CONCEPT_BY_ID,
  languageLabel,
  overlaidConcepts,
  type MapProfile,
} from "../../learning-map-view.js";
import { objectiveProgress, type ObjectiveProgress } from "../../learning-map.js";
import {
  fetchOwnMapContaining,
  isMapId,
  mapDefinitions,
  mapIdOfConcept,
} from "../../learning-maps.js";
import type { MasteryOverrides } from "../../overrides.js";
import { takeLoginRetry } from "../../session.js";

const KIND_LABEL: Record<CheckQuestionKind, string> = {
  overview: "概要問題",
  practice: "実践問題",
};

const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

type Target = CheckTarget;

/**
 * 正誤の記録の状態。採点の表示とは独立させる。
 * **記録の失敗で採点の結果や解説を隠さない**（#77）。
 */
type RecordState =
  | { kind: "sending" }
  | { kind: "recorded" }
  | { kind: "dropped" }
  | { kind: "failed"; message: string };

/**
 * マップへ戻る先。手で作ったマップの画面から来たならそのマップへ、手で作ったノードは
 * 属するマップへ（#242）、地図に無い Concept は項目一覧で詳細を開く。
 */
function BackLink({ conceptId, from }: { conceptId: string; from: string | undefined }) {
  const mapId = from ?? mapIdOfConcept(conceptId);
  if (mapId !== undefined) {
    return (
      <Link to="/maps/$mapId" params={{ mapId }} search={{ concept: conceptId }} className="link">
        ← マップへ戻る
      </Link>
    );
  }
  const language = AREAS.get(conceptId);
  return language === undefined ? (
    <Link to="/" search={{ concept: conceptId }} className="link">
      ← マップへ戻る
    </Link>
  ) : (
    <Link
      to="/map/$language"
      params={{ language }}
      search={{ concept: conceptId }}
      className="link"
    >
      ← マップへ戻る
    </Link>
  );
}

function RecordStatus({ state, onRetry }: { state: RecordState; onRetry: () => void }) {
  switch (state.kind) {
    case "sending":
      return <p className="muted">結果を記録しています…</p>;
    case "recorded":
      return <p className="muted">結果を記録しました。マップの理解度に反映されます。</p>;
    case "dropped":
      // 送信と重なった学習データの削除に含まれた。消した側を優先し、再送させない。
      return (
        <p className="muted">学習データの削除と重なったため、この結果は記録されませんでした。</p>
      );
    case "failed":
      return (
        <div className="check-record-failed" role="alert">
          <p className="error-text">結果を記録できませんでした：{state.message}</p>
          <button type="button" onClick={onRetry}>
            記録を再送する
          </button>
        </div>
      );
  }
}

/**
 * 保存済みの1組。概要問題と実践問題の2問を選んでからまとめて採点し、
 * **2問とも正解のときだけ** `check_passed`、それ以外は `check_failed` を1件記録する（#43）。
 * 回答内容（選んだ選択肢）は送らない。
 *
 * 画面には1組ずつ出す（#270）。出していない組も `hidden` で残し、
 * 別の組へ移って戻ってきても、選んだ答えや採点の結果、記録の送信を失わない。
 */
function CheckSet({
  check,
  title,
  hidden,
  retakable,
  regenerate,
  onGraded,
  onRetake,
}: {
  check: PersonalConceptCheck;
  title: string;
  hidden: boolean;
  /** 採点のあとに「もう一度解く」を出すか。範囲が「理解すること」のときだけ（#270 の決定）。 */
  retakable: boolean;
  /** 作り直しのボタン。マップの問題（#250）は作り直せないので渡さない。 */
  regenerate?: { label: string; running: boolean; onClick: () => void };
  onGraded: (passed: boolean) => void;
  onRetake: () => void;
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<CheckAnswers>({});
  const [correct, setCorrect] = useState<CheckCorrectness>();
  const [record, setRecord] = useState<RecordState>();
  // 再送で二重に数えないよう、採点した1回ぶんのイベント（同じ id）を持ち回す。
  const event = useRef<LearningEvent>(undefined);
  const submitGuard = useRef(createSubmitGuard());
  const name = `${checkTargetOf(check)}:${check.generatedAt}`;

  const send = () => {
    const current = event.current;
    // 入口で弾く（RULE-007）。ボタンの disabled だけでは二重送信を止めきれない。
    if (current === undefined || submitGuard.current.isRunning(current.id)) return;
    setRecord({ kind: "sending" });
    void submitGuard.current.run(current.id, async () => {
      try {
        const status = await recordCheckResult(current);
        // もう一度解き始めていたら、古い記録の結果で新しい画面を書き換えない（RULE-005）。
        if (event.current?.id !== current.id) return;
        if (status === "dropped_by_reset") {
          setRecord({ kind: "dropped" });
          return;
        }
        setRecord({ kind: "recorded" });
        // マップの習熟度を取り直させる。この画面の loader は巻き込まない
        // （生成した組は画面の state にあり、取り直すと表示中の採点が消える）。
        await router.invalidate({ filter: (match) => match.routeId !== Route.id });
      } catch (value: unknown) {
        if (value instanceof ApiError && value.kind === "session_expired") {
          window.location.href = "/login";
          return;
        }
        if (event.current?.id !== current.id) return;
        setRecord({ kind: "failed", message: checkErrorText(value) });
      }
    });
  };

  const grade = () => {
    if (correct !== undefined) return;
    const result = gradeCheck(check, answers);
    if (result === null) return;
    setCorrect(result);
    onGraded(result.overview && result.practice);
    event.current = checkResultEvent({
      conceptId: check.conceptId,
      correct: result,
      ...(check.objectiveId === undefined ? {} : { objectiveId: check.objectiveId }),
      id: crypto.randomUUID(),
      now: new Date(),
    });
    send();
  };

  const retake = () => {
    event.current = undefined;
    setAnswers({});
    setCorrect(undefined);
    setRecord(undefined);
    onRetake();
  };

  const graded = correct !== undefined;
  const passed = graded && correct.overview && correct.practice;
  const answeredAll = gradeCheck(check, answers) !== null;

  return (
    <article className="check-set" hidden={hidden}>
      <div className="check-set-head">
        <div>
          <h3>{title}</h3>
          <p className="muted">
            {CHECK_LEVEL_LABELS[check.level]}・{new Date(check.generatedAt).toLocaleString("ja-JP")}{" "}
            に作成
          </p>
        </div>
        {regenerate && (
          <button
            type="button"
            className="secondary"
            disabled={regenerate.running || record?.kind === "sending"}
            onClick={regenerate.onClick}
          >
            {regenerate.label}
          </button>
        )}
      </div>
      <form
        onSubmit={(formEvent) => {
          formEvent.preventDefault();
          grade();
        }}
      >
        {checkQuestionsOf(check).map(({ kind, question }) => (
          <fieldset
            key={kind}
            className={`check-question${graded ? (correct[kind] ? " correct" : " incorrect") : ""}`}
          >
            <legend>
              {KIND_LABEL[kind]}
              {graded && (
                <strong className="check-verdict">{correct[kind] ? "正解" : "不正解"}</strong>
              )}
            </legend>
            <p className="check-prompt">{question.prompt}</p>
            {"code" in question && typeof question.code === "string" && (
              <pre className="check-code">
                <code>{question.code}</code>
              </pre>
            )}
            <ul className="check-choices">
              {question.choices.map((choice, choiceIndex) => {
                const chosen = answers[kind] === choiceIndex;
                const isAnswer = choiceIndex === question.answerIndex;
                const classes = [
                  "check-choice",
                  graded && isAnswer && "answer",
                  graded && chosen && !isAnswer && "wrong",
                ].filter(Boolean);
                return (
                  // 並びが正解の位置を決めるので、表示側で並べ替えない（packages/domain/src/check.ts）。
                  <li key={choiceIndex} className={classes.join(" ")}>
                    <label>
                      <input
                        type="radio"
                        name={`${name}:${kind}`}
                        checked={chosen}
                        disabled={graded}
                        onChange={() =>
                          setAnswers((current) => ({ ...current, [kind]: choiceIndex }))
                        }
                      />
                      <span>{choice}</span>
                      {graded && isAnswer && <em className="check-mark">正解</em>}
                      {graded && chosen && !isAnswer && (
                        <em className="check-mark">あなたの回答</em>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
            {graded && <p className="check-explanation">{question.explanation}</p>}
          </fieldset>
        ))}
        {!graded && (
          <div className="actions">
            <button type="submit" disabled={!answeredAll}>
              採点する
            </button>
            {!answeredAll && <span className="muted">2問とも選ぶと採点できます。</span>}
          </div>
        )}
      </form>
      {graded && (
        <section className={`check-result${passed ? " passed" : ""}`} role="status">
          <h4>{passed ? "2問とも正解です" : "正解していない問題があります"}</h4>
          <p>
            {passed
              ? check.objectiveId === undefined
                ? "この Concept を理解できたものとして記録します。"
                : "この項目を理解できたものとして記録します。"
              : "2問とも正解したときだけ理解できたものとして記録します。解説を読んでから、もう一度解いてみてください。"}
          </p>
          {record && <RecordStatus state={record} onRetry={send} />}
          {retakable && (
            <div className="actions">
              <button type="button" onClick={retake} disabled={record?.kind === "sending"}>
                もう一度解く
              </button>
            </div>
          )}
        </section>
      )}
    </article>
  );
}

/**
 * 生成の前に、AI へ送る内容を示して同意を取る（#236 の決定）。
 * 「今後表示しない」を選ぶと、サーバーに記録して次回から出さない。取り消しは設定画面。
 */
function ConsentPrompt({
  count,
  saving,
  error,
  onAgree,
  onCancel,
}: {
  count: number;
  saving: boolean;
  error: string | undefined;
  onAgree: (remember: boolean) => void;
  onCancel: () => void;
}) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="check-consent" role="dialog" aria-label="AI へ送る内容の確認">
      {CHECK_GENERATION_NOTICE.split("\n").map((line) => (
        <p key={line}>{line}</p>
      ))}
      <label className="check-consent-remember">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        今後表示しない（設定の「学習データ」から取り消せます）
      </label>
      <div className="actions">
        <button type="button" disabled={saving} onClick={() => onAgree(remember)}>
          同意して {count} 組作る
        </button>
        <button type="button" className="secondary" disabled={saving} onClick={onCancel}>
          やめる
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          同意を記録できませんでした：{error}
        </p>
      )}
    </div>
  );
}

/** 生成の失敗。どの狙いで失敗したかを添えて出す（RULE-004）。 */
type GenerateFailure = { title: string; message: string };

function CheckPage() {
  const { conceptId } = Route.useParams();
  const { from } = Route.useSearch();
  const loaded = Route.useLoaderData();
  const { label, areaName } = loaded;

  const [checks, setChecks] = useState(loaded.checks);
  // 取り込んだマップの公開の問題（#250）。同じ狙いに自分の組ができたら出さない。
  const mapChecks = shownMapChecks(
    loaded.mapChecks,
    checks,
    loaded.objectives.map((objective) => objective.id),
  );
  const [consent, setConsent] = useState<CheckGenerationConsent>(loaded.consent);
  const [level, setLevel] = useState<CheckLevel>(loaded.recommended.level);
  const [scope, setScope] = useState<CheckScope>("concept");
  const [selected, setSelected] = useState<readonly string[]>(() =>
    defaultObjectiveSelection(loaded.objectives, savedTargetsOf(loaded.checks)),
  );
  const [pendingTargets, setPendingTargets] = useState<Target[]>();
  const [consentSaving, setConsentSaving] = useState(false);
  const [consentError, setConsentError] = useState<string>();
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [failures, setFailures] = useState<GenerateFailure[]>([]);
  const submitGuard = useRef(createSubmitGuard());
  // 「復習する」で増やす。組の key に入れて、採点済みの組も未回答から解き直せるようにする。
  const [round, setRound] = useState(0);
  const sets = useRef<HTMLElement>(null);
  // 出している組の狙い（`checkTargetOf`）。作り直しで日時が変わっても同じ組を指し続ける（#270）。
  const [current, setCurrent] = useState<string>();
  // 終えていない組が無くなって「次へ」進んだ。まとめを出す。
  const [finished, setFinished] = useState(false);
  // 採点した組の鍵（`checkSetKey`）と、2問とも正解だったか。スキップした組は入らない。
  const [results, setResults] = useState<ReadonlyMap<string, boolean>>(new Map());
  // 「次へ」「スキップ」で離れた組の鍵。採点した組と合わせて「終えた組」とする。
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());

  const objectiveLabel = new Map(
    loaded.objectives.map((objective) => [objective.id, objective.label]),
  );
  const titleOf = (target: Target) =>
    target.objectiveId === undefined
      ? label
      : (objectiveLabel.get(target.objectiveId) ?? target.objectiveId);
  const savedTargets = savedTargetsOf(checks);
  const generating = progress !== undefined;

  const ordered = orderedChecks(
    checks,
    loaded.objectives.map((objective) => objective.id),
  );
  const open = ordered.map((check) => {
    const key = checkSetKey(check, round);
    return !left.has(key) && !results.has(key);
  });
  const firstOpen = open.indexOf(true);
  // まとめを開いたあとに新しい組ができたら、まとめを閉じてその組を出す（作っている間に増える）。
  const summarized = finished && firstOpen === -1;
  const found = ordered.findIndex((check) => checkTargetOf(check) === current);
  const position = finished ? Math.max(firstOpen, 0) : found === -1 ? 0 : found;
  const shownCheck = ordered[position];

  /** 組を出す。組の頭へ送り、解く組が変わったことが分かるようにする。 */
  const show = (target: string) => {
    setCurrent(target);
    setFinished(false);
    sets.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  /**
   * 次の組へ（スキップも同じ）。まだ終えていない組へ進み、無ければまとめへ。
   * スキップは何も記録しない。
   */
  const next = () => {
    if (shownCheck === undefined) return;
    setLeft((current) => new Set(current).add(checkSetKey(shownCheck, round)));
    const following = nextCheckIndex(open, position);
    const target = following === undefined ? undefined : ordered[following];
    if (target === undefined) {
      setFinished(true);
      sets.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    show(checkTargetOf(target));
  };

  /** 選んだ狙いを順に1組ずつ作る。1組ごとに AI の利用回数を1回使う。 */
  const run = (targets: Target[], consentVersion: number | undefined) => {
    // 入口で弾く（RULE-007）。
    if (targets.length === 0 || submitGuard.current.isRunning("generate")) return;
    setFailures([]);
    setProgress({ done: 0, total: targets.length });
    void submitGuard.current
      .run("generate", async () => {
        const generated = new Set<string>();
        let shown = false;
        for (const [index, target] of targets.entries()) {
          try {
            const check = await generateCheck({
              conceptId,
              scope: target.scope,
              level,
              ...(target.objectiveId === undefined ? {} : { objectiveId: target.objectiveId }),
              ...(consentVersion === undefined ? {} : { consentVersion }),
            });
            setChecks((current) => upsertCheck(current, check));
            generated.add(checkTargetOf(check));
            // 作った組を出す（#270 の決定）。続けて作る組で、解き始めた組から動かさないよう最初の1組だけ。
            if (!shown) {
              shown = true;
              show(checkTargetOf(check));
            }
          } catch (value: unknown) {
            if (value instanceof ApiError && value.kind === "session_expired") {
              window.location.href = "/login";
              return;
            }
            if (value instanceof CheckConsentRequiredError) {
              // 文面の版が変わった、または記録が取り消された。残りは同意を取り直してから作る。
              setConsent({ version: value.version, granted: false });
              setPendingTargets(targets.slice(index));
              break;
            }
            setFailures((current) => [
              ...current,
              { title: titleOf(target), message: checkErrorText(value) },
            ]);
          }
          setProgress({ done: index + 1, total: targets.length });
        }
        // 作れた項目は選択から外す。続けて押したときに同じ項目を作り直して回数を使わない。
        setSelected((current) => current.filter((id) => !generated.has(id)));
      })
      .finally(() => setProgress(undefined));
  };

  /** 作る。同意の記録が無ければ、先に送る内容を示す。 */
  const request = (targets: Target[]) => {
    if (targets.length === 0 || generating) return;
    if (consent.granted) {
      run(targets, undefined);
      return;
    }
    setConsentError(undefined);
    setPendingTargets(targets);
  };

  const agree = (remember: boolean) => {
    const targets = pendingTargets;
    if (targets === undefined || consentSaving) return;
    const version = consent.version;
    if (!remember) {
      setPendingTargets(undefined);
      run(targets, version);
      return;
    }
    setConsentSaving(true);
    setConsentError(undefined);
    changeGenerationConsent({ grant: version })
      .then((saved) => {
        setConsent(saved);
        setPendingTargets(undefined);
        run(targets, version);
      })
      .catch((value: unknown) => {
        if (value instanceof ApiError && value.kind === "session_expired") {
          window.location.href = "/login";
          return;
        }
        setConsentError(checkErrorText(value));
      })
      .finally(() => setConsentSaving(false));
  };

  const targets = generationTargets(scope, loaded.objectives, selected, savedTargets);
  const understood = allObjectivesUnderstood(loaded.objectives);
  // 保存済みの問題を解き直す。生成しないので AI の利用回数を使わない（#236）。
  const review = () => {
    setRound((current) => current + 1);
    setResults(new Map());
    setLeft(new Set());
    const first = ordered[0];
    if (first !== undefined) show(checkTargetOf(first));
  };
  const tally = checkTally(checks, round, results);
  const shownResult = shownCheck && results.get(checkSetKey(shownCheck, round));
  const reviewable = scope === "concept" && targets.length === 0 && checks.length > 0;
  const toggle = (objectiveId: string) =>
    setSelected((current) =>
      current.includes(objectiveId)
        ? current.filter((id) => id !== objectiveId)
        : [...current, objectiveId],
    );

  return (
    <section className="check-page">
      <p>
        <BackLink conceptId={conceptId} from={from} />
      </p>
      <h1>{label} の確認問題</h1>
      <p className="muted">
        2問1組で出題します。2問とも正解すると理解できたものとして記録します。選んだ答えは保存しません。
      </p>

      <section className="check-generate" aria-label="問題を作る">
        <h2>問題を作る</h2>
        <div className="check-field">
          <span className="check-field-label">技術レベル</span>
          <div className="check-options" role="radiogroup" aria-label="技術レベル">
            {CHECK_LEVELS.map((candidate) => (
              <label key={candidate} className="check-option">
                <input
                  type="radio"
                  name="check-level"
                  checked={level === candidate}
                  disabled={generating}
                  onChange={() => setLevel(candidate)}
                />
                {CHECK_LEVEL_LABELS[candidate]}
                {candidate === loaded.recommended.level && <em className="badge">推奨</em>}
              </label>
            ))}
          </div>
          <p className="muted">
            {areaName} の今の技術レベル：{CHECK_LEVEL_LABELS[loaded.recommended.level]}（確認済み{" "}
            {loaded.recommended.confirmed} / {loaded.recommended.total} Concept）
          </p>
        </div>

        <div className="check-field">
          <span className="check-field-label">範囲</span>
          <div className="check-options" role="radiogroup" aria-label="範囲">
            {CHECK_SCOPES.map((candidate) => (
              <label key={candidate} className="check-option">
                <input
                  type="radio"
                  name="check-scope"
                  checked={scope === candidate}
                  disabled={
                    generating || (candidate === "objective" && loaded.objectives.length === 0)
                  }
                  onChange={() => setScope(candidate)}
                />
                {CHECK_SCOPE_LABELS[candidate]}
              </label>
            ))}
          </div>
          {loaded.objectives.length === 0 ? (
            <p className="muted">
              この Concept にはまだ「理解すること」の一覧がないため、Concept 全体から1組作ります。
            </p>
          ) : scope === "concept" ? (
            <p className="muted">
              まだ理解済み（100%）でない項目を自動ですべて選び、1項目につき1組作ります。作成済みの項目は、下の「作った問題」から作り直せます。
            </p>
          ) : null}
        </div>

        {scope === "objective" && (
          <div className="check-field">
            <span className="check-field-label">理解すること（1項目につき1組）</span>
            <ul className="check-objectives">
              {loaded.objectives.map((objective) => (
                <li key={objective.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(objective.id)}
                      disabled={generating}
                      onChange={() => toggle(objective.id)}
                    />
                    <span>{objective.label}</span>
                    <span className="check-objective-meta">
                      {savedTargets.has(objective.id) && <em className="badge">作成済み</em>}
                      {percent(objective.value)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="muted">
              まだ満点でない項目を最初から選んでいます。作成済みの項目を選ぶと作り直します。
            </p>
          </div>
        )}

        {pendingTargets ? (
          <ConsentPrompt
            count={pendingTargets.length}
            saving={consentSaving}
            error={consentError}
            onAgree={agree}
            onCancel={() => setPendingTargets(undefined)}
          />
        ) : (
          <div className="actions">
            {reviewable ? (
              <button type="button" disabled={generating} onClick={review}>
                {understood ? "復習する" : "作った問題を解く"}
              </button>
            ) : (
              <button
                type="button"
                disabled={targets.length === 0 || generating}
                onClick={() => request(targets)}
              >
                {targets.length > 0
                  ? `${targets.length} 組作る（AI 利用 ${targets.length} 回）`
                  : scope === "objective"
                    ? "項目を選んでください"
                    : "作る問題がありません"}
              </button>
            )}
            {reviewable && (
              <span className="muted">保存済みの問題を出します（AI は使いません）。</span>
            )}
            {scope === "concept" && targets.length === 0 && checks.length === 0 && understood && (
              <span className="muted">
                すべての項目を理解済みです。「理解すること」で項目を選ぶと問題を作れます。
              </span>
            )}
            {progress && (
              <span className="muted" role="status">
                作成中… {progress.done} / {progress.total}{" "}
                組（混み合っていると、1組に数分かかることがあります）
              </span>
            )}
          </div>
        )}
        {failures.length > 0 && (
          <ul className="check-failures" role="alert">
            {failures.map((failure, index) => (
              <li key={index} className="error-text">
                {failure.title}：{failure.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="check-sets" aria-label="作った問題" ref={sets}>
        <h2>作った問題</h2>
        {checks.length === 0 ? (
          <p className="muted">まだ問題がありません。上で範囲を選んで作ってください。</p>
        ) : (
          <>
            <nav className="check-nav" aria-label="組の移動">
              <ol>
                {ordered.map((check, index) => {
                  const result = results.get(checkSetKey(check, round));
                  const classes = [
                    "check-nav-item",
                    result === true && "passed",
                    result === false && "failed",
                  ].filter(Boolean);
                  return (
                    <li key={checkTargetOf(check)}>
                      <button
                        type="button"
                        className={classes.join(" ")}
                        aria-current={!summarized && index === position ? "step" : undefined}
                        title={titleOf(check)}
                        onClick={() => show(checkTargetOf(check))}
                      >
                        Q{index + 1}
                      </button>
                    </li>
                  );
                })}
              </ol>
              <span className="muted">
                {summarized ? "まとめ" : `${position + 1} / ${ordered.length} 組目`}
              </span>
            </nav>
            {ordered.map((check) => (
              <CheckSet
                key={checkSetKey(check, round)}
                check={check}
                title={titleOf(check)}
                hidden={summarized || check !== shownCheck}
                retakable={scope === "objective"}
                regenerate={{
                  label: `作り直す（${CHECK_LEVEL_LABELS[level]}）`,
                  running: generating,
                  onClick: () =>
                    request([
                      {
                        scope: check.scope,
                        ...(check.objectiveId === undefined
                          ? {}
                          : { objectiveId: check.objectiveId }),
                      },
                    ]),
                }}
                onGraded={(passed) =>
                  setResults((current) => new Map(current).set(checkSetKey(check, round), passed))
                }
                onRetake={() =>
                  setResults((current) => {
                    const rest = new Map(current);
                    rest.delete(checkSetKey(check, round));
                    return rest;
                  })
                }
              />
            ))}
            {summarized ? (
              <section className="check-summary" role="status">
                <h3>全部の組を終えました</h3>
                <p>
                  {tally.total} 組中 {tally.passed} 組正解
                </p>
                <div className="actions">
                  {scope === "concept" && (
                    <button type="button" disabled={generating} onClick={review}>
                      もう一度解く
                    </button>
                  )}
                  <span className="muted">上の Q を押すと、その組へ戻れます。</span>
                </div>
              </section>
            ) : (
              <div className="actions check-step">
                {shownResult === undefined ? (
                  <button type="button" className="secondary" onClick={next}>
                    スキップ
                  </button>
                ) : (
                  <button type="button" onClick={next}>
                    {nextCheckIndex(open, position) === undefined ? "まとめを見る" : "次の組へ"}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {mapChecks.length > 0 && (
        <section className="check-sets" aria-label="マップの問題">
          <h2>マップの問題</h2>
          <p className="muted">
            取り込んだマップの作成者が公開した問題です。保存済みの問題を出すだけで、AI
            は使いません（利用回数に数えません）。作り直しはできません。同じ項目で自分の問題を作ると、そちらを出します。
          </p>
          {mapChecks.map((check) => (
            <CheckSet
              key={checkSetKey(check, round)}
              check={check}
              title={titleOf(check)}
              hidden={false}
              retakable
              onGraded={() => undefined}
              onRetake={() => undefined}
            />
          ))}
        </section>
      )}
    </section>
  );
}

/** 失敗は確認問題向けの文面で伝える。ログインが要る場合などは共通の表示に任せる。 */
function CheckError({ error }: ErrorComponentProps) {
  const { conceptId } = Route.useParams();
  const { from } = Route.useSearch();
  const router = useRouter();
  if (
    error instanceof ApiError &&
    (error.kind === "login_required" || error.kind === "session_expired")
  )
    return <ErrorPanel error={error} />;
  return (
    <section className="check-page">
      <p>
        <BackLink conceptId={conceptId} from={from} />
      </p>
      <section className="message error">
        <p>{checkErrorText(error)}</p>
        <button onClick={() => router.invalidate()}>再試行</button>
      </section>
    </section>
  );
}

export const Route = createFileRoute("/_framed/check/$conceptId")({
  // 手で作ったマップの画面から来たときの戻り先（`?from=<マップの ID>`）。形の違う値は捨てる。
  validateSearch: (search: Record<string, unknown>): { from?: string } =>
    typeof search.from === "string" && isMapId(search.from) ? { from: search.from } : {},
  // 保存済みの組は生成のたびに変わる。戻ってきたときに古い一覧を見せない。
  staleTime: 0,
  loader: async ({ params }) => {
    // 読むだけで、AI は呼ばない。生成は利用者が「作る」を押したときだけ。
    const retry = takeLoginRetry();
    const mapId = mapIdOfConcept(params.conceptId);
    const [{ checks, mapChecks }, profile, overrides, consent, map, fixed] = await Promise.all([
      fetchSavedChecks(params.conceptId, fetch, retry),
      requestJson<MapProfile>("/api/v1/learning-profile", fetch, retry),
      requestJson<MasteryOverrides>("/api/v1/mastery-overrides", fetch, retry),
      fetchGenerationConsent(fetch, retry),
      // 手で作ったノードは、そのマップから定義を引く（#242）。取り込んだマップのノードは ID の前半が
      // 元のマップなので、自分のノードを持つマップを探して引く（#244）。どちらにも無ければ 404。
      mapId === undefined ? undefined : fetchOwnMapContaining(params.conceptId, fetch, retry),
      // 固定の Concept の項目は API の表から読む（#245）。
      mapId === undefined ? fetchFixedMaps(fetch, retry) : undefined,
    ]);

    // 対象の Concept と同じ領域（手で作ったノードならそのマップ）の定義・項目・見出し。
    let area: { definitions: readonly DomainConcept[]; objectives: readonly LearningObjective[] };
    let areaName: string;
    if (map === undefined) {
      // 上で `mapId === undefined` のときに読んでいる。
      if (fixed === undefined) throw new Error("fixed objectives were not loaded");
      const definition = CONCEPT_BY_ID.get(params.conceptId);
      if (definition === undefined) throw new ApiError("not_found");
      area = {
        definitions: [...CONCEPT_BY_ID.values()].filter(
          (candidate) => candidate.language === definition.language,
        ),
        objectives: objectivesByConcept(fixed.objectives).get(params.conceptId) ?? [],
      };
      areaName = languageLabel[definition.language] ?? definition.language;
    } else {
      const defined = mapDefinitions(map);
      // そのノードを持つマップとして引いたので、ここに無いならノードが消えている。
      if (!defined.concepts.some((candidate) => candidate.id === params.conceptId)) {
        throw new ApiError("not_found");
      }
      area = {
        definitions: defined.concepts,
        objectives: defined.objectives.filter(
          (objective) => objective.conceptId === params.conceptId,
        ),
      };
      areaName = map.title;
    }
    const label =
      area.definitions.find((candidate) => candidate.id === params.conceptId)?.label ??
      params.conceptId;

    const concepts = overlaidConcepts(profile, overrides, area.definitions);
    const concept = concepts.find((candidate) => candidate.conceptId === params.conceptId);
    // 手動修正は status だけを変えるので、項目の割合は自動算出のまま見せる（詳細パネルと同じ）。
    const objectives: ObjectiveProgress[] = concept
      ? objectiveProgress(area.objectives, {
          status: concept.derived.status,
          objectives: concept.objectives,
        })
      : [];
    const areaIds = new Set(area.definitions.map((candidate) => candidate.id));
    const recommended = recommendedLevel(
      concepts
        .filter((candidate) => areaIds.has(candidate.conceptId))
        .map((candidate) => candidate.status),
    );
    return { checks, mapChecks, consent, objectives, recommended, label, areaName };
  },
  errorComponent: CheckError,
  // 同じルートのまま Concept だけ変わっても、前の Concept の問題や選択を持ち越さない。
  component: function CheckPageForConcept() {
    const { conceptId } = Route.useParams();
    return <CheckPage key={conceptId} />;
  },
});
