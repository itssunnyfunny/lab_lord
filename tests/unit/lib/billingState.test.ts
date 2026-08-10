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

  it("keeps pending access only through the provider-confirmed paid period", () => {
    expect(deriveWorkspaceBillingState({
      now,
      subscription: {
        status: "PENDING",
        plan: "BASIC",
        paidThrough: new Date("2026-08-20T00:00:00.000Z"),
      },
    })).toMatchObject({ accessMode: "WARNING", canWrite: true, effectivePlan: "BASIC" });
    expect(deriveWorkspaceBillingState({
      now,
      subscription: { status: "PENDING", plan: "BASIC", paidThrough: null },
    })).toMatchObject({ accessMode: "READ_ONLY", canWrite: false });
  });

  it("treats a paused UPI mandate as warning access only through paidThrough", () => {
    expect(deriveWorkspaceBillingState({
      now,
      subscription: {
        status: "PAUSED",
        plan: "PRO",
        paidThrough: new Date("2026-08-20T00:00:00.000Z"),
      },
    })).toMatchObject({ accessMode: "WARNING", canWrite: true, effectivePlan: "PRO" });
    expect(deriveWorkspaceBillingState({
      now,
      subscription: { status: "PAUSED", plan: "PRO", paidThrough: now },
    })).toMatchObject({ accessMode: "READ_ONLY", canWrite: false });
  });

  it("applies an authorized upgrade without changing the paid source plan", () => {
    expect(deriveWorkspaceBillingState({
      now,
      subscription: {
        status: "ACTIVE",
        plan: "BASIC",
        paidThrough: new Date("2026-08-20T00:00:00.000Z"),
      },
      authorizedReplacement: {
        plan: "PRO",
        accessGrantedAt: new Date("2026-08-02T00:00:00.000Z"),
        accessRevokedAt: null,
        graceEndsAt: new Date("2026-09-03T00:00:00.000Z"),
      },
    })).toMatchObject({ accessMode: "FULL", effectivePlan: "PRO" });
  });

  it("allows replacement access during bank grace and revokes it afterward", () => {
    const replacement = {
      plan: "PRO" as const,
      accessGrantedAt: new Date("2026-08-01T00:00:00.000Z"),
      accessRevokedAt: null,
      graceEndsAt: new Date("2026-08-06T00:00:00.000Z"),
    };
    expect(deriveWorkspaceBillingState({
      now: new Date("2026-08-05T00:00:00.000Z"),
      subscription: { status: "CANCELLED", plan: "BASIC", paidThrough: null },
      authorizedReplacement: replacement,
    })).toMatchObject({ accessMode: "WARNING", canWrite: true, effectivePlan: "PRO" });
    expect(deriveWorkspaceBillingState({
      now: new Date("2026-08-07T00:00:00.000Z"),
      subscription: { status: "CANCELLED", plan: "BASIC", paidThrough: null },
      authorizedReplacement: replacement,
    })).toMatchObject({ accessMode: "READ_ONLY", canWrite: false, effectivePlan: "BASIC" });
  });

  it("makes halted and unconverted organizations read-only", () => {
    expect(deriveWorkspaceBillingState({
      now,
      subscription: { status: "HALTED", plan: "PRO", paidThrough: null },
    }).accessMode).toBe("READ_ONLY");
    expect(deriveWorkspaceBillingState({ now, subscription: null }).accessMode).toBe("READ_ONLY");
  });
});
