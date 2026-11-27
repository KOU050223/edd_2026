const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const renderInline = (source: string): string => {
  const escaped = escapeHtml(source);
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^)]+)\)/g, '<a href="$2">$1</a>');
};

const isBlockStart = (line: string): boolean => /^(#{1,3}\s|[-*]\s|\d+\.\s|```)/.test(line);

// AI の応答は信頼できない入力なので、HTML は常に文字列としてエスケープする。
// 対応範囲を会話で使うMarkdownに絞り、静的なElectron画面でも依存なく表示する。
export const renderMarkdown = (source: string): string => {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: string[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line === undefined || !line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith("```")) {
        const codeLine = lines[index];
        if (codeLine !== undefined) code.push(codeLine);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const className = language ? ` class="language-${escapeHtml(language)}"` : "";
      blocks.push(`<pre><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const pattern = unordered ? /^[-*]\s+(.+)$/ : /^\d+\.\s+(.+)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]?.match(pattern);
        if (!item || item[1] === undefined) break;
        items.push(`<li>${renderInline(item[1])}</li>`);
        index += 1;
      }
      blocks.push(unordered ? `<ul>${items.join("")}</ul>` : `<ol>${items.join("")}</ol>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = lines[index];
      if (next === undefined || !next.trim() || isBlockStart(next)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraph.join("\n")).replaceAll("\n", "<br>")}</p>`);
  }

  return blocks.join("\n");
};
