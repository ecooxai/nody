export function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function createStarterDocument() {
  return "<p>Start with plain text, then add <strong>bold</strong>, lists, or quotes.</p><ul><li>Keep related files in the same folder.</li></ul><p>Ask AI to summarize, rewrite, or patch selected text.</p>";
}
