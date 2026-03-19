import type { DocumentAsset } from "@/shared/types";

function escapeAttribute(value: string) {
  return value.replaceAll('"', "&quot;");
}

export function assetToMarkup(asset: DocumentAsset) {
  const safeUrl = escapeAttribute(asset.url);
  const safeName = escapeAttribute(asset.fileName);
  if (asset.kind === "image") {
    return `<figure class="media-card"><img src="${safeUrl}" alt="${safeName}" /><figcaption>${safeName}</figcaption></figure>`;
  }
  if (asset.kind === "audio") {
    return `<figure class="media-card"><audio controls src="${safeUrl}"></audio><figcaption>${safeName}</figcaption></figure>`;
  }
  return `<figure class="media-card"><video controls src="${safeUrl}"></video><figcaption>${safeName}</figcaption></figure>`;
}
