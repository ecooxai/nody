export const DEFAULT_FOLDER_NAME = "default";
export const UNTITLED_NOTE_TITLE = "Untitled";
export const WELCOME_NOTE_TITLE = "Welcome";

export const noteTemplateFallbacks = {
  untitled: "Start with plain text, then add **bold**, lists, or quotes.\n- Keep related files in the same folder.\nAsk AI to summarize, rewrite, or patch selected text.",
  welcome: "Welcome to Nody.\n- Create folders to organize notes and uploads.\n- Select text, open AI, and ask for edits.",
} as const;

export type NoteTemplateName = keyof typeof noteTemplateFallbacks;

function normalizeTemplateMarkdown(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

export async function loadNoteTemplate(name: NoteTemplateName) {
  const fallback = noteTemplateFallbacks[name];

  try {
    const response = await fetch(`/template/${name}.md`, { cache: "no-store" });
    if (!response.ok) return fallback;

    const markdown = normalizeTemplateMarkdown(await response.text());
    return markdown || fallback;
  } catch {
    return fallback;
  }
}
