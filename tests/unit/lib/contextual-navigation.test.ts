import { describe, expect, it } from "vitest";
import { resolveContextualParent } from "@/lib/contextualNavigation";

describe("resolveContextualParent", () => {
    it("returns no back destination for workspace roots", () => {
        expect(resolveContextualParent("/app")).toBeNull();
        expect(resolveContextualParent("/branch/branch_1")).toBeNull();
        expect(resolveContextualParent("/org/org_1")).toBeNull();
    });

    it("routes branch child pages to their dashboard", () => {
        expect(resolveContextualParent("/branch/branch_1/payments")).toEqual({
            href: "/branch/branch_1",
            label: "Back to branch dashboard",
        });
    });

    it("routes nested imports to import history", () => {
        expect(resolveContextualParent("/branch/branch%201/onboarding/import/session_1")).toEqual({
            href: "/branch/branch%201/onboarding/import",
            label: "Back to import history",
        });
    });

    it("routes organization children and billing processing safely", () => {
        expect(resolveContextualParent("/org/org_1/settings")?.href).toBe("/org/org_1");
        expect(resolveContextualParent("/org/org_1/billing/processing/change_1")).toEqual({
            href: "/org/org_1/settings?section=billing",
            label: "Back to billing settings",
        });
    });

    it("routes account pages to the app entry", () => {
        expect(resolveContextualParent("/account")).toEqual({
            href: "/app",
            label: "Back to workspaces",
        });
    });
});
