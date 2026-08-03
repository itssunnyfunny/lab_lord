import { describe, expect, it } from "vitest";
import { deriveWorkspaceBillingState } from "@/lib/billingState";

const now = new Date("2026-08-03T00:00:00.000Z");

describe("deriveWorkspaceBillingState", () => {
  it("grants Standard during the owner trial without a card", () => {
    expect(deriveWorkspaceBillingState({
      now,
      trial: { status: "ACTIVE", endsAt: new Date("2026-09-02T00:00:00.000Z") },
      subscription: null,
    })).toMatchObject({ accessMode: "FULL", effectivePlan: "PRO", source: "TRIAL" });
  });

  it("does not treat ACTIVE as paid without paidThrough", () => {
    expect(deriveWorkspaceBillingState({
      now,
      subscription: { status: "ACTIVE", plan: "PRO", paidThrough: null },
    })).toMatchObject({ accessMode: "READ_ONLY", canWrite: false });
  });

  it("uses the provider-confirmed paid boundary", () => {
    expect(deriveWorkspaceBillingState({
      now,
      subscription: {
        status: "CANCELLED",
        plan: "PRO",
        paidThrough: new Date("2026-08-20T00:00:00.000Z"),
      },
    })).toMatchObject({ accessMode: "FULL", source: "PAID" });
  });

  it("keeps pending access with a warning even before recovery", () => {
    expect(deriveWorkspaceBillingState({
      now,
      subscription: { status: "PENDING", plan: "BASIC", paidThrough: null },
    })).toMatchObject({ accessMode: "WARNING", canWrite: true, effectivePlan: "BASIC" });
  });

  it("makes halted and unconverted organizations read-only", () => {
    expect(deriveWorkspaceBillingState({
      now,
      subscription: { status: "HALTED", plan: "PRO", paidThrough: null },
    }).accessMode).toBe("READ_ONLY");
    expect(deriveWorkspaceBillingState({ now, subscription: null }).accessMode).toBe("READ_ONLY");
  });
});
