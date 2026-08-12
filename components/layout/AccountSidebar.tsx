"use client";

import Link from "next/link";
import { LayoutDashboard, UserRound } from "lucide-react";
import { AppLogo } from "@/components/brand/AppLogo";
import { SidebarItem } from "@/components/layout/SidebarItem";
import {
    chromeOrgSidebarClass,
    chromeSidebarHeaderClass,
    chromeSidebarSectionLabelClass,
} from "@/components/ui/chromeSurface";

export function AccountSidebar() {
    return (
        <aside className={chromeOrgSidebarClass} aria-label="Account navigation">
            <div className={chromeSidebarHeaderClass}>
                <Link href="/app" aria-label="Open workspace home">
                    <AppLogo subtitle="Account" markClassName="h-10 w-10" />
                </Link>
            </div>
            <nav className="flex-1 space-y-2 p-6" aria-label="Account">
                <div className={`${chromeSidebarSectionLabelClass} mb-4`}>Personal</div>
                <SidebarItem
                    icon={UserRound}
                    label="Account settings"
                    isActive
                    href="/account"
                />
                <SidebarItem
                    icon={LayoutDashboard}
                    label="Back to workspace"
                    isActive={false}
                    href="/app"
                />
            </nav>
        </aside>
    );
}
