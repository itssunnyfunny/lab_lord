import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/components/legal/LegalPage";
import { absoluteUrl, siteConfig } from "@/lib/site";

const sections: LegalSection[] = [
  {
    title: "Contact Lab Lords",
    items: [
      `Brand: ${siteConfig.name}`,
      `Support email: ${siteConfig.supportEmail}`,
      `Business and operational address: ${siteConfig.businessAddress}`,
      "Expected response time: within one business day.",
    ],
  },
  {
    title: "Billing and refund requests",
    body: "Email support with your organization name, account email, Razorpay payment ID, charge date and amount, and a description of the billing or access issue. Refund requests are handled under the Cancellation and Refund Policy.",
  },
  {
    title: "Product support and bug reports",
    body: "For product issues, include the affected page, what you expected, what happened, the approximate time, browser details, and screenshots. The dedicated /support page can prepare a structured bug-report email.",
  },
];

export const metadata: Metadata = {
  title: "Contact Us",
  description: "Contact Lab Lords for account, billing, refund, privacy, product, or operational support.",
  alternates: { canonical: absoluteUrl("/contact") },
};

export default function ContactPage() {
  return (
    <LegalPage
      eyebrow="Contact"
      title="Contact Us"
      description="Reach Lab Lords for account, billing, refund, privacy, or product support."
      sections={sections}
    />
  );
}
