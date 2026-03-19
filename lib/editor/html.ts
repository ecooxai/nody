export function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function createStarterDocument() {
  return "<h1>Untitled note</h1><p>Start writing here. Ask AI to summarize, rewrite, or patch selected passages.</p>";
}
