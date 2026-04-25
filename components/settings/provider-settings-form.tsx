"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { defaultLiveRecordingSettings, providerDefaults } from "@/lib/providers/defaults";
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
    const liveRecording = { ...defaultLiveRecordingSettings, ...(value.liveRecording ?? {}) };
    setValue({
      provider,
      apiUrl: providerDefaults[provider].apiUrl,
      apiKey: value.apiKey,
      model: providerDefaults[provider].model,
      liveModel: providerDefaults[provider].liveModel,
      imageModel: providerDefaults[provider].imageModel,
      liveRecording,
    });
  };
  const liveRecording = { ...defaultLiveRecordingSettings, ...(value.liveRecording ?? {}) };

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
                placeholder="gemini-3.1-flash-image-preview"
                value={value.imageModel}
              />
              <span className="text-xs text-ink/55">
                Gemini image generation is wired to this field. Examples: `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`.
              </span>
            </label>
          </>
        ) : null}
        <div className="mt-2 grid gap-3 border-t border-ink/10 pt-4">
          <div>
            <h3 className="text-sm font-semibold">Live recording</h3>
            <p className="text-xs text-ink/55">
              Stored only on this device. Gemini Live receives mono PCM16 audio at 16 kHz with browser audio processing off by default.
            </p>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-[10px] border border-ink/10 bg-white px-3 py-2 text-sm">
            <span>Echo cancellation</span>
            <input
              checked={liveRecording.echoCancellation}
              className="h-4 w-4"
              onChange={(event) =>
                setValue({
                  ...value,
                  liveRecording: { ...liveRecording, echoCancellation: event.target.checked },
                })
              }
              type="checkbox"
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-[10px] border border-ink/10 bg-white px-3 py-2 text-sm">
            <span>Noise reduction</span>
            <input
              checked={liveRecording.noiseSuppression}
              className="h-4 w-4"
              onChange={(event) =>
                setValue({
                  ...value,
                  liveRecording: { ...liveRecording, noiseSuppression: event.target.checked },
                })
              }
              type="checkbox"
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-[10px] border border-ink/10 bg-white px-3 py-2 text-sm">
            <span>Auto gain</span>
            <input
              checked={liveRecording.autoGainControl}
              className="h-4 w-4"
              onChange={(event) =>
                setValue({
                  ...value,
                  liveRecording: { ...liveRecording, autoGainControl: event.target.checked },
                })
              }
              type="checkbox"
            />
          </label>
          <label className="grid gap-1 rounded-[10px] border border-ink/10 bg-white px-3 py-2 text-sm">
            <span>Recording gain</span>
            <select
              className="rounded-[8px] border border-ink/10 bg-white px-3 py-2"
              onChange={(event) =>
                setValue({
                  ...value,
                  liveRecording: { ...liveRecording, recordingGain: Number(event.target.value) },
                })
              }
              value={liveRecording.recordingGain}
            >
              <option value={1}>Off</option>
              <option value={2}>2x</option>
              <option value={3}>3x</option>
              <option value={4}>4x</option>
            </select>
          </label>
          <label className="grid gap-1 rounded-[10px] border border-ink/10 bg-white px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span>Standby live listening</span>
              <input
                checked={liveRecording.standbyEnabled}
                className="h-4 w-4"
                onChange={(event) =>
                  setValue({
                    ...value,
                    liveRecording: { ...liveRecording, standbyEnabled: event.target.checked },
                  })
                }
                type="checkbox"
              />
            </div>
            <span className="text-xs text-ink/55">
              When enabled, live talk falls back to standby after 20 seconds with no AI reply, keeps listening locally, and reconnects after about 2 seconds of speech that rises above the background level.
            </span>
          </label>
        </div>
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
