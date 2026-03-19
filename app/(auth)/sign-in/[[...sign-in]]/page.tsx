import { SignIn } from "@clerk/nextjs";

import { Panel } from "@/components/ui/panel";
import { clerkConfigured } from "@/lib/auth/config";

export default function SignInPage() {
  if (!clerkConfigured) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <Panel>Configure Clerk keys in `.env.local` to enable email, Google, and Apple sign-in.</Panel>
      </div>
    );
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <SignIn />
    </div>
  );
}
