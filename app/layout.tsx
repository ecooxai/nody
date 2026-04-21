import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";

import { AppShell } from "@/components/layout/app-shell";
import { ErrorToastProvider } from "@/components/notifications/error-toast";
import { clerkClientConfigured } from "@/lib/auth/config";

import "./globals.css";

export const metadata: Metadata = {
  title: "Nody",
  description: "Cloud-synced rich text workspace with AI editing.",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {clerkClientConfigured ? (
          <ClerkProvider>
            <ErrorToastProvider>
              <AppShell>{children}</AppShell>
            </ErrorToastProvider>
          </ClerkProvider>
        ) : (
          <ErrorToastProvider>
            <AppShell>{children}</AppShell>
          </ErrorToastProvider>
        )}
      </body>
    </html>
  );
}
