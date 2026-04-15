import { describe, expect, it } from "vitest";

import { createDefaultSettings, providerDefaults } from "@/lib/providers/defaults";

describe("provider defaults", () => {
  it("defaults new users to Gemini with live audio enabled", () => {
    const settings = createDefaultSettings();

    expect(settings.provider).toBe("gemini");
    expect(settings.apiUrl).toBe(providerDefaults.gemini.apiUrl);
    expect(settings.model).toBe(providerDefaults.gemini.model);
    expect(settings.liveModel).toBe(providerDefaults.gemini.liveModel);
    expect(settings.imageModel).toBe(providerDefaults.gemini.imageModel);
  });
});
