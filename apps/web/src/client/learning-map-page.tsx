import { HistoryMapPanel } from "./history-map-panel.js";
/**
 * 学習マップ1件の画面の中身（#242・#244・#302）。`/maps/<ID>`（手元のマップ・他人の共有マップ）と
 * `/shared/<ID>`（持ち主が見る自分の共有の版）が使う。
 */

import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError, createSubmitGuard } from "./api.js";
import { toErrorText } from "./errors.js";
import {
  ConceptDetail,
  NARROW_LAYOUT,
  overlaidConcepts,
  SkillTree,
  useGoToConcept,
  useMasteryChange,
  type MapProfile,
} from "./learning-map-view.js";
import { findCurrentPosition, layoutTrees, linkConcepts, summarizeTree } from "./learning-map.js";
import {
  hasSourceUpdate,
  mapDefinitions,
  type LearningMapView,
  type MapSourceView,
} from "./learning-maps.js";
import {
  importSharedMap,
  shareConflictText,
  ShareConflictError,
  shareLinkOf,
  VISIBILITY_BADGES,
  VISIBILITY_LABELS,
  type SharedMapView,
} from "./map-sharing.js";
import {
  CreationChecksError,
  creationChecksSummary,
  generateCreationChecks,
  MAP_GENERATION_COST,
} from "./map-generation.js";
import type { MasteryOverrides } from "./overrides.js";

/**
 * AI で作ったマップの作成時の確認問題（#247）。生成の画面で作れなかったときや、
 * 途中で画面を離れたときに、ここから作れるようにする。作成済みなら何も出さない。
 */
function CreationChecksPanel({
  mapId,
  status,
}: {
  mapId: string;
  status: "pending" | "exhausted";
}) {
  const router = useRouter();
  const guard = useRef(createSubmitGuard());
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const run = () => {
    // 送信中は入口で弾く（RULE-007）。
    if (guard.current.isRunning("checks")) return;
    setError(undefined);
    setMessage(undefined);
    setRunning(true);
    void guard.current
      .run("checks", async () => {
        try {
          setMessage(creationChecksSummary(await generateCreationChecks(mapId)));
          await router.invalidate();
        } catch (value: unknown) {
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setError(value instanceof CreationChecksError ? value.detail : toErrorText(value));
          // 頼める回数が尽きたかどうかは、読み直した状態で出し分ける。
          await router.invalidate();
        }
      })
      .finally(() => setRunning(false));
  };

  if (status === "exhausted") {
    return (
      <section className="message">
        <p>
          このマップの作成時の確認問題は作れませんでした。問題は各ノードの確認問題の画面から1組ずつ作れます。
        </p>
        {error && <p className="error-text">{error}</p>}
      </section>
    );
  }
  return (
    <section className="message">
      <p>
        このマップの確認問題はまだ作っていません。手前のノードから最大 10 組を作ります（AI
        の利用回数を {MAP_GENERATION_COST} 回使います）。
      </p>
      <div className="actions">
        <button type="button" disabled={running} onClick={run}>
          {running ? "確認問題を作っています…" : "確認問題を作る"}
        </button>
      </div>
      {message && (
        <p className="message saved" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** 「リンクだけ」の共有のリンクと、写すボタン（#244 の決定 U1）。 */
function ShareLink({ mapId, shareKey }: { mapId: string; shareKey: string }) {
  const link = shareLinkOf(window.location.origin, mapId, shareKey);
  const [copied, setCopied] = useState<"done" | "failed">();
  const copy = () => {
    navigator.clipboard.writeText(link).then(
      () => setCopied("done"),
      // 写せなかったことを黙らない（RULE-004）。リンクは画面に出ているので手で写せる。
      () => setCopied("failed"),
    );
  };
  return (
    <p className="share-link">
      <span className="muted">共有のリンク（知っている人だけが開けます）:</span>
      <input readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
      <button type="button" onClick={copy}>
        リンクを写す
      </button>
      {copied === "done" && <span role="status">写しました</span>}
      {copied === "failed" && (
        <span className="error-text" role="alert">
          写せませんでした。欄から手で写してください。
        </span>
      )}
    </p>
  );
}

/**
 * 取り込んだマップの取り込み元（#244 の T3・T4）。新しい版があれば「更新あり」と、
 * 差分を見て取り込み直す画面への入口を出す。
 */
function SourceStatus({ mapId, source }: { mapId: string; source: MapSourceView }) {
  return (
    <section className="message">
      <p>
        共有マップ「{source.title}」（版 {source.version}）から取り込んだ、自分だけのマップです。
        自由に直せます。直しても元のマップは変わりません。
      </p>
      {hasSourceUpdate(source) ? (
        <p>
          <strong>更新あり</strong>（版 {source.latestVersion}）。{" "}
          <Link to="/maps/$mapId/reimport" params={{ mapId }} className="link">
            差分を見て取り込み直す
          </Link>
        </p>
      ) : (
        source.latestVersion === null && (
          <p className="muted">
            取り込み元は今は読めません（削除・共有の停止・リンクの変更）。このマップはそのまま使えます。
          </p>
        )
      )}
    </section>
  );
}

/** 持ち主以外に、共有マップを自分のマップへ取り込む入口を出す（#244 の T3）。 */
function ImportPanel({ mapId, shareKey }: { mapId: string; shareKey: string | undefined }) {
  const navigate = useNavigate();
  const guard = useRef(createSubmitGuard());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  const run = () => {
    // 送信中は入口で弾く（RULE-007）。
    if (guard.current.isRunning("import")) return;
    setError(undefined);
    setRunning(true);
    void guard.current
      .run("import", async () => {
        try {
          const { map } = await importSharedMap(mapId, shareKey);
          await navigate({ to: "/maps/$mapId", params: { mapId: map.id } });
        } catch (value: unknown) {
          if (value instanceof ApiError && value.kind === "session_expired") {
            window.location.href = "/login";
            return;
          }
          setError(
            value instanceof ShareConflictError ? shareConflictText(value) : toErrorText(value),
          );
        }
      })
      .finally(() => setRunning(false));
  };

  return (
    <div className="actions">
      <button type="button" disabled={running} onClick={run}>
        {running ? "取り込んでいます…" : "自分のマップに取り込む"}
      </button>
      <span className="muted">
        今の版を自分だけのマップとして写します。取り込んだあとに作成者が更新しても、取り込み直すまで変わりません。
      </span>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 持ち主に見せる共有の状態（#244）。共有の設定と版の履歴への入口。 */
function SharingStatus({ map }: { map: LearningMapView }) {
  return (
    <>
      <p className="share-status">
        <span>
          共有: <strong>{VISIBILITY_LABELS[map.visibility]}</strong>
          {map.latestVersion !== null && <span className="muted">（版 {map.latestVersion}）</span>}
        </span>
        <Link to="/maps/$mapId/share" params={{ mapId: map.id }} className="link">
          {map.visibility !== "private"
            ? "共有の設定・新しい版を上げる"
            : map.source !== null
              ? "別の共有マップとして公開"
              : "共有する"}
        </Link>
        {map.latestVersion !== null && map.visibility !== "private" && (
          <Link to="/shared/$mapId" params={{ mapId: map.id }} className="link">
            共有している版を見る
          </Link>
        )}
        {map.latestVersion !== null && (
          <Link to="/maps/$mapId/history" params={{ mapId: map.id }} className="link">
            版の履歴
          </Link>
        )}
      </p>
      {map.visibility === "link" && map.shareKey !== null && (
        <ShareLink mapId={map.id} shareKey={map.shareKey} />
      )}
    </>
  );
}

/** 持ち主以外に見せる、共有の側の版の説明（#244）。 */
function SharedNotice({
  map,
  shareKey: key,
  ownShareKey,
}: {
  map: SharedMapView;
  shareKey: string | undefined;
  ownShareKey: string | null;
}) {
  return (
    <section className="message">
      <p>
        共有マップ（{VISIBILITY_BADGES[map.visibility]}・版 {map.version}・
        {new Date(map.publishedAt).toLocaleDateString("ja-JP")}）を見ています。
        読むことはできますが、編集はできません。
      </p>
      {map.forkedFrom && (
        <p className="muted">
          もとにしたマップ:{" "}
          {map.forkedFrom.mapId === null ? (
            map.forkedFrom.title
          ) : (
            <Link to="/maps/$mapId" params={{ mapId: map.forkedFrom.mapId }} className="link">
              {map.forkedFrom.title}
            </Link>
          )}
        </p>
      )}
      {map.isOwner ? (
        // 持ち主は取り込まない（#302）。手元と共有の設定へ戻る入口と、渡すリンクを出す。
        <>
          <p className="share-status">
            <Link to="/maps/$mapId" params={{ mapId: map.id }} className="link">
              手元のマップへ
            </Link>
            <Link to="/maps/$mapId/share" params={{ mapId: map.id }} className="link">
              共有の設定・新しい版を上げる
            </Link>
            <Link to="/maps/$mapId/history" params={{ mapId: map.id }} className="link">
              版の履歴
            </Link>
          </p>
          {map.visibility === "link" && ownShareKey !== null && (
            <ShareLink mapId={map.id} shareKey={ownShareKey} />
          )}
        </>
      ) : (
        <ImportPanel mapId={map.id} shareKey={key} />
      )}
    </section>
  );
}

/** 画面に出すマップ。手元のマップか、共有の側の版か。 */
export type LoadedMap =
  | { kind: "own"; map: LearningMapView }
  | {
      kind: "shared";
      map: SharedMapView;
      /** 持ち主が自分の共有の版を見ているとき（#302）、ほかの人に渡す「リンクだけ」の鍵。 */
      ownShareKey?: string | null;
    };

/**
 * 学習マップ1件の表示（Issue #242）。言語別マップ（`/map/$language`）と同じ
 * `SkillTree` と詳細パネルを使う。ノードを選ぶと `onSelectInMap` が `?concept=` 付きの URL へ移る。
 *
 * 自分のマップなら手元のマップを、他人のマップなら共有の側のいちばん新しい版を出す（#244）。
 * 持ち主も「共有したマップ」（`/shared/<ID>`）から共有の側の版を見られる（#302）。
 * 共有の側の版は読むだけで、理解度の変更と確認問題の入口は出さない。
 */
export function LearningMapPage({
  mapId,
  loaded,
  profile,
  overrides,
  selectedId,
  shareKey: key,
  onSelectInMap,
}: {
  mapId: string;
  loaded: LoadedMap;
  profile: MapProfile;
  overrides: MasteryOverrides;
  selectedId: string | undefined;
  /** 「リンクだけ」の共有を持ち主以外が開いたときの鍵（#244 の U1）。取り込みに使う。 */
  shareKey: string | undefined;
  /** このマップのノードを選んだとき。画面ごとに URL が違う。 */
  onSelectInMap: (conceptId: string) => void;
}) {
  const map = loaded.map;
  const own = loaded.kind === "own" ? loaded.map : undefined;
  const ownerView = loaded.kind === "shared" && loaded.map.isOwner;
  const router = useRouter();
  const { saveError, pending, changeStatus } = useMasteryChange();
  const goToConcept = useGoToConcept();
  const detail = useRef<HTMLElement>(null);

  const defined = mapDefinitions(map);
  const conceptList = overlaidConcepts(profile, overrides, defined.concepts);
  const concepts = new Map(conceptList.map((concept) => [concept.conceptId, concept]));
  // このマップのノードだけで現在地を探す。他の領域の Concept を現在地にしない。
  const inMap = new Set(defined.concepts.map((concept) => concept.id));
  const current = findCurrentPosition(
    conceptList.filter((concept) => inMap.has(concept.conceptId)),
  );
  const links = linkConcepts(defined.concepts);
  const nextIds = current === undefined ? [] : (links.get(current)?.next ?? []);
  const next = new Set(nextIds);
  // ノードが無いマップでは木が無い。
  const tree = layoutTrees(defined.concepts)[0];
  const definitionOf = new Map(defined.concepts.map((concept) => [concept.id, concept]));
  const nodeOf = new Map(map.nodes.map((node) => [node.conceptId, node]));

  const selectedNodeId =
    selectedId !== undefined && inMap.has(selectedId)
      ? selectedId
      : current !== undefined && inMap.has(current)
        ? current
        : undefined;
  const selected = selectedNodeId === undefined ? undefined : concepts.get(selectedNodeId);
  const selectedNode = selectedNodeId === undefined ? undefined : nodeOf.get(selectedNodeId);

  // マップの中の選択は同じ画面のまま。前提・次の Concept もこのマップのノードなので、ここで選ぶ。
  const select = (conceptId: string) => {
    if (!inMap.has(conceptId)) {
      goToConcept(conceptId);
      return;
    }
    onSelectInMap(conceptId);
  };

  // 狭い画面では詳細が地図の下に回るので、選んだことが見えるところまで送る。
  const selectedConceptId = selected?.conceptId;
  useEffect(() => {
    if (selectedConceptId === undefined) return;
    if (window.matchMedia(NARROW_LAYOUT).matches)
      detail.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedConceptId]);

  const summary = tree === undefined ? undefined : summarizeTree(tree, concepts);

  // 参照のノードは、元の Concept の表示名・概要・項目をそのまま出す（このマップでは書き換えない）。
  const referenceNote = (() => {
    if (selectedNode?.kind !== "reference") return undefined;
    if (selectedNode.origin === null) {
      return "参照していた元の Concept が見つかりません。元のマップかノードが削除されています。";
    }
    return "既存の Concept を参照しています。表示名・概要・「理解すること」は元のものです。";
  })();

  return (
    <>
      <p className="map-head">
        {ownerView ? (
          <Link to="/shared" className="link">
            ← 共有したマップ
          </Link>
        ) : (
          <Link to="/maps" className="link">
            {own ? "← 自分のマップ" : "← マップの一覧"}
          </Link>
        )}
        <h1>{map.title}</h1>
        {/* 編集はノードごとではなくマップ単位（まとめて保存する）なので、そう書く。 */}
        {own && (
          <Link to="/maps/$mapId/edit" params={{ mapId }} className="link">
            マップを編集
          </Link>
        )}
      </p>
      {own && <HistoryMapPanel key={mapId} target={mapId} />}
      {map.description && <p className="muted">{map.description}</p>}
      {own ? (
        <>
          {own.source !== null && <SourceStatus mapId={mapId} source={own.source} />}
          <SharingStatus map={own} />
        </>
      ) : (
        loaded.kind === "shared" && (
          <SharedNotice map={loaded.map} shareKey={key} ownShareKey={loaded.ownShareKey ?? null} />
        )
      )}
      {own?.creationChecks !== undefined && own.creationChecks.status !== "done" && (
        <CreationChecksPanel mapId={mapId} status={own.creationChecks.status} />
      )}
      {summary && (
        <section className="summary" aria-label={`${map.title} の集計`}>
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
      )}
      {saveError && (
        <section className="message error">
          <p>理解度の保存に失敗しました：{saveError}</p>
        </section>
      )}
      {tree === undefined ? (
        own ? (
          <p className="hint">
            このマップにはまだノードがありません。
            <Link to="/maps/$mapId/edit" params={{ mapId }} className="link">
              マップを編集
            </Link>
            からノードを足してください。
          </p>
        ) : (
          <p className="hint">このマップにはノードがありません。</p>
        )
      ) : (
        <div className={selected ? "map-layout" : undefined}>
          <div className="map">
            <SkillTree
              tree={tree}
              title={map.title}
              concepts={concepts}
              current={current}
              next={next}
              selected={selected?.conceptId}
              onSelect={select}
            />
          </div>
          {selected && selectedNode && (
            <ConceptDetail
              concept={selected}
              summary={definitionOf.get(selected.conceptId)?.summary}
              objectives={defined.objectives.filter(
                (objective) => objective.conceptId === selected.conceptId,
              )}
              note={referenceNote}
              fromMapId={mapId}
              links={links.get(selected.conceptId)}
              concepts={concepts}
              isCurrent={selected.conceptId === current}
              pending={pending.includes(selected.conceptId)}
              // マップの画面はログインしないと開けない。他人のマップは読むだけなので、
              // 理解度の変更と確認問題の入口を出さない（取り込んでから使う、#244）。
              loggedIn={own !== undefined}
              onChange={(status) => changeStatus(selected.conceptId, status)}
              onSelect={select}
              panel={detail}
            />
          )}
        </div>
      )}
    </>
  );
}
