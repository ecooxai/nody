import type { DocumentAsset } from "@/shared/types";
import { escapeAttribute } from "@/lib/editor/markdown";

export function assetToMarkdown(asset: DocumentAsset) {
  const safeUrl = escapeAttribute(asset.url);
  if (asset.kind === "image") {
    return `<img class="note-embedded-media note-embedded-image" src="${safeUrl}" loading="lazy" />`;
  }
  if (asset.kind === "audio") {
    return `<audio class="note-embedded-media note-embedded-audio" controls src="${safeUrl}"></audio>`;
  }
  return `<video class="note-embedded-media note-embedded-video" controls src="${safeUrl}"></video>`;
}
