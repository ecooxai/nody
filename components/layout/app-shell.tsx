"use client";

import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import { clerkConfigured } from "@/lib/auth/config";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isWorkspaceRoute = pathname.startsWith("/workspace");

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#fff9ee,white_55%,#e7efe8)] text-ink">
      {isWorkspaceRoute ? null : (
        <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-5 sm:px-6">
          <Link className="font-display text-3xl font-semibold tracking-tight" href="/">
            Nody
          </Link>
          <div className="flex items-center gap-3">
            <Link className="hidden text-sm text-ink/70 sm:block" href="/workspace">
              Workspace
            </Link>
            {clerkConfigured ? (
              <>
                <SignedOut>
                  <SignInButton mode="modal">
                    <Button type="button">Sign in</Button>
                  </SignInButton>
                </SignedOut>
                <SignedIn>
                  <UserButton />
                </SignedIn>
              </>
            ) : (
              <div className="rounded-full bg-white px-3 py-2 text-xs text-ink/60">Set Clerk env keys to enable auth</div>
            )}
          </div>
        </header>
      )}
      <main className={isWorkspaceRoute ? "w-full px-0 pb-0" : "mx-auto w-full max-w-7xl px-4 pb-10 sm:px-6"}>{children}</main>
    </div>
  );
}
