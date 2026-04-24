import { describe, expect, it } from "vitest";

import {
  findLineStartOffset,
  getLineSourceRange,
  getSelectedLineText,
  sameLineNumberList,
  updateSelectedLineNumbers,
} from "@/lib/editor/line-selection";

describe("findLineStartOffset", () => {
  it("finds the start offset for each line", () => {
    const value = "line 1\nline 2\nline 3";

    expect(findLineStartOffset(value, 1)).toBe(0);
    expect(findLineStartOffset(value, 2)).toBe(7);
    expect(findLineStartOffset(value, 3)).toBe(14);
  });

  it("returns the end of the note for out-of-range lines", () => {
    expect(findLineStartOffset("line 1", 99)).toBe(6);
  });
});

describe("getLineSourceRange", () => {
  it("returns the text for a populated line", () => {
    expect(getLineSourceRange("line 1\nline 2\n", 2)).toEqual({
      end: 13,
      start: 7,
      text: "line 2",
    });
  });

  it("keeps blank lines selectable", () => {
    expect(getLineSourceRange("line 1\n\nline 3", 2)).toEqual({
      end: 7,
      start: 7,
      text: "",
    });
  });
});

describe("updateSelectedLineNumbers", () => {
  it("toggles individual lines while keeping note order", () => {
    expect(updateSelectedLineNumbers([3, 1], 2, "toggle")).toEqual([1, 2, 3]);
    expect(updateSelectedLineNumbers([1, 2, 3], 2, "toggle")).toEqual([1, 3]);
  });

  it("replaces the current selection on double click behavior", () => {
    expect(updateSelectedLineNumbers([1, 3], 2, "replace")).toEqual([2]);
  });
});

describe("getSelectedLineText", () => {
  it("joins selected lines in note order without duplicates", () => {
    expect(getSelectedLineText("line 1\nline 2\nline 3", [3, 1, 3])).toBe("line 1\nline 3");
  });
});

describe("sameLineNumberList", () => {
  it("matches only identical ordered selections", () => {
    expect(sameLineNumberList([1, 3], [1, 3])).toBe(true);
    expect(sameLineNumberList([1, 3], [3, 1])).toBe(false);
  });
});
