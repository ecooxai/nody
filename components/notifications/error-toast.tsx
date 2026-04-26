"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { writeBrowserClipboardText } from "@/lib/clipboard";

type ErrorNotice = { code: string; message: string };
type ErrorContextValue = { pushError: (message: string) => void };

const ErrorContext = createContext<ErrorContextValue | null>(null);

function isClipboardFocusFailure(value: unknown) {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
          ? value.message
          : "";

  return (
    message.includes("local_clipboard_read_failed") ||
    (message.includes("Clipboard") && message.includes("Document is not focused"))
  );
}

export function ErrorToastProvider({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<ErrorNotice | null>(null);

  const pushError = useCallback((message: string) => {
    if (isClipboardFocusFailure(message)) return;
    const code = `ERR-${Date.now().toString(36).toUpperCase()}`;
    setNotice({ code, message });
    window.setTimeout(() => setNotice(null), 10000);
  }, []);

  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (!isClipboardFocusFailure(event.reason)) return;
      event.preventDefault();
    };
    const handleWindowError = (event: ErrorEvent) => {
      if (!isClipboardFocusFailure(event.error ?? event.message)) return;
      event.preventDefault();
    };

    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("error", handleWindowError);
    return () => {
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      window.removeEventListener("error", handleWindowError);
    };
  }, []);

  const value = useMemo(() => ({ pushError }), [pushError]);

  return (
    <ErrorContext.Provider value={value}>
      {children}
      {notice ? <Toast notice={notice} /> : null}
    </ErrorContext.Provider>
  );
}

function Toast({ notice }: { notice: ErrorNotice }) {
  const handleCopy = async () => {
    try {
      await writeBrowserClipboardText(`${notice.code}: ${notice.message}`);
    } catch {
      // Clipboard access can fail when focus changes between click and write.
    }
  };

  return (
    <button
      className="fixed bottom-4 left-1/2 z-50 w-[min(92vw,32rem)] -translate-x-1/2 rounded-2xl border border-ember/40 bg-ink px-4 py-3 text-left text-sm text-white shadow-panel"
      onClick={handleCopy}
      type="button"
    >
      <div className="font-semibold">{notice.code}</div>
      <div className="max-h-[200px] overflow-y-auto whitespace-pre-wrap text-white/80">{notice.message}</div>
      <div className="mt-1 text-xs text-white/60">Tap to copy error details.</div>
    </button>
  );
}

export function useErrorToast() {
  const context = useContext(ErrorContext);
  if (!context) {
    throw new Error("useErrorToast must be used inside ErrorToastProvider");
  }
  return context;
}
