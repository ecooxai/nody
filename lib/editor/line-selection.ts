export type LineSourceRange = {
  end: number;
  start: number;
  text: string;
};

function normalizeLineNumber(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function normalizeLineNumbers(lineNumbers: number[]) {
  return Array.from(new Set(lineNumbers.map(normalizeLineNumber))).sort((left, right) => left - right);
}

export function sameLineNumberList(left: number[], right: number[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function findLineStartOffset(value: string, lineNumber: number) {
  const targetLine = normalizeLineNumber(lineNumber);
  if (targetLine <= 1) return 0;

  let line = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\n") continue;
    line += 1;
    if (line === targetLine) {
      return index + 1;
    }
  }

  return value.length;
}

export function getLineSourceRange(value: string, lineNumber: number): LineSourceRange {
  const start = findLineStartOffset(value, lineNumber);
  const endIndex = value.indexOf("\n", start);
  const end = endIndex >= 0 ? endIndex : value.length;
  return {
    end,
    start,
    text: value.slice(start, end),
  };
}

export function getSelectedLineText(value: string, lineNumbers: number[]) {
  return normalizeLineNumbers(lineNumbers)
    .map((lineNumber) => getLineSourceRange(value, lineNumber).text)
    .join("\n");
}

export function updateSelectedLineNumbers(current: number[], lineNumber: number, mode: "replace" | "toggle") {
  const nextLineNumber = normalizeLineNumber(lineNumber);
  if (mode === "replace") return [nextLineNumber];

  const next = new Set(normalizeLineNumbers(current));
  if (next.has(nextLineNumber)) {
    next.delete(nextLineNumber);
  } else {
    next.add(nextLineNumber);
  }
  return Array.from(next).sort((left, right) => left - right);
}
