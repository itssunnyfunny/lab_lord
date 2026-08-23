import type { StaffAction } from "@/types";

export const STAFF_ACTION_LABELS: Record<StaffAction, string> = {
    manage_org: "organization management",
    manage_branch: "branch management",
    students: "student management",
    seat_allocation: "seat allocation",
    view_payments: "payment viewing",
    generate_payments: "payment generation",
    mark_payment_paid: "payment collection",
    waive_payments: "payment waiver",
    analytics: "analytics",
    view_whatsapp: "WhatsApp viewing",
    send_whatsapp: "WhatsApp sending",
    manage_whatsapp: "WhatsApp management",
    staff_management: "owner-only staff management",
};

export function getPermissionHelpText(action: StaffAction) {
    return `Requires ${STAFF_ACTION_LABELS[action]} access. Ask the branch owner to update your staff permissions.`;
}

export function getAnyPermissionHelpText(actions: readonly StaffAction[]) {
    const labels = actions.map(action => STAFF_ACTION_LABELS[action]);

    if (labels.length === 0) {
        return "Requires additional access. Ask the branch owner to update your staff permissions.";
    }

    if (labels.length === 1) {
        return `Requires ${labels[0]} access. Ask the branch owner to update your staff permissions.`;
    }

    const last = labels[labels.length - 1];
    const prefix = labels.slice(0, -1).join(", ");
    const labelText = labels.length === 2 ? `${labels[0]} or ${last}` : `${prefix}, or ${last}`;

    return `Requires ${labelText} access. Ask the branch owner to update your staff permissions.`;
}
