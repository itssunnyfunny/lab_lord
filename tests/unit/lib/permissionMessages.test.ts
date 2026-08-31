import { describe, expect, it } from "vitest";
import { getAnyPermissionHelpText, getPermissionHelpText, STAFF_ACTION_LABELS } from "@/lib/permissionMessages";

describe("permission messages", () => {
    it("has readable labels for sensitive staff actions", () => {
        expect(STAFF_ACTION_LABELS.staff_management).toBe("owner-only staff management");
        expect(STAFF_ACTION_LABELS.waive_payments).toBe("payment waiver");
        expect(STAFF_ACTION_LABELS.manage_branch).toBe("branch management");
        expect(STAFF_ACTION_LABELS.view_whatsapp).toBe("WhatsApp viewing");
        expect(STAFF_ACTION_LABELS.send_whatsapp).toBe("WhatsApp sending");
        expect(STAFF_ACTION_LABELS.manage_whatsapp).toBe("WhatsApp management");
        expect(STAFF_ACTION_LABELS.receive_whatsapp_reports)
            .toBe("WhatsApp daily-report receiving");
    });

    it("explains who can adjust permissions", () => {
        expect(getPermissionHelpText("analytics")).toContain("Requires analytics access");
        expect(getPermissionHelpText("analytics")).toContain("branch owner");
    });

    it("explains when any one of multiple permissions can unlock an action", () => {
        expect(getAnyPermissionHelpText(["mark_payment_paid", "waive_payments"])).toBe(
            "Requires payment collection or payment waiver access. Ask the branch owner to update your staff permissions."
        );
    });
});
