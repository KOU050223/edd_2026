/**
 * 「読む範囲」（Issue #322 の改①）。フォルダを選ぶと、その場で「何を・どれだけ読むか」が変わる。
 * 件数・合計の判断は `repo-maps.ts` の `scopeSummary`（テストあり）に置き、ここは描画だけを持つ。
 */

import { scopeSummary, type InspectRepoResult } from "./repo-maps.js";

export function ScopePanel({
  inspected,
  folders,
  hintFiles,
}: {
  inspected: InspectRepoResult;
  folders: ReadonlySet<string>;
  hintFiles: readonly string[];
}) {
  const scope = scopeSummary(inspected, folders, hintFiles);
  if (scope.rows.length === 0) return null;
  const readingCount = scope.rows.filter((r) => r.reading).length;
  const max = Math.max(1, ...scope.rows.map((r) => (r.stat ? r.stat.doc + r.stat.code : 0)));
  return (
    <section className="scope-panel" aria-label="読む範囲" aria-live="polite">
      <h3>読む範囲</h3>
      <p className="scope-summary">
        ファイル {inspected.scan.blobTotal} 件のうち、
        {scope.readsAll ? <b>全体を読みます</b> : <b>読むのは {readingCount} つのフォルダ</b>}
        {scope.totals !== null && (
          <>
            （文書 {scope.totals.doc}・コード {scope.totals.code}
            {scope.totals.schema > 0 && `・データの形 ${String(scope.totals.schema)}`}）
          </>
        )}
        です。
      </p>
      <ul>
        {scope.rows.map((row) => (
          <li key={row.path} className={row.reading ? "reading" : "skipped"}>
            <div className="scope-row-head">
              <b>{row.path}</b>
              <span className={`scope-badge${row.reading ? " on" : ""}`}>
                {row.reading ? (row.shared ? "読む（共有）" : "読む") : "読まない"}
              </span>
            </div>
            {row.stat !== null && (
              <>
                {row.reading && (
                  <div className="scope-bar" aria-hidden="true">
                    <span
                      className="doc"
                      style={{ width: `${String((row.stat.doc / max) * 100)}%` }}
                    />
                    <span
                      className="code"
                      style={{ width: `${String((row.stat.code / max) * 100)}%` }}
                    />
                  </div>
                )}
                <p className="muted">
                  {row.reading ? "" : "選ばなかったので読みません（"}
                  文書 {row.stat.doc}・コード {row.stat.code}
                  {row.stat.schema > 0 && `・データの形 ${String(row.stat.schema)}`}
                  {row.reading && row.pinned > 0 && ` ／ ★ 参考ファイル ${String(row.pinned)} 件`}
                  {row.reading ? "" : "）"}
                </p>
              </>
            )}
          </li>
        ))}
      </ul>
      {scope.outsidePinned > 0 && (
        <p className="muted">
          選んだフォルダの外の参考ファイル {scope.outsidePinned} 件も、指定したので読みます。
        </p>
      )}
      <p className="muted scope-legend">
        <span className="swatch doc" />
        文書 <span className="swatch code" />
        コード
      </p>
    </section>
  );
}
