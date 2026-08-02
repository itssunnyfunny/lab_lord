import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ContactPage from "@/app/contact/page";
import RefundPolicyPage from "@/app/refund-policy/page";
import ShippingDeliveryPolicyPage from "@/app/shipping-delivery-policy/page";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import { LandingFooter } from "@/components/landing/LandingFooter";

describe("Razorpay public review pages", () => {
  it("renders concrete cancellation and refund terms", () => {
    const html = renderToStaticMarkup(<RefundPolicyPage />);

    expect(html).toContain("Cancellation and Refund Policy");
    expect(html).toContain("7 calendar days");
    expect(html).toContain("business days after approval");
    expect(html).toContain("end of the current paid billing period");
  });

  it("renders digital delivery timing and delayed-activation instructions", () => {
    const html = renderToStaticMarkup(<ShippingDeliveryPolicyPage />);

    expect(html).toContain("do not sell or ship physical products");
    expect(html).toContain("up to 15 minutes");
    expect(html).toContain("Razorpay payment ID");
  });

  it("renders public business contact details", () => {
    const html = renderToStaticMarkup(<ContactPage />);

    expect(html).toContain("Contact Us");
    expect(html).toContain("Business and operational address");
    expect(html).toContain("within one business day");
  });

  it("links every required policy from the public footer", () => {
    const html = renderToStaticMarkup(<LandingFooter />);

    for (const path of ["/privacy", "/terms", "/refund-policy", "/shipping-delivery-policy", "/contact"]) {
      expect(html).toContain(`href="${path}"`);
    }
  });

  it("indexes and allows the public review routes", () => {
    const sitemapUrls = sitemap().map(entry => entry.url);
    const publicPaths = ["/refund-policy", "/shipping-delivery-policy", "/contact"];
    const allow = robots().rules;
    const serializedRules = JSON.stringify(allow);

    for (const path of publicPaths) {
      expect(sitemapUrls.some(url => url.endsWith(path))).toBe(true);
      expect(serializedRules).toContain(path);
    }
  });
});
