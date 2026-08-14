import { StaffRole } from "./enums";
import type { BillingEntitlement, BillingPlanId } from "@/lib/billingPlans";
import type { BillingExperienceView } from "@/types/billingExperience";

export const STAFF_ACTIONS = [
    "manage_org",
    "manage_branch",
    "students",
    "seat_allocation",
    "view_payments",
    "generate_payments",
    "mark_payment_paid",
    "waive_payments",
    "analytics",
    "staff_management",
] as const;

export type StaffAction = typeof STAFF_ACTIONS[number];

export const OVERRIDABLE_STAFF_ACTIONS = [
    "manage_branch",
    "students",
    "seat_allocation",
    "view_payments",
    "generate_payments",
    "mark_payment_paid",
    "waive_payments",
    "analytics",
] as const satisfies readonly StaffAction[];

export type OverridableStaffAction = typeof OVERRIDABLE_STAFF_ACTIONS[number];
export type StaffPermissionUpdate = Partial<Record<OverridableStaffAction, boolean | null>>;

export type EntityPermissionMatrix = Record<StaffAction, StaffRole[]>;

export type BranchAccessRole = "OWNER" | StaffRole;

export type BranchAccess = {
    branchId: string;
    branchName: string;
    organizationId: string;
    isOwner: boolean;
    role: BranchAccessRole;
    staffId?: string;
    permissions: Record<StaffAction, boolean>;
    effectivePlan: BillingPlanId;
    entitlements: BillingEntitlement[];
    billingExperience?: BillingExperienceView;
};
