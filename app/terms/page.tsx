import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/components/legal/LegalPage";
import { absoluteUrl, siteConfig } from "@/lib/site";

const updatedAt = "May 26, 2026";

const sections: LegalSection[] = [
  {
    title: "Using Lab Lords",
    body: "Lab Lords provides software for offline education businesses to manage branches, students, seats, shifts, payments, staff permissions, imports, analytics, AI reports, and message drafts. You must use the service only for lawful business purposes and in line with these terms.",
  },
  {
    title: "Accounts and authority",
    items: [
      "You are responsible for keeping your account secure and for all activity under your account.",
      "You must have authority to create or administer an organization, branch, student record, staff account, payment record, or imported dataset.",
      "You are responsible for ensuring staff permissions are accurate and for promptly removing access when a team member should no longer use the workspace.",
    ],
  },
  {
    title: "Workspace data",
    items: [
      "You retain responsibility for the data you enter into Lab Lords.",
      "You must not upload data you do not have the right to process or share.",
      "You are responsible for verifying operational decisions, payment records, and student communications before acting on them.",
    ],
  },
  {
    title: "AI-assisted features",
    body: "AI reports, risk insights, action suggestions, and message drafts are assistive outputs. They can be incomplete or incorrect and must be reviewed by a responsible human before use.",
  },
  {
    title: "Payments and subscriptions",
    body: "Paid plans, billing cycles, and taxes are shown at purchase. Future renewals can be cancelled from organization billing settings and remain active through the current paid period. Refund eligibility is governed by the Cancellation and Refund Policy at /refund-policy, and digital service activation is described at /shipping-delivery-policy. Payment records inside the product are operational records and are not legal, tax, or accounting advice.",
  },
  {
    title: "Acceptable use",
    items: [
      "Do not attempt to bypass authentication, authorization, rate limits, or security controls.",
      "Do not misuse the service to send spam, abusive messages, misleading communications, or unlawful content.",
      "Do not reverse engineer, overload, scrape, or interfere with the service or its infrastructure.",
    ],
  },
  {
    title: "Changes and availability",
    body: "We may improve, change, suspend, or discontinue parts of the service. We aim to keep Lab Lords reliable, but no online service can be guaranteed to be uninterrupted or error-free.",
  },
  {
    title: "Contact",
    body: `For questions about these terms, contact ${siteConfig.supportEmail}.`,
  },
];

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern use of Lab Lords accounts, workspaces, data, AI-assisted features, payments, and acceptable use.",
  alternates: {
    canonical: absoluteUrl("/terms"),
  },
};

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms of Service"
      description="These terms describe the rules for using Lab Lords and the responsibilities that come with managing operational education business data."
      updatedAt={updatedAt}
      sections={sections}
    />
  );
}
