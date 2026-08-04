"use client";

import { AppShell } from "@/components/layout/AppShell";
import { OrgSidebar } from "@/components/layout/OrgSidebar";
import { BillingExperienceProvider } from "@/components/billing/BillingExperienceProvider";
import { usePathname } from "next/navigation";

export default function OrgLayout({ children }: { children: React.ReactNode }) {
    const organizationId = usePathname()?.split("/")[2];
    return (
        <BillingExperienceProvider organizationId={organizationId}>
            <AppShell sidebar={<OrgSidebar />}>
                {children}
            </AppShell>
        </BillingExperienceProvider>
    );
}
