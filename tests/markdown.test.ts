import { describe, expect, it } from "vitest";

import { normalizeStoredMarkdown } from "@/lib/editor/markdown";

describe("normalizeStoredMarkdown", () => {
  it("preserves trailing markdown newlines", () => {
    expect(normalizeStoredMarkdown("First line\n")).toBe("First line\n");
    expect(normalizeStoredMarkdown("First line\n\n")).toBe("First line\n\n");
  });

  it("normalizes markdown line endings without trimming content", () => {
    expect(normalizeStoredMarkdown(" First line\r\nSecond line\r\n")).toBe(" First line\nSecond line\n");
  });

  it("keeps whitespace-only notes empty", () => {
    expect(normalizeStoredMarkdown(" \n\t ")).toBe("");
  });

  it("converts legacy html notes to markdown", () => {
    expect(normalizeStoredMarkdown("<h1>Title</h1><p>Body</p>")).toBe("# Title\n\nBody");
  });
});
