import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { createSubmitGuard } from "../../api.js";
import { fetchGenerationConsent } from "../../check.js";
import { fetchLearningMaps, MAP_LIMITS } from "../../learning-maps.js";
import { ConsentPrompt } from "../../map-consent.js";
import { MAP_GENERATION_CONSENT_PATH } from "../../map-generation.js";
import {
  isConsentRequired,
  redirectIfSessionExpired,
  repoMapErrorText,
  useConsentFlow,
} from "../../repo-map-ui.js";
import {
  createRepoMapDraft,
  defaultFolderSelection,
  deleteRepoMapDraft,
  DROP_REASON_LABELS,
  fetchRepoMapDrafts,
  inspectRepo,
  parseHintFiles,
  parseHintIssues,
  REPO_MAP_LIMITS,
  validateHints,
  type InspectRepoResult,
} from "../../repo-maps.js";
import { HintFilePicker } from "../../repo-map-hints.js";
import { takeLoginRetry } from "../../session.js";

const MONOREPO_NOTICE =
  "このリポジトリには複数のプログラム（apps/web・apps/api など）が入っています。全部を対象にして作れます。" +
  "無関係なものが混ざってしまうときだけ、対象のフォルダを絞ってください。画面側と API 側は分けず、" +
  "両方と共有のフォルダ（packages/ など）を一緒に選ぶと、用語が抜けにくくなります。";

/**
 * GitHub の公開リポジトリから、ドメイン知識の学習マップを作る（Issue #249）。
 * 下見（枠を数えない）→ 下書きを作る（今月の枠に数える）→ 下書きの画面で要約・候補・確定。
 */
function RepoMapStartPage() {
  const loaded = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const guard = useRef(createSubmitGuard());
  const consentFlow = useConsentFlow(loaded.consent);

  const [url, setUrl] = useState("");
  const [inspected, setInspected] = useState<
    (InspectRepoResult & { inspectedFor: string }) | undefined
  >();
  const [folders, setFolders] = useState<ReadonlySet<string>>(new Set());
  const [filesText, setFilesText] = useState("");
  const [issuesText, setIssuesText] = useState("");
  const [busy, setBusy] = useState<"inspect" | "create" | undefined>();
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<string>();

  // 枠は、読み込み（作成の失敗・月の変わり目のあとの読み直し）の値を使う。下見の時点の値は古くなる。
  const usage = loaded.usage;
  const slotsLeft = usage.monthlyDraftsLimit - usage.monthlyDrafts;
  // 同意の確認中に入力を変えると、同意した内容と違うものを送ってしまう。確認中は入力を止める。
  const locked = busy !== undefined || consentFlow.asking;
  const mapsFull = loaded.mapCount >= MAP_LIMITS.maps;

  const inspect = () => {
    if (guard.current.isRunning("inspect") || url.trim() === "") return;
    setError(undefined);
    setBusy("inspect");
    void guard.current
      .run("inspect", async () => {
        try {
          const result = await inspectRepo(url.trim());
          setInspected({ ...result, inspectedFor: url.trim() });
          setFolders(new Set(defaultFolderSelection(result.monorepo)));
        } catch (value: unknown) {
          if (redirectIfSessionExpired(value)) return;
          setInspected(undefined);
          setError(repoMapErrorText(value));
        }
      })
      .finally(() => setBusy(undefined));
  };

  const hintFiles = parseHintFiles(filesText);
  const hintIssues = parseHintIssues(issuesText);
  const hintError = validateHints(hintFiles, hintIssues);
  const canCreate =
    inspected !== undefined &&
    !mapsFull &&
    slotsLeft > 0 &&
    hintError === undefined &&
    busy === undefined;

  const create = (consentVersion: number | undefined) => {
    // 入力した URL が、下見したリポジトリと違えば作らない（枠を使うので、見えているものと同じものだけ作る）。
    if (inspected === undefined || guard.current.isRunning("create")) return;
    if (url.trim() === "" || inspected.inspectedFor !== url.trim()) return;
    setError(undefined);
    setBusy("create");
    void guard.current
      .run("create", async () => {
        try {
          const { draft } = await createRepoMapDraft({
            url: inspected.repo.url,
            folders: [...folders],
            files: hintFiles,
            issues: hintIssues.numbers,
            ...(consentVersion === undefined ? {} : { consentVersion }),
          });
          await navigate({ to: "/maps/repo/$draftId", params: { draftId: draft.id } });
        } catch (value: unknown) {
          if (redirectIfSessionExpired(value)) return;
          // 枠は GitHub の失敗・指定の誤りでは消費されない。回数の表示だけ読み直す。
          await router.invalidate();
          if (isConsentRequired(value)) {
            consentFlow.required(value.version, create);
            return;
          }
          setError(repoMapErrorText(value));
        }
      })
      .finally(() => setBusy(undefined));
  };

  const remove = (id: string) => {
    if (deleting !== undefined) return;
    if (!window.confirm("この下書きを削除しますか？（今月の枠は戻りません）")) return;
    setDeleting(id);
    deleteRepoMapDraft(id)
      .then(() => router.invalidate())
      .catch((value: unknown) => {
        if (redirectIfSessionExpired(value)) return;
        setError(repoMapErrorText(value));
      })
      .finally(() => setDeleting(undefined));
  };

  const toggleFolder = (path: string) => {
    const next = new Set(folders);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setFolders(next);
  };

  return (
    <>
      <p className="map-head">
        <Link to="/maps" className="link">
          ← 自分のマップ
        </Link>
        <h1>GitHub のリポジトリからマップを作る</h1>
        <span className="muted">
          今月 {usage.monthlyDrafts} / {usage.monthlyDraftsLimit} マップ
        </span>
      </p>
      <p>
        公開リポジトリの README・文書・コード・Issue
        から、そのプロジェクトのドメイン知識（業務の概念）を
        学ぶマップを作ります。リポジトリの中身の一部（ファイルの一覧、文書の本文の先頭、コードの先頭、
        Issue のタイトルと本文の冒頭）を AI へ送ります。非公開のリポジトリは読めません。
      </p>

      {loaded.drafts.length > 0 && (
        <section aria-label="作りかけの下書き">
          <h2>作りかけの下書き</h2>
          <ul className="map-list">
            {loaded.drafts.map((draft) => (
              <li key={draft.id} className="map-list-item">
                <Link
                  to="/maps/repo/$draftId"
                  params={{ draftId: draft.id }}
                  className="map-list-link"
                >
                  <h3>{draft.repo.url}</h3>
                  <p className="muted">
                    {draft.status === "candidates"
                      ? "候補ができています（選んで確定できます）"
                      : draft.status === "summarized"
                        ? "材料を読み終えました（候補を作れます）"
                        : draft.status === "failed"
                          ? "途中で止まっています（続きから進められます）"
                          : "材料を読む前です"}
                    ・{new Date(draft.expiresAt).toLocaleDateString("ja-JP")} まで
                  </p>
                </Link>
                <button
                  className="link danger"
                  disabled={deleting === draft.id}
                  onClick={() => remove(draft.id)}
                >
                  {deleting === draft.id ? "削除中…" : "削除"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form
        className="map-create"
        onSubmit={(event) => {
          event.preventDefault();
          inspect();
        }}
      >
        <label>
          リポジトリの URL（例: github.com/owner/repo）
          <input
            value={url}
            required
            maxLength={200}
            disabled={locked || consentFlow.asking}
            onChange={(event) => {
              setUrl(event.target.value);
              // 下見の結果は、その URL のもの。入力を変えたら、別のリポジトリへ下書きを作らないよう消す。
              setInspected(undefined);
              setFolders(new Set());
            }}
          />
        </label>
        <div className="actions">
          <button type="submit" disabled={locked || url.trim() === ""}>
            {busy === "inspect" ? "確認しています…" : "リポジトリを確認する"}
          </button>
        </div>
        <p className="muted">確認だけでは今月の枠を使いません。</p>
      </form>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {inspected && (
        <section className="map-create" aria-label="確認の結果">
          <h2>{inspected.repo.url}</h2>
          <p className="muted">
            既定のブランチ {inspected.repo.defaultBranch}・{inspected.repo.commitSha.slice(0, 7)}{" "}
            時点を読みます（根拠のリンクはこの時点で固定されます）。
          </p>
          <p>
            ファイル {inspected.scan.blobTotal} 件（文書{" "}
            {(inspected.scan.kept.doc ?? 0) + (inspected.scan.kept.glossary ?? 0)}・コード{" "}
            {inspected.scan.kept.code ?? 0}・データの形 {inspected.scan.kept.schema ?? 0}）
          </p>
          {Object.keys(inspected.scan.dropped).length > 0 && (
            <p className="muted">
              読まないもの:{" "}
              {Object.entries(inspected.scan.dropped)
                .map(
                  ([reason, count]) =>
                    `${DROP_REASON_LABELS[reason] ?? reason} ${String(count)} 件`,
                )
                .join("、")}
            </p>
          )}

          {inspected.monorepo !== null ? (
            <fieldset disabled={locked}>
              <legend>対象のフォルダ</legend>
              <p className="muted">{MONOREPO_NOTICE}</p>
              {inspected.monorepo.map((folder) => (
                <label key={folder.path} className="check-consent-remember">
                  <input
                    type="checkbox"
                    checked={folders.has(folder.path)}
                    onChange={() => toggleFolder(folder.path)}
                  />
                  {folder.path}
                  {folder.shared && "（共有）"}
                </label>
              ))}
              <p className="muted">何も選ばなければ、全体を対象にします。</p>
            </fieldset>
          ) : (
            inspected.folders.length > 0 && (
              <details>
                <summary>対象のフォルダを絞る（任意）</summary>
                <fieldset disabled={locked}>
                  {inspected.folders.slice(0, REPO_MAP_LIMITS.folders).map((path) => (
                    <label key={path} className="check-consent-remember">
                      <input
                        type="checkbox"
                        checked={folders.has(path)}
                        onChange={() => toggleFolder(path)}
                      />
                      {path}
                    </label>
                  ))}
                </fieldset>
              </details>
            )
          )}

          <HintFilePicker
            options={inspected.files ?? []}
            truncated={inspected.filesTruncated ?? false}
            text={filesText}
            onChange={setFilesText}
            disabled={locked}
          />
          <label>
            参考にしてほしい Issue（任意・番号か URL・1 行に 1 つ・{REPO_MAP_LIMITS.hints} 個まで）
            <textarea
              rows={3}
              value={issuesText}
              placeholder="#12"
              disabled={locked}
              onChange={(event) => setIssuesText(event.target.value)}
            />
          </label>
          {hintError && (
            <p className="error-text" role="alert">
              {hintError}
            </p>
          )}

          {consentFlow.asking ? (
            <ConsentPrompt
              saving={consentFlow.saving}
              error={consentFlow.error}
              onAgree={consentFlow.agree}
              onCancel={consentFlow.cancel}
              agreeLabel="同意して下書きを作る"
            />
          ) : (
            <div className="actions">
              <button
                type="button"
                disabled={!canCreate}
                onClick={() => consentFlow.request(create)}
              >
                {busy === "create" ? "下書きを作っています…" : "下書きを作る"}
              </button>
            </div>
          )}
          <p className="muted">
            下書きを作ると、今月の枠を 1 つ使います（残り {slotsLeft} マップ）。下書きは 30
            日で消えます。AI へ送るのは、次の画面で「材料を読む」を押したときからです。
          </p>
          {mapsFull && (
            <p className="muted">
              マップは {MAP_LIMITS.maps} 個までです。使っていないマップを消すと作れます。
            </p>
          )}
          {slotsLeft <= 0 && <p className="muted">今月に作れるマップの数に達しています。</p>}
        </section>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/maps/repo")({
  staleTime: 0,
  loader: async () => {
    const retry = takeLoginRetry();
    const [{ drafts, usage }, consent, { maps }] = await Promise.all([
      fetchRepoMapDrafts(fetch, retry),
      fetchGenerationConsent(fetch, retry, MAP_GENERATION_CONSENT_PATH),
      fetchLearningMaps(fetch, retry),
    ]);
    return { drafts, usage, consent, mapCount: maps.length };
  },
  component: RepoMapStartPage,
});
