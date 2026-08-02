import type { MetadataRoute } from "next";
import { absoluteUrl, siteConfig } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          "/",
          "/software/",
          "/privacy",
          "/terms",
          "/refund-policy",
          "/shipping-delivery-policy",
          "/contact",
          "/cookies",
          "/support",
        ],
        disallow: [
          "/account",
          "/app",
          "/api",
          "/branch",
          "/invite",
          "/onboarding",
          "/org",
          "/sign-in",
          "/sign-up",
        ],
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: siteConfig.url,
  };
}
