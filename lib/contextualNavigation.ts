export type ContextualParent = {
    href: string;
    label: string;
};

export function resolveContextualParent(pathname: string | null): ContextualParent | null {
    if (!pathname) return null;

    if (pathname === "/account" || pathname.startsWith("/account/")) {
        return { href: "/app", label: "Back to workspaces" };
    }

    const branchMatch = pathname.match(/^\/branch\/([^/]+)(?:\/(.+))?\/?$/);
    if (branchMatch) {
        const branchId = branchMatch[1];
        const childPath = branchMatch[2]?.replace(/\/$/, "");
        if (!childPath) return null;

        if (/^onboarding\/import\/[^/]+/.test(childPath)) {
            return {
                href: `/branch/${branchId}/onboarding/import`,
                label: "Back to import history",
            };
        }

        return {
            href: `/branch/${branchId}`,
            label: "Back to branch dashboard",
        };
    }

    const organizationMatch = pathname.match(/^\/org\/([^/]+)(?:\/(.+))?\/?$/);
    if (organizationMatch) {
        const organizationId = organizationMatch[1];
        const childPath = organizationMatch[2]?.replace(/\/$/, "");
        if (!childPath) return null;

        if (/^billing\/processing\/[^/]+/.test(childPath)) {
            return {
                href: `/org/${organizationId}/settings?section=billing`,
                label: "Back to billing settings",
            };
        }

        return {
            href: `/org/${organizationId}`,
            label: "Back to organization dashboard",
        };
    }

    return null;
}
