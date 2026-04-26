export function canUseBrowserClipboard() {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

export async function writeBrowserClipboardText(text: string) {
  if (!canUseBrowserClipboard() || !navigator.clipboard?.writeText) {
    return false;
  }

  await navigator.clipboard.writeText(text);
  return true;
}
