import { describe, expect, it } from "vitest";

import {
  deriveAuthorizedReplacementOverride,
  getReplacementAccessAction,
  type ReplacementAccessDecisionInput,
} from "@/services/billingReplacement.service";

const grantedAt = new Date("2026-08-10T10:00:00.000Z");
const effectiveAt = new Date("2026-09-01T00:00:00.000Z");
const graceEndsAt = new Date("2026-09-04T00:00:00.000Z");
const beforeCutover = new Date("2026-08-20T00:00:00.000Z");

function decision(
  overrides: Partial<ReplacementAccessDecisionInput> = {}
): ReplacementAccessDecisionInput {
  return {
    changeType: "PLAN_UPGRADE",
    changeStatus: "AWAITING_PAYMENT",
    failureCategory: null,
    sourcePlan: "BASIC",
    sourceQuantity: 1,
    targetPlan: "PRO",
    targetQuantity: 1,
    candidatePlan: "PRO",
    candidateQuantity: 1,
    candidateStatus: "AUTHENTICATED",
    candidatePaymentMethod: "UPI",
    candidateProviderPlanId: "plan_pro",
    targetProviderPlanId: "plan_pro",
    accessGrantedAt: null,
    accessRevokedAt: null,
    effectiveAt,
    accessGraceEndsAt: graceEndsAt,
    now: beforeCutover,
    ...overrides,
  };
}

describe("authorized replacement access policy", () => {
  it.each([
    ["AUTHENTICATED", "UPI"],
    ["ACTIVE", "EMANDATE"],
    ["ACTIVE", "CARD"],
  ])("grants an exact upgrade after %s authorization with %s", (candidateStatus, method) => {
    expect(getReplacementAccessAction(decision({
      candidateStatus,
      candidatePaymentMethod: method,
    }))).toBe("GRANT");
  });

  it("grants quantity additions and reactivations without promoting billing", () => {
    for (const changeType of ["QUANTITY_INCREASE", "BRANCH_REACTIVATION"]) {
      expect(getReplacementAccessAction(decision({
        changeType,
        sourcePlan: "BASIC",
        targetPlan: "BASIC",
        candidatePlan: "BASIC",
        sourceQuantity: 1,
        targetQuantity: 2,
        candidateQuantity: 2,
        candidateProviderPlanId: "plan_basic",
        targetProviderPlanId: "plan_basic",
      }))).toBe("GRANT");
    }
  });

  it("keeps CREATED eMandates and unconfirmed or mismatched targets fail-closed", () => {
    expect(getReplacementAccessAction(decision({
      candidateStatus: "CREATED",
      candidatePaymentMethod: "EMANDATE",
    }))).toBe("NONE");
    expect(getReplacementAccessAction(decision({ candidatePaymentMethod: "UNKNOWN" }))).toBe("NONE");
    expect(getReplacementAccessAction(decision({ candidateProviderPlanId: "plan_basic" }))).toBe("NONE");
    expect(getReplacementAccessAction(decision({ candidateQuantity: 2 }))).toBe("NONE");
  });

  it("never applies downgrades or branch removals early", () => {
    expect(getReplacementAccessAction(decision({
      changeType: "PLAN_DOWNGRADE",
      sourcePlan: "PRO",
      targetPlan: "BASIC",
      candidatePlan: "BASIC",
      candidateProviderPlanId: "plan_basic",
      targetProviderPlanId: "plan_basic",
    }))).toBe("NONE");
    expect(getReplacementAccessAction(decision({
      changeType: "BRANCH_REMOVAL",
      sourceQuantity: 2,
      targetQuantity: 1,
      candidateQuantity: 1,
    }))).toBe("NONE");
  });

  it.each([
    { changeStatus: "FAILED" },
    { changeStatus: "UNDONE" },
    { failureCategory: "MANUAL_REVIEW_REQUIRED" },
    { candidatePaymentMethod: "UNKNOWN" },
    { candidateStatus: "PENDING" },
    { candidateStatus: "PAUSED" },
    { candidateStatus: "HALTED" },
    { candidateStatus: "EXPIRED" },
    { candidateStatus: "CANCELLED" },
  ])("revokes previously granted access for $changeStatus$candidateStatus", overrides => {
    expect(getReplacementAccessAction(decision({
      accessGrantedAt: grantedAt,
      ...overrides,
    }))).toBe("REVOKE");
  });

  it("retains only the bounded eMandate charge-confirmation grace", () => {
    expect(getReplacementAccessAction(decision({
      accessGrantedAt: grantedAt,
      candidateStatus: "PENDING",
      candidatePaymentMethod: "EMANDATE",
      now: new Date("2026-09-02T00:00:00.000Z"),
    }))).toBe("NONE");
    expect(getReplacementAccessAction(decision({
      accessGrantedAt: grantedAt,
      candidateStatus: "PENDING",
      candidatePaymentMethod: "UPI",
      now: new Date("2026-09-02T00:00:00.000Z"),
    }))).toBe("REVOKE");
    expect(getReplacementAccessAction(decision({
      accessGrantedAt: grantedAt,
      candidateStatus: "AUTHENTICATED",
      now: graceEndsAt,
    }))).toBe("NONE");
    expect(getReplacementAccessAction(decision({
      accessGrantedAt: grantedAt,
      candidateStatus: "ACTIVE",
      now: new Date("2026-09-10T00:00:00.000Z"),
    }))).toBe("NONE");
  });

  it("does not mutate access twice or revoke access after canonical promotion", () => {
    expect(getReplacementAccessAction(decision({ accessGrantedAt: grantedAt }))).toBe("NONE");
    expect(getReplacementAccessAction(decision({
      accessGrantedAt: grantedAt,
      accessRevokedAt: new Date("2026-08-11T00:00:00.000Z"),
      candidateStatus: "CANCELLED",
    }))).toBe("NONE");
    expect(getReplacementAccessAction(decision({
      changeStatus: "APPLIED",
      accessGrantedAt: grantedAt,
      candidateStatus: "COMPLETED",
    }))).toBe("NONE");
  });

  it("exposes only a live, supported, correctly linked beneficial override", () => {
    const input = {
      changeType: "PLAN_UPGRADE",
      changeStatus: "SCHEDULED",
      failureCategory: null,
      sourceSubscriptionId: "source",
      changeSourceSubscriptionId: "source",
      candidateSubscriptionId: "candidate",
      changeCandidateSubscriptionId: "candidate",
      sourcePlan: "BASIC",
      sourceQuantity: 1,
      candidatePlan: "PRO",
      candidateQuantity: 1,
      candidateStatus: "PENDING",
      candidatePaymentMethod: "EMANDATE",
      accessGrantedAt: grantedAt,
      accessRevokedAt: null,
      effectiveAt,
      accessGraceEndsAt: graceEndsAt,
      now: new Date("2026-09-02T00:00:00.000Z"),
    };

    expect(deriveAuthorizedReplacementOverride(input)).toMatchObject({
      plan: "PRO",
      accessGrantedAt: grantedAt,
    });
    expect(deriveAuthorizedReplacementOverride({
      ...input,
      changeSourceSubscriptionId: "other",
    })).toBeNull();
    expect(deriveAuthorizedReplacementOverride({
      ...input,
      changeType: "PLAN_DOWNGRADE",
      sourcePlan: "PRO",
      candidatePlan: "BASIC",
    })).toBeNull();
    expect(deriveAuthorizedReplacementOverride({
      ...input,
      accessRevokedAt: new Date("2026-08-12T00:00:00.000Z"),
    })).toBeNull();
    expect(deriveAuthorizedReplacementOverride({
      ...input,
      candidateStatus: "PAUSED",
    })).toBeNull();
    expect(deriveAuthorizedReplacementOverride({
      ...input,
      failureCategory: "MANUAL_REVIEW_REQUIRED",
    })).toBeNull();
    expect(deriveAuthorizedReplacementOverride({
      ...input,
      candidateStatus: "PENDING",
      now: graceEndsAt,
    })).toBeNull();
    expect(deriveAuthorizedReplacementOverride({
      ...input,
      candidateStatus: "AUTHENTICATED",
      now: graceEndsAt,
    })).toMatchObject({ plan: "PRO", accessGrantedAt: grantedAt });
    expect(deriveAuthorizedReplacementOverride({
      ...input,
      candidateStatus: "PENDING",
      candidatePaymentMethod: "UPI",
    })).toBeNull();
  });
});
