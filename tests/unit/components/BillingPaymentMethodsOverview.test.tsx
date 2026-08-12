import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillingPaymentMethodsOverview } from "@/components/billing/BillingPaymentMethodsOverview";

describe("BillingPaymentMethodsOverview", () => {
  it("explains provider-managed multi-method checkout without promising eligibility", () => {
    const html = renderToStaticMarkup(
      <BillingPaymentMethodsOverview
        availability={{
          mode: "PROVIDER_MANAGED",
          potentialMethods: ["CARD", "UPI", "EMANDATE"],
          providerControlsVisibility: true,
        }}
        currentMethod="UPI"
      />
    );

    expect(html).toContain("Choose securely in Razorpay Checkout");
    expect(html).toContain("Card");
    expect(html).toContain("UPI AutoPay");
    expect(html).toContain("eMandate");
    expect(html).toContain("Razorpay decides");
    expect(html).toContain("Current recurring method");
    expect(html).toContain("provider-confirmed mandate");
  });

  it("makes card-only rollout state explicit", () => {
    const html = renderToStaticMarkup(<BillingPaymentMethodsOverview />);

    expect(html).toContain("Card checkout is currently active");
    expect(html).toContain("Card-only mode");
    expect(html).toContain("UPI AutoPay");
    expect(html).toContain("eMandate");
    expect(html.match(/Not enabled/g)).toHaveLength(2);
  });
});
