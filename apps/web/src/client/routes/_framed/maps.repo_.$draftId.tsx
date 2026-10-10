import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { createSubmitGuard } from "../../api.js";
import { fetchGenerationConsent } from "../../check.js";
import { ConsentPrompt } from "../../map-consent.js";
import { MAP_GENERATION_CONSENT_PATH } from "../../map-generation.js";
import { CandidateRow, MaterialGroups } from "../../repo-map-lists.js";
import {
  isConsentRequired,
  redirectIfSessionExpired,
  repoMapErrorText,
  useConsentFlow,
} from "../../repo-map-ui.js";
import {
  arrangeCandidates,
  buildConfirmRequest,
  buildRepoMapCandidates,
  confirmRepoMapDraft,
  DROP_REASON_LABELS,
  fetchRepoMapDraft,
  nextStep,
  rebuildRepoMapCandidates,
  REPO_MAP_LIMITS,
  runSummarize,
  validateConfirm,
  type CandidateSort,
  type RepoMapCandidate,
  type RepoMapDraft,
  type RepoMapNodeKind,
} from "../../repo-maps.js";
import { takeLoginRetry } from "../../session.js";

/** 確定できるノードの数（API の上限）。 */
const MAX_NODES = 30;

type Phase = "idle" | "summarize" | "candidates" | "rebuild" | "confirm";

const SKIP_REASONS: Record<string, string> = {
  unreadable: "読めない形式（バイナリ）だったため",
  pull_request: "Issue ではなく PR だったため",
};

/** 候補の選び方の既定: AI の候補は全部、データの形にだけある名前は選ばない。 */
function defaultSelection(items: readonly RepoMapCandidate[]): Set<string> {
  return new Set(items.filter((c) => !c.schemaOnly).map((c) => c.id));
}

/** 下書きの ID ごとに状態を作り直す（別の下書きへ移っても、前の下書きの状態を持ち越さない）。 */
function RepoMapDraftRoute() {
  const loaded = Route.useLoaderData();
  return <RepoMapDraftPage key={loaded.draft.id} loaded={loaded} />;
}

function RepoMapDraftPage({ loaded }: { loaded: ReturnType<typeof Route.useLoaderData> }) {
  const navigate = useNavigate();
  const guard = useRef(createSubmitGuard());
  const consentFlow = useConsentFlow(loaded.consent);

  const [draft, setDraft] = useState<RepoMapDraft>(loaded.draft);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    defaultSelection(loaded.draft.candidates?.items ?? []),
  );
  const [edits, setEdits] = useState<
    Record<string, { name?: string; description?: string; kind?: RepoMapNodeKind | null }>
  >({});
  const [title, setTitle] = useState("");
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CandidateSort>("default");

  const step = nextStep(draft);
  const busy = phase !== "idle";
  // 同意の確認中に入力を変えると、同意した内容と違うものを送ってしまう。確認中は入力を止める。
  const locked = busy || consentFlow.asking;
  const candidates = draft.candidates?.items ?? [];

  /** 候補を受け取ったら、選び方と直しを最初に戻す（候補の ID は作り直しで変わる）。 */
  const adopt = (next: RepoMapDraft) => {
    setDraft(next);
    if (next.candidates !== null) {
      setSelected(defaultSelection(next.candidates.items));
      setEdits({});
      setEditing(new Set());
    }
  };

  /** 失敗を画面へ。同意が要るなら、同意の確認を出して `retry` をやり直す。 */
  const fail = (value: unknown, retry: (consentVersion: number | undefined) => void) => {
    if (redirectIfSessionExpired(value)) return;
    if (isConsentRequired(value)) {
      consentFlow.required(value.version, retry);
      return;
    }
    setError(repoMapErrorText(value));
  };

  /** 材料を読んで（要約）、候補を作る。要約が終わっていれば候補だけ。 */
  const advance = (consentVersion: number | undefined) => {
    if (guard.current.isRunning("advance")) return;
    setError(undefined);
    void guard.current
      .run("advance", async () => {
        try {
          let current = draft;
          if (nextStep(current).kind === "summarize") {
            setPhase("summarize");
            current = await runSummarize(current.id, consentVersion, {
              onRound: (round) => setProgress(`続きを読んでいます（${String(round + 1)} 回目）…`),
            });
            setDraft(current);
            if (current.status !== "summarized") {
              setError(
                "材料を読み切れませんでした。もう一度押すと、続きから進みます（済んだ分は使い回します）。",
              );
              return;
            }
          }
          setPhase("candidates");
          setProgress(undefined);
          adopt(await buildRepoMapCandidates(current.id, consentVersion));
        } catch (value: unknown) {
          // 失敗の段は下書きに残っている。読み直して、続きから進められる状態を見せる。
          await fetchRepoMapDraft(draft.id)
            .then(setDraft)
            .catch((refreshError: unknown) => {
              // 失敗の理由は下で出す。読み直せなかったことは記録する（画面の状態が古いままになる）。
              console.error("failed to reload a repo map draft", refreshError);
            });
          fail(value, advance);
        }
      })
      .finally(() => {
        setPhase("idle");
        setProgress(undefined);
      });
  };

  const rebuild = (consentVersion: number | undefined) => {
    if (guard.current.isRunning("rebuild")) return;
    setError(undefined);
    setPhase("rebuild");
    void guard.current
      .run("rebuild", async () => {
        try {
          adopt(await rebuildRepoMapCandidates(draft.id, [...excluded], consentVersion));
          setExcluded(new Set());
        } catch (value: unknown) {
          fail(value, rebuild);
        }
      })
      .finally(() => setPhase("idle"));
  };

  const confirm = (consentVersion: number | undefined) => {
    const request = buildConfirmRequest(candidates, selected, edits, title);
    const invalid = validateConfirm(request, MAX_NODES, candidates);
    if (invalid !== undefined) {
      setError(invalid);
      return;
    }
    if (guard.current.isRunning("confirm")) return;
    setError(undefined);
    setPhase("confirm");
    void guard.current
      .run("confirm", async () => {
        try {
          const mapId = await confirmRepoMapDraft(draft.id, {
            ...request,
            ...(consentVersion === undefined ? {} : { consentVersion }),
          });
          await navigate({ to: "/maps/$mapId", params: { mapId } });
        } catch (value: unknown) {
          fail(value, confirm);
        }
      })
      .finally(() => setPhase("idle"));
  };

  const toggle = <T extends string>(set: ReadonlySet<T>, id: T, apply: (next: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  const edit = (
    id: string,
    patch: { name?: string; description?: string; kind?: RepoMapNodeKind | null },
  ) => setEdits((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  const visible = arrangeCandidates(candidates, {
    query,
    sort,
    names: Object.fromEntries(Object.entries(edits).map(([id, e]) => [id, e?.name])),
  });
  const materials = draft.summary?.materials ?? [];
  const schemaFiles = draft.summary?.schema ?? [];
  const unread = draft.targets.files.filter(
    (f) => !materials.some((m) => m.ref === f) && !schemaFiles.some((s) => s.path === f),
  );

  return (
    <>
      <p className="map-head">
        <Link to="/maps/repo" className="link">
          ← リポジトリからマップを作る
        </Link>
        <h1>{draft.repo.url}</h1>
        <span className="muted">{draft.repo.commitSha.slice(0, 7)} 時点</span>
      </p>

      {step.kind === "confirmed" ? (
        <section className="message">
          <p>この下書きは確定済みです。</p>
          <Link to="/maps/$mapId" params={{ mapId: step.mapId }} className="link">
            作ったマップを開く
          </Link>
        </section>
      ) : (
        <>
          <section aria-label="読み取りの結果">
            <p>
              ファイル {draft.scan.blobTotal} 件（文書{" "}
              {(draft.scan.kept.doc ?? 0) + (draft.scan.kept.glossary ?? 0)}・コード{" "}
              {draft.scan.kept.code ?? 0}・データの形 {draft.scan.kept.schema ?? 0}）
              {draft.targets.folders.length > 0 && `・対象: ${draft.targets.folders.join("、")}`}
            </p>
            {Object.keys(draft.scan.dropped).length > 0 && (
              <p className="muted">
                読まないもの:{" "}
                {Object.entries(draft.scan.dropped)
                  .map(
                    ([reason, count]) =>
                      `${DROP_REASON_LABELS[reason] ?? reason} ${String(count)} 件`,
                  )
                  .join("、")}
              </p>
            )}
          </section>

          {(step.kind === "summarize" || step.kind === "candidates") && (
            <section className="map-create" aria-label="材料を読む">
              <h2>{step.kind === "summarize" ? "材料を読む" : "候補を作る"}</h2>
              {draft.failure && (
                <p className="message error" role="alert">
                  前回は途中で止まりました（
                  {draft.failure.stage === "summarize" ? "材料を読む" : "候補を作る"}）。
                  続きから進められます。済んだ分は使い回します。
                </p>
              )}
              <p>
                文書・コード・Issue を AI で要約し、用語の候補を作ります。データの形（スキーマ）は、
                文書が少ないときだけ名前を AI へ渡します。数十秒から数分かかることがあります。
              </p>
              {consentFlow.asking ? (
                <ConsentPrompt
                  saving={consentFlow.saving}
                  error={consentFlow.error}
                  onAgree={consentFlow.agree}
                  onCancel={consentFlow.cancel}
                  agreeLabel="同意して進める"
                />
              ) : (
                <div className="actions">
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => consentFlow.request(advance)}
                  >
                    {phase === "summarize"
                      ? "材料を読んでいます…"
                      : phase === "candidates"
                        ? "候補を作っています…"
                        : step.kind === "summarize"
                          ? "材料を読んで候補を作る"
                          : "候補を作る"}
                  </button>
                </div>
              )}
              {busy && (
                <p className="muted" role="status">
                  {progress ?? "AI が作業しています。画面を閉じずにお待ちください。"}
                </p>
              )}
            </section>
          )}

          {step.kind === "choose" && draft.candidates && (
            <>
              <section aria-label="用語の候補">
                <h2>用語の候補</h2>
                {draft.candidates.thin && (
                  <p className="muted">
                    文書が少ないため、データの形（テーブル名など）とコードを主な材料にしました。
                  </p>
                )}
                <p className="muted">
                  マップに入れる用語を選び、必要なら表示名・説明を直してください（{MAX_NODES}{" "}
                  個まで）。根拠のリンクは、読んだ時点（{draft.repo.commitSha.slice(0, 7)}
                  ）で固定されています。
                </p>
                <div className="repo-toolbar">
                  <span role="status">
                    選択中 <strong>{selected.size}</strong> / {MAX_NODES}
                    {selected.size > MAX_NODES && (
                      <span className="error-text">（{MAX_NODES} 個までです）</span>
                    )}
                  </span>
                  <input
                    type="search"
                    value={query}
                    placeholder="名前・説明で絞り込む"
                    aria-label="候補を絞り込む"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <select
                    value={sort}
                    aria-label="並び順"
                    onChange={(event) => setSort(event.target.value as CandidateSort)}
                  >
                    <option value="default">AI の並び</option>
                    <option value="evidence">根拠が多い順</option>
                  </select>
                  <button
                    type="button"
                    className="secondary"
                    disabled={locked}
                    onClick={() =>
                      setSelected(
                        new Set([...selected, ...visible.map((c) => c.id)].slice(0, MAX_NODES)),
                      )
                    }
                  >
                    表示中を選ぶ
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={locked}
                    onClick={() =>
                      setSelected(
                        new Set([...selected].filter((id) => !visible.some((c) => c.id === id))),
                      )
                    }
                  >
                    表示中を外す
                  </button>
                </div>
                <ul className="repo-candidates">
                  {visible.map((candidate) => (
                    <CandidateRow
                      key={candidate.id}
                      candidate={candidate}
                      checked={selected.has(candidate.id)}
                      editing={editing.has(candidate.id)}
                      edit={edits[candidate.id]}
                      disabled={locked}
                      onToggle={() => toggle(selected, candidate.id, setSelected)}
                      onToggleEditing={() => toggle(editing, candidate.id, setEditing)}
                      onEdit={(patch) => edit(candidate.id, patch)}
                    />
                  ))}
                </ul>
                {visible.length === 0 && <p className="muted">一致する候補がありません。</p>}
              </section>

              <section className="map-create repo-confirm-bar" aria-label="マップを作る">
                <label>
                  マップの題名（空ならリポジトリ名から付けます）
                  <input
                    value={title}
                    maxLength={REPO_MAP_LIMITS.title}
                    disabled={locked}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <p className="muted">
                  選んだ用語 {selected.size} 個。AI
                  が学ぶ順と前提を決め、根拠をもとに各ノードの「理解すること」を作ります。
                </p>
                {consentFlow.asking ? (
                  <ConsentPrompt
                    saving={consentFlow.saving}
                    error={consentFlow.error}
                    onAgree={consentFlow.agree}
                    onCancel={consentFlow.cancel}
                    agreeLabel="同意して作る"
                  />
                ) : (
                  <div className="actions">
                    <button
                      type="button"
                      disabled={busy || selected.size < 1 || selected.size > MAX_NODES}
                      onClick={() => consentFlow.request(confirm)}
                    >
                      {phase === "confirm"
                        ? "マップを作っています…"
                        : `選んだ ${String(selected.size)} 個でマップを作る`}
                    </button>
                  </div>
                )}
                {phase === "confirm" && (
                  <p className="muted" role="status">
                    AI が木と「理解すること」を作っています。画面を閉じずにお待ちください。
                  </p>
                )}
              </section>

              <section aria-label="読んだ材料">
                <h2>読んだ材料</h2>
                <p className="muted">
                  候補がずれているときは、無関係な材料を外して、候補だけを作り直せます（1 日 5
                  回まで。今月の枠は使いません）。
                </p>
                {draft.targets.files.length > 0 && (
                  <p>
                    指定したファイル {draft.targets.files.length} 件・読んだ{" "}
                    {draft.targets.files.length - unread.length} 件
                    {unread.length > 0 && (
                      <span className="muted">（要約に入らなかった: {unread.join("、")}）</span>
                    )}
                  </p>
                )}
                <MaterialGroups
                  materials={materials}
                  schemaFiles={schemaFiles}
                  excluded={excluded}
                  disabled={locked}
                  onToggle={(id) => toggle(excluded, id, setExcluded)}
                />
                {draft.summary && draft.summary.skipped.length > 0 && (
                  <p className="muted">
                    読まなかったもの:{" "}
                    {draft.summary.skipped
                      .map((s) => `${s.ref}（${SKIP_REASONS[s.reason] ?? s.reason}）`)
                      .join("、")}
                  </p>
                )}
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || excluded.size === 0}
                    onClick={() => consentFlow.request(rebuild)}
                  >
                    {phase === "rebuild"
                      ? "作り直しています…"
                      : `外した ${String(excluded.size)} 件を除いて候補を作り直す`}
                  </button>
                </div>
              </section>
            </>
          )}
        </>
      )}

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/maps/repo_/$draftId")({
  staleTime: 0,
  loader: async ({ params }) => {
    const retry = takeLoginRetry();
    const [draft, consent] = await Promise.all([
      fetchRepoMapDraft(params.draftId, fetch, retry),
      fetchGenerationConsent(fetch, retry, MAP_GENERATION_CONSENT_PATH),
    ]);
    return { draft, consent };
  },
  component: RepoMapDraftRoute,
});
