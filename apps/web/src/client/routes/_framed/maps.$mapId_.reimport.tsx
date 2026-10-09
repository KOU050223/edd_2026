import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiError, createSubmitGuard } from "../../api.js";
import { toErrorText } from "../../errors.js";
import { MISSING_ORIGIN_LABEL } from "../../learning-maps.js";
import { MapDiffList } from "../../map-content-view.js";
import {
  fetchReimportPreview,
  nodeLabel,
  reimportLearningMap,
  shareConflictText,
  ShareConflictError,
} from "../../map-sharing.js";
import { useOpenMapAfterWrite } from "../../learning-map-view.js";
import { takeLoginRetry } from "../../session.js";

function failureText(value: unknown): string | undefined {
  if (value instanceof ApiError && value.kind === "session_expired") {
    window.location.href = "/login";
    return undefined;
  }
  return value instanceof ShareConflictError ? shareConflictText(value) : toErrorText(value);
}

/**
 * 取り込み直す前の差分（Issue #244 の決定 T4）。
 *
 * 共有の側にあるノードは新しい版の中身で上書きする（自分で直した分は消える）。自分で足したノードは残る。
 * 共有の側で消されたノードは、既定で消し、残すを選んだものだけ自分のノードとして持ち続ける。
 * どちらでも学習の記録は残る。
 */
function ReimportPage() {
  const { mapId } = Route.useParams();
  const preview = Route.useLoaderData();
  const openMap = useOpenMapAfterWrite();
  const router = useRouter();
  const [keep, setKeep] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const guard = useRef(createSubmitGuard());

  const toggle = (conceptId: string, kept: boolean) => {
    const next = new Set(keep);
    if (kept) next.add(conceptId);
    else next.delete(conceptId);
    setKeep(next);
  };

  const run = () => {
    // 送信中は入口で弾く（RULE-007）。
    if (guard.current.isRunning("reimport")) return;
    setError(undefined);
    setBusy(true);
    void guard.current
      .run("reimport", async () => {
        try {
          await reimportLearningMap(mapId, {
            version: preview.latest.version,
            revision: preview.revision,
            keep: [...keep],
          });
          await openMap(mapId);
        } catch (value: unknown) {
          setError(failureText(value));
          // 版が上がった・手元が変わったなら、今の差分を見せ直す（確かめていない差分で取り込み直させない）。
          if (value instanceof ShareConflictError) {
            setKeep(new Set());
            await router.invalidate();
          }
        }
      })
      .finally(() => setBusy(false));
  };

  const edited = new Set(preview.personallyEdited);
  const diffWithoutRemoved = { ...preview.diff, removed: [] };

  return (
    <>
      <p className="map-head">
        <Link to="/maps/$mapId" params={{ mapId }} className="link">
          ← マップへ戻る
        </Link>
        <h1>取り込み直す</h1>
      </p>
      <section className="message">
        <p>
          共有マップ「{preview.source.title}」の版 {preview.source.version} → 版{" "}
          {preview.latest.version}（{new Date(preview.latest.publishedAt).toLocaleString("ja-JP")}
          ）。
        </p>
        <p className="muted">
          共有の側にあるノードは新しい版の中身になります。自分で足したノードはそのまま残ります。
          ノードや「理解すること」が消えても、学習の記録は残ります（消えるものを狙った確認問題は消えます）。
          取り込み直さなければ、今のままです。
        </p>
      </section>

      {edited.size > 0 && (
        <section className="message error">
          <p>
            次のノードは自分で直していました。取り込み直すと、直した分は共有の側の中身で上書きされます。
          </p>
          <ul>
            {preview.diff.changed
              .filter((change) => edited.has(change.conceptId))
              .map((change) => (
                <li key={change.conceptId}>{nodeLabel(change.before) ?? MISSING_ORIGIN_LABEL}</li>
              ))}
          </ul>
        </section>
      )}

      <section>
        <h2>変わるところ</h2>
        <MapDiffList diff={diffWithoutRemoved} content={preview.content} />
      </section>

      {preview.diff.removed.length > 0 && (
        <fieldset className="share-scope" disabled={busy}>
          <legend>共有の側で消されたノード（既定は消します）</legend>
          {preview.diff.removed.map((node) => (
            <label key={node.conceptId}>
              <input
                type="checkbox"
                checked={keep.has(node.conceptId)}
                onChange={(event) => toggle(node.conceptId, event.target.checked)}
              />
              「{nodeLabel(node) ?? MISSING_ORIGIN_LABEL}」を自分のノードとして残す
            </label>
          ))}
        </fieldset>
      )}

      <div className="actions">
        <button type="button" disabled={busy} onClick={run}>
          {busy ? "取り込み直しています…" : `版 ${String(preview.latest.version)} を取り込み直す`}
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export const Route = createFileRoute("/_framed/maps/$mapId_/reimport")({
  // 手元を直して戻ってきたとき、古い差分で取り込み直させない。
  staleTime: 0,
  loader: ({ params }) => fetchReimportPreview(params.mapId, fetch, takeLoginRetry()),
  component: ReimportPage,
});
