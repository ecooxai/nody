import { describe, expect, it } from "vitest";

import { applySubstitutions, safeJsonParse } from "@/shared/substitutions";
import { shouldApplyRemote } from "@/shared/sync";

describe("applySubstitutions", () => {
  it("applies single replacements", () => {
    expect(applySubstitutions("hello world", [{ find: "world", replace: "team" }])).toBe("hello team");
  });

  it("applies global replacements", () => {
    expect(applySubstitutions("a a a", [{ find: "a", replace: "b", all: true }])).toBe("b b b");
  });
});

describe("safeJsonParse", () => {
  it("returns fallback on invalid json", () => {
    expect(safeJsonParse("{", { ok: false })).toEqual({ ok: false });
  });
});

describe("shouldApplyRemote", () => {
  it("applies remote when local is clean and server is newer", () => {
    expect(shouldApplyRemote(false, 5, 3)).toBe(true);
  });

  it("does not apply remote when local has unsynced changes", () => {
    expect(shouldApplyRemote(true, 5, 3)).toBe(false);
  });
});
