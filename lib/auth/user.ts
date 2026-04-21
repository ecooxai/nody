import "server-only";

import { createClerkClient } from "@clerk/nextjs/server";

import { clerkServerConfigured, localModeUserId } from "@/lib/auth/config";

export async function getEffectiveUserId(request: Request) {
  if (!clerkServerConfigured) return localModeUserId;

  try {
    const client = createClerkClient({
      publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    const requestState = await client.authenticateRequest(request, { acceptsToken: "session_token" });
    if (!requestState.isAuthenticated) return localModeUserId;
    return requestState.toAuth().userId ?? localModeUserId;
  } catch {
    return localModeUserId;
  }
}
