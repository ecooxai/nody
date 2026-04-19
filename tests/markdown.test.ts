import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createStarterMarkdown, ensureTrailingNewlines, markdownToHtml, normalizeStoredMarkdown } from "@/lib/editor/markdown";
import { noteTemplateFallbacks } from "@/lib/templates/notes";

function readPublicTemplate(name: keyof typeof noteTemplateFallbacks) {
  return fs.readFileSync(path.resolve("public", "template", `${name}.md`), "utf8").replace(/\r\n?/g, "\n").trim();
}

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
      "<p>First line</p>\n<br />\n<p>Second line</p>\n<br />\n<br />\n<p>Third line</p>",
    );
  });
});

describe("ensureTrailingNewlines", () => {
  it("adds enough newlines to reach the requested bottom padding", () => {
    expect(ensureTrailingNewlines("First line")).toBe(`First line${"\n".repeat(10)}`);
    expect(ensureTrailingNewlines("First line\n\n")).toBe(`First line${"\n".repeat(10)}`);
  });

  it("leaves content that already has enough trailing newlines unchanged", () => {
    const value = `First line${"\n".repeat(11)}`;
    expect(ensureTrailingNewlines(value)).toBe(value);
  });

  it("normalizes line endings before counting trailing newlines", () => {
    expect(ensureTrailingNewlines("First line\r\n")).toBe(`First line${"\n".repeat(10)}`);
  });
});

describe("starter note templates", () => {
  it("uses a short untitled starter without a title heading", () => {
    const starter = createStarterMarkdown();

    expect(starter).toBe(noteTemplateFallbacks.untitled);
    expect(starter).not.toContain("Untitled");
    expect(starter).not.toMatch(/^#/m);
    expect(starter.split("\n")).toHaveLength(3);
  });

  it("keeps public markdown templates aligned with code fallbacks", () => {
    expect(readPublicTemplate("untitled")).toBe(noteTemplateFallbacks.untitled);
    expect(readPublicTemplate("welcome")).toBe(noteTemplateFallbacks.welcome);
  });
});
