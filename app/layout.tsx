import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";

import { AppShell } from "@/components/layout/app-shell";
import { ErrorToastProvider } from "@/components/notifications/error-toast";
import { clerkServerConfigured } from "@/lib/auth/config";

import "./globals.css";

export const metadata: Metadata = {
  title: "Nody",
  description: "Cloud-synced rich text workspace with AI editing.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const content = (
    <html lang="en">
      <body>
        <ErrorToastProvider>
          <AppShell>{children}</AppShell>
        </ErrorToastProvider>
      </body>
    </html>
  );

  return (
    clerkServerConfigured ? <ClerkProvider>{content}</ClerkProvider> : content
  );
}
