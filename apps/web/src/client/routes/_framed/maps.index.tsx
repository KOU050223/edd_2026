import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiError, createSubmitGuard } from "../../api.js";
import { toErrorText } from "../../errors.js";
import {
  createLearningMap,
  deleteLearningMap,
  fetchLearningMaps,
  MAP_LIMITS,
  MapInputError,
  MapLimitError,
  hasSourceUpdate,
} from "../../learning-maps.js";
import { fetchSharedMaps, VISIBILITY_BADGES, type SharedMapSummary } from "../../map-sharing.js";
import { takeLoginRetry } from "../../session.js";

/** マップを作る。作るのは題名と説明だけで、ノードは作ったあとの編集画面で足す。 */
function CreateMapForm({ full }: { full: boolean }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const guard = useRef(createSubmitGuard());

  const create = () => {
    // 送信中は入口で弾く（RULE-007）。
    if (guard.current.isRunning("create") || title.trim() === "") return;
    setError(undefined);
    setCreating(true);
    void guard.current
      .run("create", async () => {
        try {
          const { map } = await createLearningMap({
            title: title.trim(),
            description: description.trim(),
          });
          await navigate({ to: "/maps/$mapId/edit", params: { mapId: map.id } });
        } catch (value: unknown) {
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setError(
            value instanceof MapLimitError
              ? `マップは ${String(MAP_LIMITS.maps)} 個までです。使っていないマップを消してから作ってください。`
              : value instanceof MapInputError
                ? `入力を受け付けられませんでした（${value.message}）。`
                : toErrorText(value),
          );
        }
      })
      .finally(() => setCreating(false));
  };

  return (
    <form
      className="map-create"
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <h2>マップを作る</h2>
      <label>
        題名
        <input
          value={title}
          maxLength={MAP_LIMITS.title}
          required
          disabled={creating || full}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        説明（任意）
        <textarea
          value={description}
          maxLength={MAP_LIMITS.description}
          rows={2}
          disabled={creating || full}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <button type="submit" disabled={creating || full || title.trim() === ""}>
        {creating ? "作成中…" : "作ってノードを足す"}
      </button>
      {full && (
        <p className="muted">
          マップは {MAP_LIMITS.maps} 個までです。使っていないマップを消すと作れます。
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * 範囲が「全員」の共有マップ（#244 の T5）。新しく上げた順。作成者の名前は出さない。
 * 評価・検索はスコープ外（#244）。
 */
function SharedMapList({
  shared,
}: {
  shared: { maps: readonly SharedMapSummary[] } | { error: string };
}) {
  if ("error" in shared) {
    return (
      <section>
        <h2>みんなの共有マップ</h2>
        <p className="error-text" role="alert">
          共有マップの一覧を読めませんでした：{shared.error}
        </p>
      </section>
    );
  }
  const { maps } = shared;
  return (
    <section>
      <h2>みんなの共有マップ</h2>
      {maps.length === 0 ? (
        <p className="hint">まだ全員に共有されたマップはありません。</p>
      ) : (
        <ul className="map-list">
          {maps.map((map) => (
            <li key={map.id} className="map-list-item">
              <Link to="/maps/$mapId" params={{ mapId: map.id }} className="map-list-link">
                <h3>{map.title}</h3>
                {map.description && <p className="muted">{map.description}</p>}
                <p className="muted">
                  {map.nodeCount} ノード・版 {map.version}・
                  {new Date(map.publishedAt).toLocaleDateString("ja-JP")}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 自分が手で作った学習マップの一覧（Issue #242）。マップは最初は作成者だけのもの。
 * 作成・表示への導線・削除を持つ。下に、全員に共有されたマップの一覧を出す（#244）。
 */
function MapList() {
  const { maps, shared } = Route.useLoaderData();
  const router = useRouter();
  const [deleting, setDeleting] = useState<string>();
  const [deleteError, setDeleteError] = useState<string>();
  const submitGuard = useRef(createSubmitGuard());

  const remove = (mapId: string, title: string) => {
    // 送信中は入口で弾く（RULE-007）。
    if (submitGuard.current.isRunning(mapId)) return;
    if (
      !window.confirm(
        `「${title}」を削除します。ノード・「理解すること」と、そのノードで作った確認問題も消えます。` +
          "学習の記録は残ります。",
      )
    )
      return;
    setDeleteError(undefined);
    setDeleting(mapId);
    void submitGuard.current
      .run(mapId, async () => {
        try {
          await deleteLearningMap(mapId);
          await router.invalidate();
        } catch (error: unknown) {
          if (error instanceof ApiError && error.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          // 削除の失敗を黙って飲み込まない（RULE-004）。
          setDeleteError(toErrorText(error));
        }
      })
      .finally(() => setDeleting(undefined));
  };

  return (
    <>
      <p className="map-head">
        <Link to="/" className="link">
          ← 項目一覧
        </Link>
        <h1>自分のマップ</h1>
        <span className="muted">
          {maps.length} / {MAP_LIMITS.maps}
        </span>
      </p>
      {deleteError && (
        <section className="message error">
          <p>マップの削除に失敗しました：{deleteError}</p>
        </section>
      )}
      <p>
        <Link to="/maps/generate" className="link">
          AI でマップを作る
        </Link>
        <span className="muted">
          （テーマや目標から、ノードと「理解すること」をまとめて作ります）
        </span>
      </p>
      <CreateMapForm full={maps.length >= MAP_LIMITS.maps} />
      {maps.length === 0 ? (
        <p className="hint">まだマップがありません。</p>
      ) : (
        <ul className="map-list">
          {maps.map((map) => (
            <li key={map.id} className="map-list-item">
              <Link to="/maps/$mapId" params={{ mapId: map.id }} className="map-list-link">
                <h2>{map.title}</h2>
                {map.description && <p className="muted">{map.description}</p>}
                <p className="muted">
                  {map.nodeCount} ノード・更新 {new Date(map.updatedAt).toLocaleDateString("ja-JP")}
                  {map.visibility !== "private" && `・${VISIBILITY_BADGES[map.visibility]}`}
                  {map.source !== null && `・「${map.source.title}」から取り込み`}
                </p>
                {hasSourceUpdate(map.source) && (
                  <p>
                    <strong>更新あり</strong>（版 {map.source?.latestVersion}）
                  </p>
                )}
              </Link>
              <button
                className="link danger"
                disabled={deleting === map.id}
                onClick={() => remove(map.id, map.title)}
              >
                {deleting === map.id ? "削除中…" : "削除"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <SharedMapList shared={shared} />
    </>
  );
}

export const Route = createFileRoute("/_framed/maps/")({
  // 作成・削除のあとに戻ってきたとき、古い一覧を見せない。
  staleTime: 0,
  // 自分のマップと共有マップの一覧は1つの結果にまとめる（RULE-005）。共有マップの一覧が
  // 読めなくても、自分のマップの作成・削除は使えるようにする。失敗はその場所に出す（握りつぶさない）。
  loader: async () => {
    const retry = takeLoginRetry();
    const [{ maps }, shared] = await Promise.all([
      fetchLearningMaps(fetch, retry),
      fetchSharedMaps(fetch, retry).catch((error: unknown) => {
        // セッション切れは画面全体の扱い（ログインへ送る）に任せる。
        if (error instanceof ApiError && error.kind === "session_expired") throw error;
        return { error: toErrorText(error) };
      }),
    ]);
    return { maps, shared };
  },
  component: MapList,
});
