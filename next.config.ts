import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const securityHeaders = [
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const privateRouteSources = [
  "/account/:path*",
  "/api/:path*",
  "/app/:path*",
  "/branch/:path*",
  "/invite/:path*",
  "/onboarding/:path*",
  "/org/:path*",
  "/sign-in/:path*",
  "/sign-up/:path*",
];

export const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      ...privateRouteSources.map(source => ({
        source,
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow",
          },
        ],
      })),
    ];
  },
};

export default withWorkflow(nextConfig);
