"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { providerDefaults } from "@/lib/providers/defaults";
import type { ProviderName, ProviderSettings } from "@/shared/types";

export function ProviderSettingsForm({
  initialValue,
  onSave,
}: {
  initialValue: ProviderSettings;
  onSave: (value: ProviderSettings) => Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  const updateProvider = (provider: ProviderName) => {
    setValue({
      provider,
      apiUrl: providerDefaults[provider].apiUrl,
      apiKey: value.apiKey,
      model: providerDefaults[provider].model,
      liveModel: providerDefaults[provider].liveModel,
      imageModel: providerDefaults[provider].imageModel,
    });
  };

  return (
    <Panel>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">AI Provider</h2>
          <p className="text-sm text-ink/60">Choose OpenAI or Gemini and store per-user model settings.</p>
        </div>
        <div className="rounded-full bg-mist px-3 py-1 text-xs font-medium uppercase tracking-[0.2em]">Secure UI</div>
      </div>
      <div className="mt-4 grid gap-3">
        <label className="grid gap-1 text-sm">
          <span>Provider</span>
          <select
            className="rounded-2xl border border-ink/10 bg-white px-3 py-2"
            onChange={(event) => updateProvider(event.target.value as ProviderName)}
            value={value.provider}
          >
            <option value="openai">OpenAI</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>API URL</span>
          <input
            className="rounded-2xl border border-ink/10 px-3 py-2"
            onChange={(event) => setValue({ ...value, apiUrl: event.target.value })}
            value={value.apiUrl}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>API key</span>
          <input
            className="rounded-2xl border border-ink/10 px-3 py-2"
            onChange={(event) => setValue({ ...value, apiKey: event.target.value })}
            type="password"
            value={value.apiKey}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Model</span>
          <input
            className="rounded-2xl border border-ink/10 px-3 py-2"
            onChange={(event) => setValue({ ...value, model: event.target.value })}
            value={value.model}
          />
        </label>
        {value.provider === "gemini" ? (
          <>
            <label className="grid gap-1 text-sm">
              <span>Live model</span>
              <input
                className="rounded-2xl border border-ink/10 px-3 py-2"
                onChange={(event) => setValue({ ...value, liveModel: event.target.value })}
                value={value.liveModel}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span>Image model</span>
              <input
                className="rounded-2xl border border-ink/10 px-3 py-2"
                onChange={(event) => setValue({ ...value, imageModel: event.target.value })}
                value={value.imageModel}
              />
            </label>
          </>
        ) : null}
      </div>
      <Button
        className="mt-4 !bg-ink !text-white hover:!bg-ink/90"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await onSave(value);
          } finally {
            setSaving(false);
          }
        }}
        type="button"
      >
        {saving ? "Saving..." : "Save provider settings"}
      </Button>
    </Panel>
  );
}
