import { SignUp } from "@clerk/nextjs";

import { Panel } from "@/components/ui/panel";
import { clerkServerConfigured } from "@/lib/auth/config";

export default function SignUpPage() {
  if (!clerkServerConfigured) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <Panel>Configure Clerk keys in `.env.local` to enable email, Google, and Apple sign-up.</Panel>
      </div>
    );
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <SignUp />
    </div>
  );
}
