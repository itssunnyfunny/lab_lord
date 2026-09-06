import { EntityPermissionMatrix, OVERRIDABLE_STAFF_ACTIONS, OverridableStaffAction, STAFF_ACTIONS, StaffAction, StaffPermissionAction, StaffPermissionUpdate, StaffRole } from "@/types";

export const PERMISSION_MATRIX: EntityPermissionMatrix = {
    manage_org: [], // OWNER only
    manage_branch: [StaffRole.MANAGER],
    students: [StaffRole.MANAGER, StaffRole.STAFF],
    seat_allocation: [StaffRole.MANAGER, StaffRole.STAFF],
    view_payments: [StaffRole.MANAGER, StaffRole.STAFF],
    generate_payments: [StaffRole.MANAGER],
    mark_payment_paid: [StaffRole.MANAGER, StaffRole.STAFF],
    waive_payments: [StaffRole.MANAGER],
    analytics: [StaffRole.MANAGER],
    view_whatsapp: [StaffRole.MANAGER, StaffRole.STAFF],
    send_whatsapp: [StaffRole.MANAGER, StaffRole.STAFF],
    manage_whatsapp: [StaffRole.MANAGER],
    receive_whatsapp_reports: [StaffRole.MANAGER],
    staff_management: [], // OWNER only
};

export const ACTION_TO_PERMISSION_ACTION: Record<OverridableStaffAction, StaffPermissionAction> = {
    manage_branch: StaffPermissionAction.MANAGE_BRANCH,
    students: StaffPermissionAction.STUDENTS,
    seat_allocation: StaffPermissionAction.SEAT_ALLOCATION,
    view_payments: StaffPermissionAction.VIEW_PAYMENTS,
    generate_payments: StaffPermissionAction.GENERATE_PAYMENTS,
    mark_payment_paid: StaffPermissionAction.MARK_PAYMENT_PAID,
    waive_payments: StaffPermissionAction.WAIVE_PAYMENTS,
    analytics: StaffPermissionAction.ANALYTICS,
    view_whatsapp: StaffPermissionAction.VIEW_WHATSAPP,
    send_whatsapp: StaffPermissionAction.SEND_WHATSAPP,
    manage_whatsapp: StaffPermissionAction.MANAGE_WHATSAPP,
    receive_whatsapp_reports: StaffPermissionAction.RECEIVE_WHATSAPP_REPORTS,
};

export const OVERRIDABLE_ACTION_SET = new Set<string>(OVERRIDABLE_STAFF_ACTIONS);

export function isOverridableStaffAction(action: StaffAction): action is OverridableStaffAction {
    return OVERRIDABLE_ACTION_SET.has(action);
}

export function normalizePermissionUpdate(permissions: StaffPermissionUpdate | undefined) {
    if (!permissions) return [];

    return Object.entries(permissions).map(([action, allowed]) => {
        if (!OVERRIDABLE_ACTION_SET.has(action)) {
            throw new Error(`Permission '${action}' cannot be overridden`);
        }
        if (allowed !== true && allowed !== false && allowed !== null) {
            throw new Error(`Permission '${action}' must be true, false, or null`);
        }

        return {
            action: action as OverridableStaffAction,
            permissionAction: ACTION_TO_PERMISSION_ACTION[action as OverridableStaffAction],
            allowed,
        };
    });
}

export function buildOwnerPermissions() {
    return STAFF_ACTIONS.reduce<Record<StaffAction, boolean>>((permissions, action) => {
        permissions[action] = true;
        return permissions;
    }, {} as Record<StaffAction, boolean>);
}

export function buildStaffPermissions(
    role: StaffRole,
    permissionOverrides: { action: StaffPermissionAction; allowed: boolean }[]
) {
    return STAFF_ACTIONS.reduce<Record<StaffAction, boolean>>((permissions, action) => {
        const permissionAction = isOverridableStaffAction(action)
            ? ACTION_TO_PERMISSION_ACTION[action]
            : null;
        const override = permissionAction
            ? permissionOverrides.find(item => item.action === permissionAction)
            : null;

        permissions[action] = override?.allowed ?? PERMISSION_MATRIX[action].includes(role);
        return permissions;
    }, {} as Record<StaffAction, boolean>);
}
