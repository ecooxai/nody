const MEDIA_PLACEHOLDER_PREFIX = "__NODY_MEDIA_BLOCK_";
const UNDERLINE_PLACEHOLDER_PREFIX = "__NODY_UNDERLINE_";

function normalizeNewlines(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function shouldConvertLegacyHtml(value: string) {
  return /^<(?:h[1-6]|p|div|blockquote|ul|ol)\b/i.test(value);
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttribute(value: string) {
  return escapeHtml(value);
}

function preserveMediaBlocks(value: string) {
  const blocks: string[] = [];
  let next = normalizeNewlines(value);

  next = next.replace(/<figure\b[\s\S]*?<\/figure>/gi, (match) => {
    const id = `${MEDIA_PLACEHOLDER_PREFIX}${blocks.length}__`;
    blocks.push(sanitizeAllowedHtml(match.trim()));
    return `\n${id}\n`;
  });

  next = next.replace(/<(audio|video)\b[\s\S]*?<\/\1>/gi, (match) => {
    const id = `${MEDIA_PLACEHOLDER_PREFIX}${blocks.length}__`;
    blocks.push(sanitizeAllowedHtml(match.trim()));
    return `\n${id}\n`;
  });

  next = next.replace(/<img\b[^>]*\/?>/gi, (match) => {
    const id = `${MEDIA_PLACEHOLDER_PREFIX}${blocks.length}__`;
    blocks.push(sanitizeAllowedHtml(match.trim()));
    return `\n${id}\n`;
  });

  return { text: next, blocks };
}

function restorePlaceholders(value: string, blocks: string[]) {
  return blocks.reduce(
    (result, block, index) => result.replaceAll(`${MEDIA_PLACEHOLDER_PREFIX}${index}__`, block),
    value,
  );
}

function sanitizeAllowedHtml(value: string) {
  return value
    .replace(/\son\w+=(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/\sstyle=(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "");
}

function convertInlineHtmlToMarkdown(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, (_, __, inner: string) => `**${convertInlineHtmlToMarkdown(inner).trim()}**`)
      .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, (_, __, inner: string) => `*${convertInlineHtmlToMarkdown(inner).trim()}*`)
      .replace(/<u>([\s\S]*?)<\/u>/gi, (_, inner: string) => `<u>${convertInlineHtmlToMarkdown(inner).trim()}</u>`)
      .replace(/<code>([\s\S]*?)<\/code>/gi, (_, inner: string) => `\`${decodeHtmlEntities(inner.trim())}\``)
      .replace(/<a\b[^>]*href=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_, hrefA: string, hrefB: string, inner: string) => {
        const href = hrefA || hrefB || "";
        return `[${convertInlineHtmlToMarkdown(inner).trim()}](${href.trim()})`;
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?(span|mark|small)\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, ""),
  );
}

export function htmlToMarkdown(value: string) {
  const { text, blocks } = preserveMediaBlocks(value);

  const markdown = text
    .replace(/<h1>([\s\S]*?)<\/h1>/gi, (_, inner: string) => `# ${convertInlineHtmlToMarkdown(inner).trim()}\n\n`)
    .replace(/<h2>([\s\S]*?)<\/h2>/gi, (_, inner: string) => `## ${convertInlineHtmlToMarkdown(inner).trim()}\n\n`)
      .replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_, inner: string) =>
      `${convertInlineHtmlToMarkdown(inner)
        .split("\n")
        .map((line: string) => `> ${line.trim()}`)
        .join("\n")}\n\n`,
    )
    .replace(/<(ul|ol)>([\s\S]*?)<\/\1>/gi, (_, __, inner: string) => {
      const items = Array.from(inner.matchAll(/<li>([\s\S]*?)<\/li>/gi)).map((match) => `- ${convertInlineHtmlToMarkdown(match[1]).trim()}`);
      return items.length > 0 ? `${items.join("\n")}\n\n` : "";
    })
    .replace(/<(p|div)>([\s\S]*?)<\/\1>/gi, (_, __, inner: string) => `${convertInlineHtmlToMarkdown(inner).trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return restorePlaceholders(markdown, blocks).trim();
}

function preserveUnderlineTags(value: string) {
  const parts: string[] = [];
  const text = value.replace(/<u>([\s\S]*?)<\/u>/gi, (match) => {
    const id = `${UNDERLINE_PLACEHOLDER_PREFIX}${parts.length}__`;
    parts.push(match);
    return id;
  });
  return { text, parts };
}

function restoreUnderlineTags(value: string, parts: string[]) {
  return parts.reduce(
    (result, part, index) => result.replaceAll(`${UNDERLINE_PLACEHOLDER_PREFIX}${index}__`, part),
    value,
  );
}

function inlineMarkdownToHtml(value: string) {
  const { text, parts } = preserveUnderlineTags(value);
  const escaped = escapeHtml(text);

  return restoreUnderlineTags(
    escaped
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, (_, alt: string, url: string, title?: string) => {
        const safeUrl = escapeAttribute(url);
        const safeAlt = escapeAttribute(alt);
        const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : "";
        return `<img class="markdown-inline-image" src="${safeUrl}" alt="${safeAlt}"${titleAttribute} />`;
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
        const safeUrl = escapeAttribute(url);
        return `<a href="${safeUrl}" rel="noreferrer" target="_blank">${label}</a>`;
      })
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>"),
    parts,
  );
}

function renderBlock(block: string) {
  const trimmed = block.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith(MEDIA_PLACEHOLDER_PREFIX)) {
    return trimmed;
  }

  const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    return `<h${level}>${inlineMarkdownToHtml(heading[2].trim())}</h${level}>`;
  }

  const lines = trimmed.split("\n");
  if (lines.every((line) => /^[-*+]\s+/.test(line.trim()))) {
    const items = lines
      .map((line) => line.trim().replace(/^[-*+]\s+/, ""))
      .map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  if (lines.every((line) => /^>\s?/.test(line.trim()))) {
    const content = lines.map((line) => line.trim().replace(/^>\s?/, "")).join("\n");
    return `<blockquote><p>${inlineMarkdownToHtml(content).replace(/\n/g, "<br />")}</p></blockquote>`;
  }

  return `<p>${inlineMarkdownToHtml(trimmed).replace(/\n/g, "<br />")}</p>`;
}

function renderNewlineSeparator(separator: string) {
  return Array.from({ length: Math.max(separator.length - 1, 0) }, () => "<br />").join("\n");
}

export function markdownToHtml(value: string) {
  const normalized = normalizeStoredMarkdown(value);
  const { text, blocks } = preserveMediaBlocks(normalized);
  const html = text
    .split(/(\n{2,})/)
    .map((part) => (/^\n+$/.test(part) ? renderNewlineSeparator(part) : renderBlock(part)))
    .filter(Boolean)
    .join("\n");

  return restorePlaceholders(html, blocks);
}

export function stripMarkdown(value: string) {
  return normalizeStoredMarkdown(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, " $1 ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, " $1 ")
    .replace(/^[#>\-*\s]+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeStoredMarkdown(value: string) {
  const normalized = normalizeNewlines(value ?? "");
  const trimmed = normalized.trim();
  if (!trimmed) return "";
  if (!shouldConvertLegacyHtml(trimmed)) return normalized;
  return htmlToMarkdown(trimmed);
}

export function ensureTrailingNewlines(value: string, count = 10) {
  const normalized = normalizeNewlines(value ?? "");
  const targetCount = Math.max(0, count);
  const existingCount = normalized.match(/\n*$/)?.[0].length ?? 0;
  if (existingCount >= targetCount) return normalized;
  return `${normalized}${"\n".repeat(targetCount - existingCount)}`;
}

export function createStarterMarkdown() {
  return "# Untitled note\n\nStart writing here. Ask AI to summarize, rewrite, or patch selected passages.";
}
