"use client";

import { LayoutDashboard, BarChart3, Settings } from "lucide-react";
import { SidebarItem } from "./SidebarItem";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { AppLogo } from "@/components/brand/AppLogo";
import {
    chromeOrgSidebarClass,
    chromeSidebarFooterClass,
    chromeSidebarHeaderClass,
    chromeSidebarSectionLabelClass,
} from "@/components/ui/chromeSurface";
import { useBillingExperience } from "@/components/billing/BillingExperienceProvider";
import { hasFeatureEntitlement } from "@/lib/billingPolicy";

export function OrgSidebar() {
    const pathname = usePathname();
    const billing = useBillingExperience();

    const segments = pathname?.split('/') || [];
    const orgId = segments[2];
    const basePath = `/org/${orgId}`;

    return (
        <aside className={chromeOrgSidebarClass} aria-label="Organization navigation">
            <div className={chromeSidebarHeaderClass}>
                <Link href="/app" aria-label="Open workspace home">
                    <AppLogo
                        subtitle="Operations"
                        markClassName="h-10 w-10"
                        titleClassName="text-lg font-bold sm:text-lg"
                        subtitleClassName="tracking-widest"
                    />
                </Link>
            </div>

            <div className="flex-1 p-6 space-y-2">
                <div className={`${chromeSidebarSectionLabelClass} mb-4`}>Organization</div>
                <SidebarItem icon={LayoutDashboard} label="Dashboard" isActive={pathname === basePath} href={basePath} />
                <SidebarItem
                    icon={BarChart3}
                    label="Global Analytics"
                    isActive={pathname === `${basePath}/analytics`}
                    href={`${basePath}/analytics`}
                    locked={!hasFeatureEntitlement(billing?.experience?.entitlements ?? [], "ORG_ANALYTICS")}
                    badge={!hasFeatureEntitlement(billing?.experience?.entitlements ?? [], "ORG_ANALYTICS") ? "Standard" : undefined}
                />
            </div>

            <div className={chromeSidebarFooterClass}>
                <SidebarItem
                    icon={Settings}
                    label="System Settings"
                    isActive={pathname === `${basePath}/settings`}
                    href={`${basePath}/settings`}
                />
            </div>
        </aside>
    );
}
