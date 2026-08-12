"use client";

import { useEffect, type ReactNode } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { BranchSidebar } from "@/components/layout/BranchSidebar";
import { BillingExperienceProvider } from "@/components/billing/BillingExperienceProvider";
import { BranchActivationGate } from "@/components/billing/BranchActivationGate";
import {
    LAST_ACTIVE_BRANCH_COOKIE,
    LAST_ACTIVE_BRANCH_COOKIE_MAX_AGE,
} from "@/lib/workspaceRouting";

export function BranchWorkspaceShell({ branchId, children }: { branchId: string; children: ReactNode }) {
    useEffect(() => {
        const secure = window.location.protocol === "https:" ? "; secure" : "";
        document.cookie = `${LAST_ACTIVE_BRANCH_COOKIE}=${encodeURIComponent(branchId)}; path=/; max-age=${LAST_ACTIVE_BRANCH_COOKIE_MAX_AGE}; samesite=lax${secure}`;
    }, [branchId]);

    return (
        <BillingExperienceProvider branchId={branchId}>
            <AppShell sidebar={<BranchSidebar />}>
                <BranchActivationGate>{children}</BranchActivationGate>
            </AppShell>
        </BillingExperienceProvider>
    );
}
