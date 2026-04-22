import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

function normalizeServerActionOrigin(origin: string) {
  const trimmed = origin.trim();
  if (!trimmed) return null;
  if (trimmed.includes("*")) {
    return trimmed.replace(/^https?:\/\//, "").split("/")[0] || null;
  }

  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).host;
  } catch {
    return trimmed.replace(/^https?:\/\//, "").split("/")[0] || null;
  }
}

function readServerActionAllowedOrigins() {
  const configuredOrigins = (process.env.NEXT_SERVER_ACTIONS_ALLOWED_ORIGINS ?? "")
    .split(/[\s,]+/)
    .map(normalizeServerActionOrigin)
    .filter((origin): origin is string => Boolean(origin));

  return Array.from(
    new Set([
      "localhost:3000",
      "127.0.0.1:3000",
      "[::1]:3000",
      "*.workers.dev",
      "**.workers.dev",
      "*.pages.dev",
      "**.pages.dev",
      ...configuredOrigins,
    ]),
  );
}

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    serverActions: {
      allowedOrigins: readServerActionAllowedOrigins(),
    },
  },
};

export default nextConfig;
