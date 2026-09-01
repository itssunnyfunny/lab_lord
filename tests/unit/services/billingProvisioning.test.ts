import { RazorpayApiError, type RazorpaySubscription } from "@/lib/razorpay";
import { describe, expect, it } from "vitest";
import {
  classifyInitialProvisioningMatches,
  initialProvisioningNotes,
  isDefinitelyRejectedInitialProvisioningError,
  isSameInitialProvisioningIntent,
  type InitialProvisioningTuple,
} from "@/services/billingProvisioning.service";

const intent: InitialProvisioningTuple = {
  changeId: "change_1",
  organizationId: "org_1",
  providerMode: "TEST",
  billingModelVersion: "WORKSPACE_V2",
  plan: "BASIC",
  providerPlanId: "plan_basic",
  quantity: 2,
  providerOfferId: "offer_launch",
  startAt: 1788201000,
  expireAt: 1788201900,
  totalCount: 120,
};

function provider(overrides: Partial<RazorpaySubscription> = {}): RazorpaySubscription {
  return {
    id: "sub_1",
    entity: "subscription",
    plan_id: intent.providerPlanId,
    status: "created",
    total_count: intent.totalCount,
    quantity: intent.quantity,
    paid_count: 0,
    remaining_count: intent.totalCount,
    start_at: intent.startAt,
    expire_by: intent.expireAt,
    offer_id: intent.providerOfferId,
    notes: initialProvisioningNotes(intent),
    ...overrides,
  };
}

describe("initial Razorpay subscription provisioning", () => {
  it("binds provider evidence to the complete immutable correlation tuple", () => {
    expect(isSameInitialProvisioningIntent(provider(), intent)).toBe(true);

    for (const [field, value] of [
      ["organization_id", "org_other"],
      ["provider_mode", "LIVE"],
      ["billing_change_id", "change_other"],
      ["billing_model_version", "LEGACY"],
      ["quantity", "3"],
      ["offer_id", "offer_other"],
      ["start_at", "1788201001"],
      ["expire_at", "1788201901"],
    ] as const) {
      expect(isSameInitialProvisioningIntent(provider({
        notes: { ...initialProvisioningNotes(intent), [field]: value },
      }), intent)).toBe(false);
    }
  });

  it("accepts exactly one uncharged CREATED match and quarantines every ambiguous shape", () => {
    const exact = provider();
    expect(classifyInitialProvisioningMatches([exact], intent)).toEqual({
      kind: "ONE_SAFE_CREATED",
      subscription: exact,
    });
    expect(classifyInitialProvisioningMatches([
      exact,
      provider({ id: "sub_2" }),
    ], intent)).toMatchObject({ kind: "MULTIPLE_MATCHES" });
    expect(classifyInitialProvisioningMatches([
      provider({ status: "authenticated" }),
    ], intent)).toMatchObject({ kind: "UNSAFE_MATCH" });
    expect(classifyInitialProvisioningMatches([
      provider({ paid_count: 1 }),
    ], intent)).toMatchObject({ kind: "UNSAFE_MATCH" });
    expect(classifyInitialProvisioningMatches([
      provider({ paid_count: undefined }),
    ], intent)).toMatchObject({ kind: "UNSAFE_MATCH" });
    expect(classifyInitialProvisioningMatches([
      provider({ paid_count: 0.5 }),
    ], intent)).toMatchObject({ kind: "UNSAFE_MATCH" });
    expect(classifyInitialProvisioningMatches([
      provider({ notes: { ...initialProvisioningNotes(intent), organization_id: "org_other" } }),
    ], intent)).toEqual({ kind: "NO_MATCH" });
  });

  it("allows a new logical attempt only after a definite provider rejection", () => {
    expect(isDefinitelyRejectedInitialProvisioningError(
      new RazorpayApiError("invalid request", { kind: "REQUEST", status: 400 })
    )).toBe(true);
    expect(isDefinitelyRejectedInitialProvisioningError(
      new RazorpayApiError("timeout", { kind: "REQUEST", status: 408 })
    )).toBe(false);
    expect(isDefinitelyRejectedInitialProvisioningError(
      new RazorpayApiError("network", { kind: "NETWORK" })
    )).toBe(false);
    expect(isDefinitelyRejectedInitialProvisioningError(
      new RazorpayApiError("provider", { kind: "PROVIDER", status: 503 })
    )).toBe(false);
    expect(isDefinitelyRejectedInitialProvisioningError(new Error("unknown"))).toBe(false);
  });
});
