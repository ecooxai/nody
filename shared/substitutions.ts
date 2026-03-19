import type { TextSubstitution } from "./types";

export function applySubstitutions(source: string, edits: TextSubstitution[]): string {
  return edits.reduce((output, edit) => {
    if (!edit.find) return output;
    if (edit.all) return output.split(edit.find).join(edit.replace);
    return output.replace(edit.find, edit.replace);
  }, source);
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
