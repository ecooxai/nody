"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import type { AIMessage, TextSubstitution } from "@/shared/types";

export function AIChatPanel({
  messages,
  busy,
  onAsk,
  onApply,
  selectedText,
}: {
  messages: AIMessage[];
  busy: boolean;
  onAsk: (prompt: string) => Promise<void>;
  onApply: (edits: TextSubstitution[]) => void;
  selectedText?: string;
}) {
  const [prompt, setPrompt] = useState("");
  const [promptFocused, setPromptFocused] = useState(false);
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const edits = parseEdits(latestAssistant?.content ?? "");

  useEffect(() => {
    if (!selectedText) return;
    setPrompt(`\n\n${selectedText}\n\n`);
  }, [selectedText]);

  return (
    <Panel className="flex h-[400px] w-full flex-col overflow-hidden border-0 p-0 shadow-none">
      <textarea
        className="w-full resize-none rounded-[4px] border border-pine/40 px-4 py-3 text-sm leading-6 transition-[height] duration-200 ease-out"
        onBlur={() => setPromptFocused(false)}
        onChange={(event) => setPrompt(event.target.value)}
        onFocus={() => setPromptFocused(true)}
        placeholder="Send the whole document, ask questions, or apply text substitutions."
        style={{ height: promptFocused ? 200 : 100 }}
        value={prompt}
      />
      <div className="mt-3 flex flex-wrap gap-2 px-0">
        <button
          aria-label="Ask"
          className="flex h-10 w-10 items-center justify-center rounded-[4px] bg-ember text-ink transition hover:bg-ember/90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || !prompt.trim()}
          onClick={async () => {
            await onAsk(prompt);
            setPrompt("");
          }}
          type="button"
        >
          {busy ? (
            <span className="text-[10px] font-medium uppercase tracking-[0.18em]">...</span>
          ) : (
            <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
              <path
                d="M5 12h12M13 6l6 6-6 6"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
              />
            </svg>
          )}
        </button>
        <Button disabled={edits.length === 0} onClick={() => onApply(edits)} type="button">
          Apply
        </Button>
      </div>
      <div className="mt-4 min-h-0 flex-1 overflow-auto rounded-[4px] bg-mist/80">
        <div className="flex flex-col gap-3">
          {messages.map((message) => (
            <div
              className={`max-w-[92%] rounded-[4px] px-3 py-2 text-sm ${message.role === "assistant" ? "bg-white" : "self-end bg-ink text-white"}`}
              key={message.id}
            >
              {message.content}
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function parseEdits(content: string): TextSubstitution[] {
  const match = content.match(/```json([\s\S]*?)```/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1].trim()) as { substitutions?: TextSubstitution[] };
    return parsed.substitutions ?? [];
  } catch {
    return [];
  }
}
