import { useState } from "react";
import type { HistoryQuestion } from "./local-history.js";
import { questionCards } from "./history-presentation.js";

export function HistoryQuestionBrowser({
  questions,
  title = "取り込んだ質問",
}: {
  questions: readonly HistoryQuestion[];
  title?: string;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const cards = questionCards(questions).filter((card) =>
    (card.text + card.project).toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(cards.length / 8));
  const currentPage = Math.min(page, pages - 1);
  return (
    <section className="history-questions" aria-label={title}>
      <div className="history-section-head">
        <h3>{title}</h3>
        <span>{cards.length} 件</span>
      </div>
      <label className="history-search">
        質問を検索
        <input
          type="search"
          value={search}
          placeholder="キーワード・プロジェクト名"
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
      </label>
      {!cards.length && <p className="muted">該当する質問はありません。</p>}
      <div className="history-question-list">
        {cards.slice(currentPage * 8, (currentPage + 1) * 8).map((card) => (
          <article className="history-question-card" key={card.key}>
            <div className="history-question-meta">
              <span>{card.project}</span>
              <time dateTime={card.observedAt}>
                {new Date(card.observedAt).toLocaleDateString("ja-JP")}
              </time>
            </div>
            <p>
              {card.text.slice(0, 180)}
              {card.text.length > 180 ? "…" : ""}
            </p>
            {card.text.length > 180 && (
              <details>
                <summary>質問の全文を見る</summary>
                <p>{card.text}</p>
              </details>
            )}
          </article>
        ))}
      </div>
      {pages > 1 && (
        <nav className="history-pagination" aria-label="質問のページ">
          <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            前へ
          </button>
          <span>
            {currentPage + 1} / {pages}
          </span>
          <button disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>
            次へ
          </button>
        </nav>
      )}
    </section>
  );
}
