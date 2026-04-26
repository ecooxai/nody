"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { defaultLiveRecordingSettings, providerDefaults } from "@/lib/providers/defaults";
import type { ProviderName, ProviderSettings } from "@/shared/types";

const uniqueOptions = (items: string[]) => Array.from(new Set(items.filter(Boolean)));

const geminiModelOptions = uniqueOptions([
  "gemini-3.1-pro-preview",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  providerDefaults.gemini.model,
]);
const geminiLiveModelOptions = uniqueOptions([
  "gemini-3.1-flash-live-preview",
  "gemini-2.5-flash-native-audio-preview-12-2025",
  providerDefaults.gemini.liveModel,
]);
const geminiImageModelOptions = uniqueOptions([
  "gemini-3-pro-image-preview",
  "gemini-2.5-flash-image",
  providerDefaults.gemini.imageModel,
]);

function ModelInput({
  label,
  onChange,
  options,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  value: string;
}) {
  const [focused, setFocused] = useState(false);
  const showOptions = focused && value.trim() === "" && options.length > 0;

  return (
    <label className="relative grid gap-1 text-sm">
      <span>{label}</span>
      <input
        className="rounded-2xl border border-ink/10 px-3 py-2"
        onBlur={() => setFocused(false)}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        placeholder={placeholder}
        value={value}
      />
      {showOptions ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 grid gap-1 rounded-[12px] border border-ink/10 bg-white p-1 shadow-[0_14px_30px_rgba(15,23,42,0.12)]">
          {options.map((option) => (
            <button
              className="truncate rounded-[8px] px-3 py-2 text-left text-xs text-ink transition hover:bg-mist"
              key={option}
              onClick={() => {
                onChange(option);
                setFocused(false);
              }}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </label>
  );
}

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
      liveApiKey: value.liveApiKey ?? "",
      liveModel: providerDefaults[provider].liveModel,
      imageApiKey: value.imageApiKey ?? "",
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
        <ModelInput
          label="Model"
          onChange={(model) => setValue({ ...value, model })}
          options={value.provider === "gemini" ? geminiModelOptions : []}
          value={value.model}
        />
        {value.provider === "gemini" ? (
          <>
            <ModelInput
              label="Live model"
              onChange={(liveModel) => setValue({ ...value, liveModel })}
              options={geminiLiveModelOptions}
              value={value.liveModel}
            />
            <label className="grid gap-1 text-sm">
              <span>Live model API key</span>
              <input
                className="rounded-2xl border border-ink/10 px-3 py-2"
                onChange={(event) => setValue({ ...value, liveApiKey: event.target.value })}
                placeholder="Uses global API key when empty"
                type="password"
                value={value.liveApiKey ?? ""}
              />
            </label>
            <ModelInput
              label="Image model"
              onChange={(imageModel) => setValue({ ...value, imageModel })}
              options={geminiImageModelOptions}
              placeholder={providerDefaults.gemini.imageModel}
              value={value.imageModel}
            />
            <label className="grid gap-1 text-sm">
              <span>Image model API key</span>
              <input
                className="rounded-2xl border border-ink/10 px-3 py-2"
                onChange={(event) => setValue({ ...value, imageApiKey: event.target.value })}
                placeholder="Uses global API key when empty"
                type="password"
                value={value.imageApiKey ?? ""}
              />
              <span className="text-xs text-ink/55">
                Empty model-specific keys fall back to the global Gemini API key.
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
              When enabled, live talk falls back to standby after 60 seconds with no AI reply, keeps listening locally, and reconnects after about 2 seconds of speech that rises above the background level.
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
