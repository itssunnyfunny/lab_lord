import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/components/legal/LegalPage";
import { absoluteUrl, siteConfig } from "@/lib/site";

const updatedAt = "August 2, 2026";

const sections: LegalSection[] = [
  {
    title: "Cancelling a subscription",
    items: [
      "Organization owners can cancel future renewal from the Billing section of organization settings.",
      "Cancellation takes effect at the end of the current paid billing period. Access continues until that date, and no further renewal charge is scheduled.",
      "A scheduled cancellation does not automatically refund fees already paid for the current billing period.",
    ],
  },
  {
    title: "When a refund may be approved",
    body: "Refunds are reviewed for duplicate payments, an incorrect amount charged by Lab Lords, or a successful payment where paid access was not provided within the stated activation period. Change-of-mind cancellations, unused time, and partial billing periods are not refundable.",
  },
  {
    title: "Request window",
    body: "Contact support within 7 calendar days of the affected transaction or access issue. Include your Lab Lords account email, organization name, Razorpay payment ID, charge date and amount, and a short explanation with supporting screenshots where available.",
  },
  {
    title: "Refund processing",
    body: "Approved refunds are returned to the original payment method within 5–7 business days after approval. Your bank or payment provider may take additional time to display the credit.",
  },
  {
    title: "Contact for billing and refunds",
    body: `Send refund and billing requests to ${siteConfig.supportEmail}. We normally respond within one business day.`,
  },
];

export const metadata: Metadata = {
  title: "Cancellation and Refund Policy",
  description: "How to cancel Lab Lords subscriptions and request review of duplicate, incorrect, or failed-access charges.",
  alternates: { canonical: absoluteUrl("/refund-policy") },
};

export default function RefundPolicyPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Cancellation and Refund Policy"
      description="This policy explains when subscription cancellation takes effect and when a payment may qualify for refund review."
      updatedAt={updatedAt}
      sections={sections}
    />
  );
}
