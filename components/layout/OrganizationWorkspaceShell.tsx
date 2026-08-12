"use client";

import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { OrgSidebar } from "@/components/layout/OrgSidebar";
import { BillingExperienceProvider } from "@/components/billing/BillingExperienceProvider";

export function OrganizationWorkspaceShell({ organizationId, children }: { organizationId: string; children: ReactNode }) {
    return (
        <BillingExperienceProvider organizationId={organizationId}>
            <AppShell sidebar={<OrgSidebar />}>{children}</AppShell>
        </BillingExperienceProvider>
    );
}
