export type EditorCommand =
  | "bold"
  | "italic"
  | "underline"
  | "insertUnorderedList"
  | "formatBlock:h1"
  | "formatBlock:h2"
  | "formatBlock:blockquote";

export function runEditorCommand(command: EditorCommand) {
  const [name, value] = command.split(":");
  document.execCommand(name, false, value);
}

export function insertHtml(html: string) {
  document.execCommand("insertHTML", false, html);
}
