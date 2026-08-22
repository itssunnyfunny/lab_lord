import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { clerkRouting } from "@/lib/clerkRouting";

export const isProtectedRoute = createRouteMatcher([
  "/account(.*)",
  "/app(.*)",
  "/branch(.*)",
  "/onboarding(.*)",
  "/org(.*)",
]);

const clerkAuthMiddleware = clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
}, clerkRouting);

export function proxy(req: NextRequest, event: NextFetchEvent) {
  return clerkAuthMiddleware(req, event);
}

export const config = {
  matcher: [
    "/((?!_next|.well-known/workflow/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|xml|txt|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
