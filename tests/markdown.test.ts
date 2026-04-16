import { describe, expect, it } from "vitest";

import { markdownToHtml, normalizeStoredMarkdown } from "@/lib/editor/markdown";

describe("normalizeStoredMarkdown", () => {
  it("preserves trailing markdown newlines", () => {
    expect(normalizeStoredMarkdown("First line\n")).toBe("First line\n");
    expect(normalizeStoredMarkdown("First line\n\n")).toBe("First line\n\n");
  });

  it("preserves markdown newlines when the note contains inline html", () => {
    expect(normalizeStoredMarkdown("First line <u>underlined</u>\n\n")).toBe("First line <u>underlined</u>\n\n");
  });

  it("preserves markdown newlines when the note contains media tags", () => {
    expect(normalizeStoredMarkdown('First line\n\n<img class="note-embedded-image" src="/image.png" />\n\n')).toBe(
      'First line\n\n<img class="note-embedded-image" src="/image.png" />\n\n',
    );
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

describe("markdownToHtml", () => {
  it("renders single newlines as line breaks in view mode", () => {
    expect(markdownToHtml("First line\nSecond line")).toBe("<p>First line<br />Second line</p>");
  });

  it("renders blank markdown lines as visible line breaks in view mode", () => {
    expect(markdownToHtml("First line\n\nSecond line\n\n\nThird line")).toBe(
      "<p>First line</p>\n<br />\n<br />\n<p>Second line</p>\n<br />\n<br />\n<br />\n<p>Third line</p>",
    );
  });
});
