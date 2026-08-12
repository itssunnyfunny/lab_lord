import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { AnalyticsProvider } from "@/components/analytics/AnalyticsProvider";
import { getGoogleAnalyticsBootstrapScript } from "@/lib/tracking";
import { absoluteUrl, siteConfig } from "@/lib/site";
import { clerkRouting } from "@/lib/clerkRouting";
import { Geist_Mono, Inter, Manrope } from "next/font/google";
import Script from "next/script";
import { Suspense } from "react";
import { clerkAppAppearance } from "@/components/ui/entrySurface";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  applicationName: siteConfig.name,
  title: {
    default: siteConfig.homeTitle,
    template: "%s | Lab Lords",
  },
  description: siteConfig.description,
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  alternates: {
    canonical: absoluteUrl("/"),
  },
  keywords: [
    "education ERP",
    "branch management",
    "seat allocation",
    "fee tracking",
    "student management",
  ],
  openGraph: {
    type: "website",
    url: absoluteUrl("/"),
    siteName: siteConfig.name,
    title: siteConfig.homeTitle,
    description: siteConfig.description,
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "Lab Lords - Study Hall & Library Management Software",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.homeTitle,
    description: siteConfig.description,
    images: ["/twitter-image.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/icon.png", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

  return (
    <html lang="en" className="dark">
      <head>
        {measurementId && (
          <Script
            id="google-analytics-consent-default"
            strategy="beforeInteractive"
            dangerouslySetInnerHTML={{
              __html: getGoogleAnalyticsBootstrapScript(measurementId),
            }}
          />
        )}
      </head>
      <body
        className={`${inter.variable} ${manrope.variable} ${geistMono.variable} antialiased`}
      >
        <ClerkProvider
          appearance={clerkAppAppearance}
          signInUrl={clerkRouting.signInUrl}
          signUpUrl={clerkRouting.signUpUrl}
          signInFallbackRedirectUrl="/app"
          signUpFallbackRedirectUrl="/app"
          afterSignOutUrl="/"
        >
          {children}
        </ClerkProvider>
        {measurementId && (
          <Script
            id="google-analytics"
            src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
            strategy="afterInteractive"
          />
        )}
        <Suspense fallback={null}>
          <AnalyticsProvider measurementId={measurementId} />
        </Suspense>
      </body>
    </html>
  );
}
