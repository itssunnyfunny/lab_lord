import type { BillingEntitlement } from "@/lib/billingPlans";
import type { BranchAccessRole, StaffAction } from "@/types/staff";

export type CapabilityBlocker =
    | "permission"
    | "entitlement"
    | "read_only"
    | "branch_state";

export type CapabilityDecision =
    | { allowed: true; blocker: null; reason: null; recoveryHref: null }
    | {
        allowed: false;
        blocker: CapabilityBlocker;
        reason: string;
        recoveryHref: string | null;
    };

export type ResourceState<T> =
    | { status: "loading"; previous?: T; previousUpdatedAt?: string }
    | { status: "success"; data: T; updatedAt: string }
    | { status: "empty"; updatedAt: string }
    | { status: "restricted"; reason: string }
    | { status: "stale"; data: T; updatedAt: string; reason: string }
    | { status: "error"; message: string; retryable: boolean };

export type PagedResult<T> = {
    items: T[];
    nextCursor: string | null;
    total: number;
};

export type WorkspaceDirectoryBranch = {
    id: string;
    name: string;
    organizationId: string;
    organizationName: string;
    role: BranchAccessRole;
    permissions: Partial<Record<StaffAction, boolean>>;
    entitlements: BillingEntitlement[];
    href: string;
};

export type WorkspaceDirectoryOrganization = {
    id: string;
    name: string;
    role: "OWNER";
    href: string;
    branches: WorkspaceDirectoryBranch[];
};

export type WorkspaceDirectory = {
    organizations: WorkspaceDirectoryOrganization[];
    staffBranches: WorkspaceDirectoryBranch[];
    defaultHref: string;
};
