"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

type ErrorNotice = { code: string; message: string };
type ErrorContextValue = { pushError: (message: string) => void };

const ErrorContext = createContext<ErrorContextValue | null>(null);

export function ErrorToastProvider({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<ErrorNotice | null>(null);

  const pushError = useCallback((message: string) => {
    const code = `ERR-${Date.now().toString(36).toUpperCase()}`;
    setNotice({ code, message });
    window.setTimeout(() => setNotice(null), 10000);
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
    await navigator.clipboard.writeText(`${notice.code}: ${notice.message}`);
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
