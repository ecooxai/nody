import { SignUp } from "@clerk/nextjs";

import { Panel } from "@/components/ui/panel";
import { clerkClientConfigured } from "@/lib/auth/config";

export default function SignUpPage() {
  if (!clerkClientConfigured) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <Panel>Configure Clerk keys in `.env.dev` or `.env.deploy` to enable email, Google, and Apple sign-up.</Panel>
      </div>
    );
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <SignUp />
    </div>
  );
}
