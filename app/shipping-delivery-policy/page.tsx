import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "@/components/legal/LegalPage";
import { absoluteUrl, siteConfig } from "@/lib/site";

const updatedAt = "August 2, 2026";

const sections: LegalSection[] = [
  {
    title: "Digital service only",
    body: "Lab Lords provides subscription-based software as a service. We do not sell or ship physical products, and no courier or physical delivery is involved.",
  },
  {
    title: "Service activation",
    body: "Paid plan access is normally activated immediately after successful payment and account verification. Allow up to 15 minutes for payment confirmation and subscription status updates.",
  },
  {
    title: "How access is delivered",
    body: "Customers use the same Lab Lords account used during checkout. The active plan appears in organization billing settings, and enabled features become available inside the organization and branch workspace. Razorpay may also send payment or invoice confirmation to the account email.",
  },
  {
    title: "Payment succeeded but access is missing",
    body: `If access is not active within 15 minutes, email ${siteConfig.supportEmail} with the organization name, Lab Lords account email, Razorpay payment ID, payment time, and a screenshot of the successful payment. We normally respond within one business day.`,
  },
];

export const metadata: Metadata = {
  title: "Shipping and Delivery Policy",
  description: "How Lab Lords digital SaaS access is activated and delivered after a successful subscription payment.",
  alternates: { canonical: absoluteUrl("/shipping-delivery-policy") },
};

export default function ShippingDeliveryPolicyPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Shipping and Delivery Policy"
      description="Lab Lords is a digital SaaS product. This policy explains activation timing, account access, and support for delayed activation."
      updatedAt={updatedAt}
      sections={sections}
    />
  );
}
