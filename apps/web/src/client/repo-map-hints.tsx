/**
 * 「参考にしてほしいファイル」の入力（Issue #322）。下見で取れたファイルの一覧から選ぶか、パスを手で書く。
 * 手で書いたパスは一覧と照合し、無ければその場で知らせる（作成のあとに 400 で気づかせない）。
 */

import { useState } from "react";
import {
  checkHintFiles,
  FILE_KIND_LABELS,
  filterFileOptions,
  parseHintFiles,
  REPO_MAP_LIMITS,
  splitPath,
  type RepoMapFileOption,
} from "./repo-maps.js";

export function HintFilePicker({
  options,
  truncated,
  text,
  onChange,
  disabled,
}: {
  options: readonly RepoMapFileOption[];
  truncated: boolean;
  text: string;
  onChange: (text: string) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const chosen = parseHintFiles(text);
  const checks = checkHintFiles(
    chosen,
    options.map((o) => o.path),
    truncated || options.length === 0,
  );
  const full = chosen.length >= REPO_MAP_LIMITS.hints;
  const shown = filterFileOptions(options, query);

  const toggle = (path: string) => {
    const next = chosen.includes(path) ? chosen.filter((p) => p !== path) : [...chosen, path];
    onChange(next.join("\n"));
  };

  return (
    <div className="hint-picker">
      <label>
        参考にしてほしいファイル（任意・1 行に 1 つ・{REPO_MAP_LIMITS.hints} 個まで）
        <textarea
          rows={3}
          value={text}
          placeholder="docs/glossary.md"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <p className="muted">
        選んだもの: {chosen.length} / {REPO_MAP_LIMITS.hints}{" "}
        個。対象のフォルダの外にあるファイルも、 指定すれば入ります。
      </p>
      {checks.some((c) => c.state === "missing") && (
        <ul className="hint-problems" role="alert">
          {checks
            .filter((c) => c.state === "missing")
            .map((c) => (
              <li key={c.path} className="error-text">
                「{c.path}」はこのリポジトリに見つかりません。
                {c.suggestion !== undefined && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="link"
                      disabled={disabled}
                      onClick={() =>
                        onChange(
                          chosen.map((p) => (p === c.path ? (c.suggestion ?? p) : p)).join("\n"),
                        )
                      }
                    >
                      「{c.suggestion}」に直す
                    </button>
                  </>
                )}
              </li>
            ))}
        </ul>
      )}
      {options.length > 0 && (
        <details>
          <summary>
            ファイルの一覧から選ぶ（{options.length} 件{truncated ? "・一部のみ" : ""}）
          </summary>
          <input
            type="search"
            value={query}
            placeholder="パスの一部で絞り込む（例: concepts）"
            aria-label="ファイルを絞り込む"
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="hint-options">
            {shown.map((option) => {
              const { dir, base } = splitPath(option.path);
              const checked = chosen.includes(option.path);
              return (
                <li key={option.path}>
                  <label className="check-consent-remember">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled || (!checked && full)}
                      onChange={() => toggle(option.path)}
                    />
                    <span className="evidence-kind">{FILE_KIND_LABELS[option.kind]}</span>
                    <strong>{base}</strong>
                    {dir !== "" && <span className="muted">{dir}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          {shown.length === 0 && <p className="muted">一致するファイルがありません。</p>}
          {truncated && (
            <p className="muted">
              一覧に出せるのは先頭の一部だけです。ここに無いファイルは、パスを手で書いてください。
            </p>
          )}
        </details>
      )}
    </div>
  );
}
