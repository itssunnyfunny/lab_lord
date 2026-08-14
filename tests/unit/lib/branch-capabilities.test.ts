import { describe, expect, it } from "vitest";
import { getBranchCapabilityDecision } from "@/lib/branchCapabilities";
import type { BillingExperience, BranchAccess, StaffAction } from "@/types";

const allPermissions = {
    manage_org: true,
    manage_branch: true,
    students: true,
    seat_allocation: true,
    view_payments: true,
    generate_payments: true,
    mark_payment_paid: true,
    waive_payments: true,
    analytics: true,
    staff_management: true,
} satisfies Record<StaffAction, boolean>;

function billingExperience(
    overrides: Partial<BillingExperience> = {}
): BillingExperience {
    return {
        organizationId: "org_1",
        accessMode: "FULL",
        effectivePlan: "STANDARD_TRIAL",
        selectedPostTrialPlan: null,
        providerStatus: null,
        customerState: "TRIAL_ACTIVE",
        customerMessage: "Workspace access is available.",
        trialEndsAt: null,
        trialDaysRemaining: null,
        paidThrough: null,
        confirmedQuantity: 1,
        projectedQuantity: 1,
        currentUnitAmount: 0,
        currentMonthlyTotal: 0,
        projectedUnitAmount: 0,
        projectedMonthlyTotal: 0,
        authorizationStatus: "NOT_AUTHORIZED",
        planFeeDueToday: 0,
        nextChargeAt: null,
        paymentAction: "NONE",
        entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS"],
        latestOperation: null,
        activeOperation: null,
        scheduledChanges: [],
        branch: { id: "branch_1", name: "Central", billingStatus: "ACTIVE" },
        viewer: { isOwner: true, canManageBilling: true },
        ...overrides,
    };
}

function access(overrides: Partial<BranchAccess> = {}): BranchAccess {
    return {
        branchId: "branch_1",
        branchName: "Central",
        organizationId: "org_1",
        isOwner: true,
        role: "OWNER",
        permissions: { ...allPermissions },
        effectivePlan: "PRO",
        entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS"],
        billingExperience: billingExperience(),
        ...overrides,
    };
}

describe("branch capability decisions", () => {
    it("allows a fully entitled owner", () => {
        expect(getBranchCapabilityDecision(access(), "paymentsRecord")).toEqual({
            allowed: true,
            blocker: null,
            reason: null,
            recoveryHref: null,
        });
    });

    it("blocks a role that lacks any required permission", () => {
        const result = getBranchCapabilityDecision(
            access({
                isOwner: false,
                role: "STAFF",
                permissions: { ...allPermissions, mark_payment_paid: false },
            }),
            "paymentsRecord"
        );

        expect(result.allowed).toBe(false);
        expect(result.blocker).toBe("permission");
        expect(result.recoveryHref).toBeNull();
    });

    it("requires payment visibility before exposing overdue AI messages", () => {
        const analyticsOnly = access({
            isOwner: false,
            role: "STAFF",
            permissions: { ...allPermissions, view_payments: false },
        });

        expect(getBranchCapabilityDecision(analyticsOnly, "aiUse").blocker).toBe("permission");
        expect(getBranchCapabilityDecision(analyticsOnly, "aiGenerate").blocker).toBe("permission");
    });

    it("allows a manager when the resolved permission set includes the action", () => {
        const result = getBranchCapabilityDecision(
            access({ isOwner: false, role: "MANAGER" }),
            "allocationsManage"
        );

        expect(result.allowed).toBe(true);
    });

    it("uses resolved staff overrides instead of assuming permissions from the role name", () => {
        const overriddenStaff = access({
            isOwner: false,
            role: "STAFF",
            permissions: {
                ...allPermissions,
                manage_branch: false,
                mark_payment_paid: true,
                waive_payments: false,
            },
        });

        expect(getBranchCapabilityDecision(overriddenStaff, "paymentsRecord").allowed).toBe(true);
        expect(getBranchCapabilityDecision(overriddenStaff, "paymentsWaive").blocker).toBe("permission");
        expect(getBranchCapabilityDecision(overriddenStaff, "shiftsManage").blocker).toBe("permission");
    });

    it("returns an owner recovery path for a missing entitlement", () => {
        const result = getBranchCapabilityDecision(
            access({ entitlements: [] }),
            "analyticsView"
        );

        expect(result.allowed).toBe(false);
        expect(result.blocker).toBe("entitlement");
        expect(result.recoveryHref).toBe("/org/org_1/settings#billing");
    });

    it("keeps reads available but blocks mutations in read-only mode", () => {
        const readOnlyAccess = access({
            billingExperience: billingExperience({
                accessMode: "READ_ONLY",
                customerMessage: "Restore billing to make changes.",
            }),
        });

        expect(getBranchCapabilityDecision(readOnlyAccess, "paymentsView").allowed).toBe(true);
        const mutation = getBranchCapabilityDecision(readOnlyAccess, "paymentsRecord");
        expect(mutation.allowed).toBe(false);
        expect(mutation.blocker).toBe("read_only");
        expect(mutation.reason).toBe("Restore billing to make changes.");
        expect(getBranchCapabilityDecision(readOnlyAccess, "aiUse").allowed).toBe(true);
        expect(getBranchCapabilityDecision(readOnlyAccess, "aiGenerate").blocker).toBe("read_only");
    });

    it("blocks mutations for a branch pending activation", () => {
        const result = getBranchCapabilityDecision(
            access({
                billingExperience: billingExperience({
                    branch: {
                        id: "branch_1",
                        name: "Central",
                        billingStatus: "PENDING_ACTIVATION",
                    },
                }),
            }),
            "studentsManage"
        );

        expect(result.allowed).toBe(false);
        expect(result.blocker).toBe("branch_state");
        expect(result.reason).toContain("Activate");
    });
});
