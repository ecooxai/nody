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
  const portOrigins = [process.env.PORT, process.env.NEXT_PORT]
    .filter((port): port is string => Boolean(port))
    .flatMap((port) => [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const configuredOrigins = (process.env.NEXT_SERVER_ACTIONS_ALLOWED_ORIGINS ?? "")
    .split(/[\s,]+/)
    .map(normalizeServerActionOrigin)
    .filter((origin): origin is string => Boolean(origin));
  const deploymentOrigins = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.APP_URL,
    process.env.CF_PAGES_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
  ]
    .map((origin) => (origin ? normalizeServerActionOrigin(origin) : null))
    .filter((origin): origin is string => Boolean(origin));

  return Array.from(
    new Set([
      "localhost:3000",
      "127.0.0.1:3000",
      "[::1]:3000",
      "localhost:3333",
      "127.0.0.1:3333",
      "[::1]:3333",
      "nody.ecooxai.workers.dev",
      "*.workers.dev",
      "**.workers.dev",
      "*.pages.dev",
      "**.pages.dev",
      ...portOrigins,
      ...deploymentOrigins,
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
