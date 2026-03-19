"use client";

import { Button } from "@/components/ui/button";

export function MediaActions({
  busy,
  onUpload,
}: {
  busy: boolean;
  onUpload: (kind: "image" | "audio" | "video", file: File) => Promise<void>;
}) {
  const pick = async (kind: "image" | "audio" | "video") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = kind === "image" ? "image/*" : kind === "audio" ? "audio/*" : "video/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) await onUpload(kind, file);
    };
    input.click();
  };

  return (
    <details className="relative">
      <summary className="list-none">
        <Button disabled={busy} type="button">
          Add media
        </Button>
      </summary>
      <div className="absolute right-0 top-12 z-20 grid min-w-44 gap-2 rounded-3xl border border-ink/10 bg-white p-3 shadow-panel">
        <Button onClick={() => void pick("image")} type="button">
          Insert image
        </Button>
        <Button onClick={() => void pick("audio")} type="button">
          Insert audio
        </Button>
        <Button onClick={() => void pick("video")} type="button">
          Insert video
        </Button>
      </div>
    </details>
  );
}
