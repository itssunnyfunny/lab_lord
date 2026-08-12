import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, isProtectedRoute } from "@/proxy";
import { clerkRouting } from "@/lib/clerkRouting";

describe("proxy matcher", () => {
  it("keeps protected-route authentication on the local themed entry routes", () => {
    expect(clerkRouting).toEqual({
      signInUrl: "/sign-in",
      signUpUrl: "/sign-up",
    });
  });

  it.each([
    "https://lablords.in/sitemap.xml",
    "https://lablords.in/robots.txt",
    "https://lablords.in/favicon.ico",
    "https://lablords.in/icon.png",
    "https://lablords.in/apple-icon.png",
    "https://lablords.in/opengraph-image.png",
    "https://lablords.in/twitter-image.png",
    "https://lablords.in/feed.xml",
    "https://lablords.in/security.txt",
    "https://lablords.in/nested/catalog.xml?version=1",
    "https://lablords.in/nested/readme.txt?version=1",
  ])("does not run Clerk for public metadata route %s", url => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });

  it.each([
    "https://lablords.in/account",
    "https://lablords.in/account/preferences",
    "https://lablords.in/app",
    "https://lablords.in/app/open",
    "https://lablords.in/branch",
    "https://lablords.in/branch/example",
    "https://lablords.in/branch/example/payments",
    "https://lablords.in/org",
    "https://lablords.in/org/example",
    "https://lablords.in/org/example/settings",
    "https://lablords.in/onboarding",
  ])("runs Clerk and requires authentication for private route %s", url => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    expect(isProtectedRoute(new NextRequest(url))).toBe(true);
  });

  it.each([
    "https://lablords.in/",
    "https://lablords.in/privacy",
    "https://lablords.in/terms",
    "https://lablords.in/refund-policy",
    "https://lablords.in/shipping-delivery-policy",
    "https://lablords.in/contact",
    "https://lablords.in/cookies",
    "https://lablords.in/support",
    "https://lablords.in/software/study-hall-management",
    "https://lablords.in/software/library-management",
    "https://lablords.in/software/seat-management",
    "https://lablords.in/software/student-fee-management",
    "https://lablords.in/software/fee-reminder",
    "https://lablords.in/software/coaching-management",
    "https://lablords.in/software/tuition-management",
    "https://lablords.in/invite",
    "https://lablords.in/invite/example-token",
  ])("keeps public page %s accessible without authentication", url => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    expect(isProtectedRoute(new NextRequest(url))).toBe(false);
  });

  it.each([
    "https://lablords.in/api/example",
    "https://lablords.in/api/branches/example",
    "https://lablords.in/trpc/example",
  ])("continues running Clerk for API route %s", url => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
  });

  it("keeps the signed Razorpay webhook outside Clerk authentication", () => {
    const request = new NextRequest("https://lablords.in/api/razorpay/webhook");

    expect(unstable_doesMiddlewareMatch({ config, url: request.url })).toBe(true);
    expect(isProtectedRoute(request)).toBe(false);
  });
});
