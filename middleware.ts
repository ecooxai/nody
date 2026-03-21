import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { clerkServerConfigured } from "@/lib/auth/config";

const isProtectedRoute = createRouteMatcher(["/api/proxy(.*)"]);

const middleware = clerkServerConfigured
  ? clerkMiddleware(async (auth, request) => {
      if (isProtectedRoute(request)) {
        await auth.protect();
      }
    })
  : (() => NextResponse.next());

export default middleware;

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/", "/(api|trpc)(.*)"],
};
