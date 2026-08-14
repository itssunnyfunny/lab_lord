import type { BranchAccess, StaffAction } from "@/types";

export const BRANCH_PAGE_ACCESS = {
    analytics: "analytics",
    settings: "manage_branch",
    staff: "manage_branch",
    shifts: "seat_allocation",
    seats: "seat_allocation",
    payments: "view_payments",
    overdue: "view_payments",
    students: "students",
    importAssistant: "students",
    allocations: "seat_allocation",
    aiReports: "analytics",
    aiMessages: ["analytics", "view_payments"],
} as const satisfies Record<string, StaffAction | readonly [StaffAction, ...StaffAction[]]>;

export type BranchPageAccessKey = keyof typeof BRANCH_PAGE_ACCESS;

export function hasBranchPageAccess(
    access: Pick<BranchAccess, "permissions"> | null | undefined,
    page: BranchPageAccessKey
) {
    if (!access) return false;

    const requirement = BRANCH_PAGE_ACCESS[page];
    const requiredPermissions = typeof requirement === "string" ? [requirement] : requirement;
    return requiredPermissions.every(permission => access.permissions[permission]);
}
