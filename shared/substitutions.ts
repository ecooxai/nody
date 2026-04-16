import type { TextSubstitution } from "./types";

export type TextSubstitutionReplayStep = TextSubstitution & {
  occurrenceCount: number;
  start: number;
  end: number;
};

export type TextSubstitutionReplay = {
  next: string;
  steps: TextSubstitutionReplayStep[];
  unapplied: TextSubstitution[];
};

export function applySubstitutions(source: string, edits: TextSubstitution[]): string {
  return edits.reduce((output, edit) => {
    if (!edit.find) return output;
    if (edit.all) return output.split(edit.find).join(edit.replace);
    return output.replace(edit.find, edit.replace);
  }, source);
}

export function buildSubstitutionReplay(source: string, edits: TextSubstitution[]): TextSubstitutionReplay {
  let output = source;
  const steps: TextSubstitutionReplayStep[] = [];
  const unapplied: TextSubstitution[] = [];

  for (const edit of edits) {
    if (!edit.find) {
      unapplied.push(edit);
      continue;
    }

    const firstIndex = output.indexOf(edit.find);
    if (firstIndex < 0) {
      unapplied.push(edit);
      continue;
    }

    if (edit.all) {
      const segments = output.split(edit.find);
      const occurrenceCount = Math.max(segments.length - 1, 0);
      steps.push({
        ...edit,
        occurrenceCount,
        start: firstIndex,
        end: firstIndex + edit.find.length,
      });
      output = segments.join(edit.replace);
      continue;
    }

    steps.push({
      ...edit,
      occurrenceCount: 1,
      start: firstIndex,
      end: firstIndex + edit.find.length,
    });
    output = `${output.slice(0, firstIndex)}${edit.replace}${output.slice(firstIndex + edit.find.length)}`;
  }

  return {
    next: output,
    steps,
    unapplied,
  };
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
