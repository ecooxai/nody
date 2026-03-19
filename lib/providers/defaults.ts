import type { ProviderName, ProviderSettings } from "@/shared/types";

export const providerDefaults: Record<ProviderName, { apiUrl: string; model: string }> = {
  openai: {
    apiUrl: "https://api.openai.com",
    model: "gpt-4.1-mini",
  },
  gemini: {
    apiUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-flash",
  },
};

export function createDefaultSettings(): ProviderSettings {
  return {
    provider: "openai",
    apiUrl: providerDefaults.openai.apiUrl,
    apiKey: "",
    model: providerDefaults.openai.model,
  };
}
