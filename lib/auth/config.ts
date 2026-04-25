const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const clerkSecretKey = process.env.CLERK_SECRET_KEY;
const clerkDevKeysAllowed =
  process.env.NEXT_PUBLIC_ALLOW_CLERK_DEV_KEYS === "true" || process.env.ALLOW_CLERK_DEV_KEYS === "true";

function isAllowedClerkKey(key: string | undefined, testPrefix: string) {
  if (!key) return false;
  if (clerkDevKeysAllowed) return true;
  return !key.startsWith(testPrefix);
}

export const clerkClientConfigured = isAllowedClerkKey(clerkPublishableKey, "pk_test_");

export const clerkServerConfigured = clerkClientConfigured && isAllowedClerkKey(clerkSecretKey, "sk_test_");

export const localModeUserId = "local-dev-user";
