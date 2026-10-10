import { createFileRoute, useRouter, Link } from "@tanstack/react-router";
import { HistoryQuestionBrowser } from "../../history-question-browser.js";
import { useEffect, useRef, useState } from "react";
import { createSubmitGuard, deleteJson, requestJson } from "../../api.js";
import { historyUserId, openHistoryStore } from "../../history-store.js";
import { historyQuestions, historyQuestionCount, HISTORY_LIMITS } from "../../local-history.js";
import { importHistoryFiles, type SelectedHistoryFile } from "../../history-import.js";

interface DirectoryHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<
    DirectoryHandle | { kind: "file"; name: string; getFile(): Promise<File> }
  >;
  requestPermission(options: { mode: "read" }): Promise<string>;
}
async function directoryFiles(
  handle: DirectoryHandle,
  path = handle.name,
  signal?: AbortSignal,
  files: SelectedHistoryFile[] = [],
): Promise<SelectedHistoryFile[]> {
  for await (const entry of handle.values()) {
    signal?.throwIfAborted();
    if (entry.kind === "directory") {
      // Subagent transcripts are not the learner's own questions.
      if (entry.name !== "subagents")
        await directoryFiles(entry, `${path}/${entry.name}`, signal, files);
    } else if (entry.name.endsWith(".jsonl")) {
      if (files.length >= HISTORY_LIMITS.files)
        throw new Error("履歴ファイル数が上限を超えています");
      files.push({ file: await entry.getFile(), relativePath: `${path}/${entry.name}` });
    }
  }
  return files;
}

function LocalHistoryPage() {
  const { userId, files, sessions } = Route.useLoaderData();
  const router = useRouter();
  const guard = useRef(createSubmitGuard());
  const abort = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const run = (operation: () => Promise<void>) => {
    if (guard.current.isRunning("history")) return;
    setRunning(true);
    setError("");
    void guard.current.run("history", async () => {
      try {
        await operation();
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        setRunning(false);
        try {
          await router.invalidate();
        } catch (value) {
          setError(
            `表示を更新できませんでした：${value instanceof Error ? value.message : String(value)}`,
          );
        }
      }
    });
  };
  const importFiles = async (selected: SelectedHistoryFile[]) => {
    if ((await historyUserId()) !== userId)
      throw new Error("アカウントが変わりました。画面を開き直してください");
    abort.current ??= new AbortController();
    const store = await openHistoryStore(userId);
    try {
      const result = await importHistoryFiles(selected, store, abort.current.signal, setMessage);
      const count = historyQuestionCount(historyQuestions(await store.files()));
      setMessage(
        `${count} 件の質問を取り込みました。更新 ${result.updated} ファイル、変更なし ${result.unchanged} ファイル。下の一覧で内容を確認できます。`,
      );
    } finally {
      store.close();
      abort.current = null;
    }
  };
  const pick = (reuse: boolean) =>
    run(async () => {
      const picker = (window as unknown as { showDirectoryPicker?: () => Promise<DirectoryHandle> })
        .showDirectoryPicker;
      if (!picker) {
        input.current?.click();
        return;
      }
      const store = await openHistoryStore(userId);
      try {
        const saved = reuse
          ? await store.loadProgress<{ key: string; handle: DirectoryHandle }>("directory")
          : undefined;
        const handle = saved?.handle ?? (await picker());
        if (saved && (await handle.requestPermission({ mode: "read" })) !== "granted")
          throw new Error("フォルダへの権限がありません。「フォルダを選ぶ」で再選択してください");
        await store.saveProgress({ key: "directory", handle } as { key: string });
        abort.current = new AbortController();
        await importFiles(await directoryFiles(handle, handle.name, abort.current.signal));
      } finally {
        abort.current = null;
        store.close();
      }
    });
  const remove = (project?: string) =>
    run(async () => {
      if ((await historyUserId()) !== userId)
        throw new Error("アカウントが変わりました。画面を開き直してください");
      const store = await openHistoryStore(userId);
      try {
        await store.deleteProject(project);
        setMessage("ローカル履歴と再開データを削除しました。反映済みの観測は残ります");
      } finally {
        store.close();
      }
    });
  const questions = historyQuestions(files);
  const projects = [...new Set(files.map((file) => file.project))];
  return (
    <section className="local-history-page">
      <h1>Claude Code の履歴管理</h1>
      <p>
        Claude Code
        であなたが尋ねた質問・相談・作業依頼を取り込みます。まず内容を確認し、次にマップを選んで関連する概念を探します。
      </p>
      <ol className="history-steps">
        <li>フォルダを選ぶ</li>
        <li>取り込んだ質問を確認</li>
        <li>マップを選んで反映</li>
      </ol>
      <p>
        履歴フォルダ（通常は ~/.claude/projects またはその配下）を選びます。Git
        のフォルダとは別です。選択した範囲だけを読み取ります。
      </p>
      <p>
        Windows はフォルダ選択のアドレス欄に %USERPROFILE%\.claude\projects を入力。macOS は ⌘⇧G で
        ~/.claude/projects を入力します。
      </p>
      <p>
        前処理済みの質問は、このブラウザ・このサイト・このアカウントの IndexedDB
        に保存します。別端末やサイトデータ削除後は再取り込みが必要です。更新は手動です。
      </p>
      <p>
        Chrome / Edge
        のフォルダ選択を優先し、利用できなければフォルダ入力を使います。入力も利用できないブラウザでは
        Chrome / Edge を使ってください。上限は100 MiB・2000ファイル・20000解析素材、1ファイル20
        MiBです。
      </p>
      <div className="actions">
        <button disabled={running} onClick={() => pick(false)}>
          フォルダを選ぶ
        </button>
        <button disabled={running} onClick={() => pick(true)}>
          履歴を更新
        </button>
        <button disabled={!running} onClick={() => abort.current?.abort()}>
          キャンセル
        </button>
        <button disabled={running || !files.length} onClick={() => remove()}>
          ローカル履歴を全件削除
        </button>
      </div>
      <input
        hidden
        type="file"
        multiple
        ref={input}
        {...{ webkitdirectory: "" }}
        onChange={(event) => {
          const selected = [...(event.currentTarget.files ?? [])]
            .filter((file) => !file.webkitRelativePath.includes("/subagents/"))
            .map((file) => ({ file, relativePath: file.webkitRelativePath }));
          event.currentTarget.value = "";
          run(() => importFiles(selected));
        }}
      />
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <p>
        {historyQuestionCount(questions)} 件の質問・{projects.length} プロジェクトを収集しました。
        AI
        の回答・ツール出力・中断通知は質問に含めません。概念への分類は、反映先のマップを選んだ後に行います。
      </p>
      {!files.length && (
        <p>保存済みの履歴がありません。初回・削除後はフォルダを取り込んでください。</p>
      )}
      {!!questions.length && (
        <div className="history-result">
          <strong>質問を確認したら、反映先を選んでください。</strong>
          <p>
            <Link to="/">マップ一覧から反映先を選ぶ →</Link>
          </p>
        </div>
      )}
      <h2>プロジェクト別の取り込み結果</h2>
      <div className="history-projects">
        {projects.map((project) => (
          <article className="history-question-card" key={project}>
            {project}：
            {historyQuestionCount(questions.filter((question) => question.project === project))}{" "}
            質問{" "}
            <button disabled={running} onClick={() => remove(project)}>
              このプロジェクトのローカル履歴を削除
            </button>
          </article>
        ))}
      </div>
      <HistoryQuestionBrowser questions={questions} />
      <details>
        <summary>
          前処理・読み飛ばしの理由（{files.reduce((sum, file) => sum + file.warnings.length, 0)}{" "}
          件）
        </summary>
        {files.flatMap((file) =>
          file.warnings.map((warning, index) => (
            <p key={`${file.key}:${index}`}>
              {file.project}：{warning}
            </p>
          )),
        )}
      </details>
      <h2>マップへの反映履歴</h2>
      <p>
        マップの「取り込んだ質問を確認する」から関連する概念を探して反映できます。
        取り消しは、その反映で追加した分だけを消します。同じ Concept ID
        を参照するほかのマップからも消えます。
      </p>
      {sessions.sessions.map((session) => (
        <p key={session.id}>
          {new Date(session.createdAt).toLocaleString("ja-JP")}：質問 {session.evidenceCount} 件（
          {session.status === "applied" ? "反映済み" : "取り消し済み"}）{" "}
          <button
            disabled={running || session.status !== "applied"}
            onClick={() =>
              run(async () => {
                await deleteJson(`/api/v1/import-sessions/${encodeURIComponent(session.id)}`);
                setMessage("この反映を取り消しました");
              })
            }
          >
            この反映を取り消す
          </button>
        </p>
      ))}
    </section>
  );
}

export const Route = createFileRoute("/_framed/local-history")({
  staleTime: 0,
  loader: async () => {
    const userId = await historyUserId();
    const store = await openHistoryStore(userId);
    try {
      const [files, sessions] = await Promise.all([
        store.files(),
        requestJson<{
          sessions: { id: string; status: string; createdAt: string; evidenceCount: number }[];
        }>("/api/v1/import-sessions"),
      ]);
      return { userId, files, sessions };
    } finally {
      store.close();
    }
  },
  component: LocalHistoryPage,
});
