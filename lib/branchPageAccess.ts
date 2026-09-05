import type { BranchAccess, StaffAction } from "@/types";

export type BranchPermissionSet = StaffAction | readonly [StaffAction, ...StaffAction[]];
export type BranchPagePermissionRequirement = BranchPermissionSet | {
    anyOf: readonly BranchPermissionSet[];
};

const WHATSAPP_REPORT_RECIPIENT_PERMISSIONS = [
    "view_whatsapp",
    "receive_whatsapp_reports",
    "view_payments",
    "analytics",
] as const satisfies readonly [StaffAction, ...StaffAction[]];

export const BRANCH_PAGE_ACCESS = {
    analytics: "analytics",
    settings: {
        anyOf: ["manage_branch", WHATSAPP_REPORT_RECIPIENT_PERMISSIONS],
    },
    staff: "manage_branch",
    shifts: "seat_allocation",
    seats: "seat_allocation",
    payments: "view_payments",
    overdue: "view_payments",
    students: "students",
    importAssistant: "students",
    allocations: "seat_allocation",
    aiReports: ["analytics", "view_payments"],
    aiMessages: ["analytics", "view_payments"],
} as const satisfies Record<string, BranchPagePermissionRequirement>;

export type BranchPageAccessKey = keyof typeof BRANCH_PAGE_ACCESS;

function hasPermissionSet(
    access: Pick<BranchAccess, "permissions">,
    requirement: BranchPermissionSet
) {
    const requiredPermissions = typeof requirement === "string" ? [requirement] : requirement;
    return requiredPermissions.every(permission => access.permissions[permission]);
}

export function hasBranchPermissionRequirement(
    access: Pick<BranchAccess, "permissions"> | null | undefined,
    requirement: BranchPagePermissionRequirement
) {
    if (!access) return false;
    if (typeof requirement === "object" && "anyOf" in requirement) {
        return requirement.anyOf.some(candidate => hasPermissionSet(access, candidate));
    }
    return hasPermissionSet(access, requirement);
}

export function firstBranchPermissionRequirement(
    requirement: BranchPagePermissionRequirement
): StaffAction {
    const first = typeof requirement === "object" && "anyOf" in requirement
        ? requirement.anyOf[0]
        : requirement;
    return typeof first === "string" ? first : first[0];
}

export function hasBranchPageAccess(
    access: Pick<BranchAccess, "permissions"> | null | undefined,
    page: BranchPageAccessKey
) {
    return hasBranchPermissionRequirement(access, BRANCH_PAGE_ACCESS[page]);
}
