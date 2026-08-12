import type { BillingEntitlement } from "@/lib/billingPlans";
import type { BranchAccess, CapabilityDecision, StaffAction } from "@/types";

type CapabilityRequirement = {
    permissions?: readonly StaffAction[];
    entitlement?: BillingEntitlement;
    mutation?: boolean;
};

export const BRANCH_CAPABILITIES = {
    dashboard: {},
    studentsView: { permissions: ["students"] },
    studentsManage: { permissions: ["students"], mutation: true },
    importStudents: { permissions: ["students"], mutation: true },
    allocationsView: { permissions: ["seat_allocation"] },
    allocationsManage: { permissions: ["seat_allocation"], mutation: true },
    seatsView: { permissions: ["seat_allocation"] },
    seatsManage: { permissions: ["manage_branch"], mutation: true },
    shiftsView: { permissions: ["seat_allocation"] },
    shiftsManage: { permissions: ["manage_branch"], mutation: true },
    paymentsView: { permissions: ["view_payments"] },
    paymentsGenerate: { permissions: ["view_payments", "generate_payments"], mutation: true },
    paymentsRecord: { permissions: ["view_payments", "mark_payment_paid"], mutation: true },
    paymentsWaive: { permissions: ["view_payments", "waive_payments"], mutation: true },
    overdueView: { permissions: ["view_payments"] },
    analyticsView: { permissions: ["analytics"], entitlement: "ADVANCED_ANALYTICS" },
    staffView: { permissions: ["manage_branch"], entitlement: "STAFF_MANAGEMENT" },
    staffManage: { permissions: ["staff_management"], entitlement: "STAFF_MANAGEMENT", mutation: true },
    aiUse: { permissions: ["analytics"], entitlement: "AI_ACCESS" },
    aiGenerate: { permissions: ["analytics"], entitlement: "AI_ACCESS", mutation: true },
    settingsManage: { permissions: ["manage_branch"], mutation: true },
} as const satisfies Record<string, CapabilityRequirement>;

export type BranchCapabilityKey = keyof typeof BRANCH_CAPABILITIES;

const ALLOWED_BRANCH_STATES = new Set(["ACTIVE"]);

function billingRecoveryHref(access: BranchAccess) {
    if (!access.isOwner && !access.billingExperience?.viewer.canManageBilling) return null;
    return `/org/${encodeURIComponent(access.organizationId)}/settings#billing`;
}

export function getBranchCapabilityDecision(
    access: BranchAccess | null | undefined,
    capability: BranchCapabilityKey
): CapabilityDecision {
    const requirement: CapabilityRequirement = BRANCH_CAPABILITIES[capability];

    if (!access) {
        return {
            allowed: false,
            blocker: "permission",
            reason: "Branch access is unavailable.",
            recoveryHref: null,
        };
    }

    const missingPermission = requirement.permissions?.find(
        permission => !access.permissions[permission]
    );
    if (missingPermission) {
        return {
            allowed: false,
            blocker: "permission",
            reason: "Your role does not include this action.",
            recoveryHref: null,
        };
    }

    if (requirement.entitlement && !access.entitlements.includes(requirement.entitlement)) {
        return {
            allowed: false,
            blocker: "entitlement",
            reason: access.isOwner
                ? "This feature requires the Standard plan."
                : "The organization owner needs to enable the Standard plan.",
            recoveryHref: billingRecoveryHref(access),
        };
    }

    if (requirement.mutation) {
        const branchStatus = access.billingExperience?.branch?.billingStatus;
        if (branchStatus && !ALLOWED_BRANCH_STATES.has(branchStatus)) {
            return {
                allowed: false,
                blocker: "branch_state",
                reason: branchStatus === "PENDING_ACTIVATION"
                    ? "Activate this branch before making changes."
                    : branchStatus === "REMOVAL_SCHEDULED"
                        ? "Changes are unavailable while branch removal is scheduled."
                        : "This branch is archived and cannot be changed.",
                recoveryHref: billingRecoveryHref(access),
            };
        }

        if (access.billingExperience?.accessMode === "READ_ONLY") {
            return {
                allowed: false,
                blocker: "read_only",
                reason: access.billingExperience.customerMessage || "This workspace is read-only.",
                recoveryHref: billingRecoveryHref(access),
            };
        }
    }

    return { allowed: true, blocker: null, reason: null, recoveryHref: null };
}

export function hasBranchCapability(
    access: BranchAccess | null | undefined,
    capability: BranchCapabilityKey
) {
    return getBranchCapabilityDecision(access, capability).allowed;
}
