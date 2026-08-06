import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillingPriceSummary } from "@/components/billing/BillingPriceSummary";
import type { BillingExperience } from "@/types/billingExperience";

function experience(overrides: Partial<BillingExperience> = {}): BillingExperience {
  return {
    organizationId: "org_summary",
    accessMode: "FULL",
    effectivePlan: "STANDARD_TRIAL",
    selectedPostTrialPlan: "BASIC",
    providerStatus: null,
    customerState: "TRIAL_ACTIVE",
    customerMessage: "Your no-card Standard trial is active.",
    trialEndsAt: "2026-09-05T00:00:00.000Z",
    trialDaysRemaining: 30,
    paidThrough: null,
    confirmedQuantity: 0,
    projectedQuantity: 2,
    currentUnitAmount: 0,
    currentMonthlyTotal: 0,
    projectedUnitAmount: 299,
    projectedMonthlyTotal: 598,
    authorizationStatus: "NOT_AUTHORIZED",
    planFeeDueToday: 0,
    nextChargeAt: null,
    paymentAction: "AUTHORIZE_CARD",
    entitlements: [],
    latestOperation: null,
    activeOperation: null,
    scheduledChanges: [],
    branch: null,
    viewer: { isOwner: true, canManageBilling: true },
    ...overrides,
  };
}

describe("BillingPriceSummary", () => {
  it("separates current Standard trial access from an unauthorised Basic choice", () => {
    const html = renderToStaticMarkup(<BillingPriceSummary experience={experience()} current={null} />);

    expect(html).toContain("Current access");
    expect(html).toContain("Standard trial");
    expect(html).toContain("Plan fee today");
    expect(html).toContain("₹0");
    expect(html).toContain("5 September 2026");
    expect(html).toContain("Full Standard features");
    expect(html).toContain("After the trial");
    expect(html).toContain("Basic");
    expect(html).toContain("Not authorized");
    expect(html).toContain("₹598/month");
    expect(html).toContain("2 branches × ₹299");
    expect(html).toContain("Not scheduled — authorize a card first");
  });

  it("shows a provider-confirmed future Standard authorization without calling it current", () => {
    const html = renderToStaticMarkup(
      <BillingPriceSummary
        experience={experience({
          selectedPostTrialPlan: "STANDARD",
          projectedUnitAmount: 499,
          projectedMonthlyTotal: 998,
          authorizationStatus: "AUTHORIZED",
          nextChargeAt: "2026-09-05T00:00:00.000Z",
          providerStatus: "AUTHENTICATED",
        })}
        current={null}
      />
    );

    expect(html).toContain("After the trial");
    expect(html).toContain("Standard");
    expect(html).toContain("Authorized");
    expect(html).toContain("₹998/month");
    expect(html).toContain("5 September 2026");
    expect(html).not.toContain("Current subscription");
    expect(html).not.toContain("Current plan");
  });

  it("requires an explicit plan choice for migrated workspaces without one", () => {
    const html = renderToStaticMarkup(
      <BillingPriceSummary
        experience={experience({
          selectedPostTrialPlan: null,
          projectedUnitAmount: 0,
          projectedMonthlyTotal: 0,
          paymentAction: "CHOOSE_PLAN",
        })}
        current={null}
      />
    );

    expect(html.match(/Choose a plan/g)).toHaveLength(2);
    expect(html).toContain("Not scheduled — authorize a card first");
  });

  it("labels a plan current only with a provider-confirmed paid boundary", () => {
    const html = renderToStaticMarkup(
      <BillingPriceSummary
        experience={experience({
          effectivePlan: "BASIC",
          selectedPostTrialPlan: "BASIC",
          customerState: "BASIC_ACTIVE",
          trialEndsAt: null,
          trialDaysRemaining: null,
          paidThrough: "2026-10-05T00:00:00.000Z",
          confirmedQuantity: 2,
          currentUnitAmount: 299,
          currentMonthlyTotal: 598,
          authorizationStatus: "AUTHORIZED",
          nextChargeAt: "2026-10-05T00:00:00.000Z",
        })}
        current={null}
      />
    );

    expect(html).toContain("Current subscription");
    expect(html).toContain("Current plan");
    expect(html).toContain("Provider-confirmed paid access");
    expect(html).not.toContain("After the trial");
  });

  it("does not use trial-only pricing language when no trial or paid plan is active", () => {
    const html = renderToStaticMarkup(
      <BillingPriceSummary
        experience={experience({
          accessMode: "READ_ONLY",
          effectivePlan: "NONE",
          customerState: "AUTHORIZATION_REQUIRED",
          customerMessage: "Choose a plan and authorize a card to continue.",
          trialEndsAt: null,
          trialDaysRemaining: null,
          paidThrough: null,
          selectedPostTrialPlan: "BASIC",
          planFeeDueToday: 299,
        })}
        current={null}
      />
    );

    expect(html).toContain("No active paid plan");
    expect(html).toContain("Plan authorization");
    expect(html).toContain("No provider-confirmed paid period");
    expect(html).toContain("Paid access starts only after Razorpay confirms");
    expect(html).not.toContain("After the trial");
    expect(html).not.toContain("Plan fee today");
    expect(html).not.toContain("No plan fee is charged during the Standard trial");
  });
});
