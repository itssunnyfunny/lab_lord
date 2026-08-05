"use client";

import {
    ArrowLeft,
    BarChart2,
    CalendarCheck,
    CalendarClock,
    CreditCard,
    FileText,
    Grid,
    LayoutDashboard,
    LucideIcon,
    MessageSquare,
    Settings,
    Sparkles,
    TriangleAlert,
    UserCircle,
    Users,
    UploadCloud,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { SidebarItem } from "./SidebarItem";
import { useBranchAccess } from "@/hooks/useBranchAccess";
import type { StaffAction } from "@/types";
import type { BillingFeatureKey } from "@/lib/billingPolicy";
import { hasFeatureEntitlement } from "@/lib/billingPolicy";
import { LogoMark } from "@/components/brand/AppLogo";
import {
    chromeSidebarClass,
    chromeSidebarFooterClass,
    chromeSidebarHeaderClass,
    chromeSidebarSectionLabelClass,
} from "@/components/ui/chromeSurface";

type BranchNavItem = {
    icon: LucideIcon;
    label: string;
    href: string;
    permission?: StaffAction;
    feature?: BillingFeatureKey;
    active: (pathname: string | null) => boolean;
};

export function BranchSidebar() {
    const pathname = usePathname();
    const router = useRouter();

    const segments = pathname?.split("/") || [];
    const branchId = segments[2];
    const basePath = `/branch/${branchId}`;
    const { access, loading } = useBranchAccess(branchId);

    if (!branchId) return null;

    const canSee = (permission?: StaffAction) => {
        if (!permission) return true;
        return access?.permissions[permission] ?? false;
    };

    const featureAvailable = (feature?: BillingFeatureKey) => !feature || hasFeatureEntitlement(access?.entitlements ?? [], feature);

    const overviewItems: BranchNavItem[] = [
        { icon: LayoutDashboard, label: "Dashboard", href: basePath, active: current => current === basePath },
        { icon: BarChart2, label: "Analytics", href: `${basePath}/analytics`, permission: "analytics", feature: "BRANCH_ANALYTICS", active: current => current === `${basePath}/analytics` },
    ];

    const operationItems: BranchNavItem[] = [
        { icon: Users, label: "Students", href: `${basePath}/students`, permission: "students", active: current => current === `${basePath}/students` },
        { icon: UploadCloud, label: "Import Assistant", href: `${basePath}/onboarding/import`, permission: "students", active: current => current?.startsWith(`${basePath}/onboarding/import`) ?? false },
        { icon: Grid, label: "Seats & Maps", href: `${basePath}/seats`, permission: "seat_allocation", active: current => current === `${basePath}/seats` },
        { icon: CalendarClock, label: "Shifts", href: `${basePath}/shifts`, permission: "seat_allocation", active: current => current === `${basePath}/shifts` },
        { icon: CalendarCheck, label: "Allocations", href: `${basePath}/allocations`, permission: "seat_allocation", active: current => current?.startsWith(`${basePath}/allocations`) ?? false },
        { icon: CreditCard, label: "Payments", href: `${basePath}/payments`, permission: "view_payments", active: current => current === `${basePath}/payments` },
        { icon: TriangleAlert, label: "Overdue", href: `${basePath}/overdue`, permission: "view_payments", active: current => current === `${basePath}/overdue` },
        { icon: UserCircle, label: "Staff", href: `${basePath}/staff`, permission: "manage_branch", feature: "STAFF_CONTROLS", active: current => current === `${basePath}/staff` },
    ];

    const intelligenceItems: BranchNavItem[] = [
        { icon: Sparkles, label: "AI Insights", href: `${basePath}/ai/insights`, permission: "analytics", feature: "AI_INSIGHTS", active: current => current === `${basePath}/ai/insights` },
        { icon: FileText, label: "AI Reports", href: `${basePath}/ai/reports`, permission: "analytics", feature: "AI_REPORTS", active: current => current === `${basePath}/ai/reports` },
        { icon: MessageSquare, label: "AI Messages", href: `${basePath}/ai/messages`, permission: "analytics", feature: "AI_MESSAGES", active: current => current === `${basePath}/ai/messages` },
    ];

    const renderItems = (items: BranchNavItem[]) => items.map(item => (
        <SidebarItem
            key={item.href}
            icon={item.icon}
            label={item.label}
            isActive={item.active(pathname)}
            onClick={() => router.push(item.href)}
            density="compact"
            locked={!featureAvailable(item.feature)}
            badge={!featureAvailable(item.feature) ? "Standard" : undefined}
        />
    ));

    const renderSection = (label: string, items: BranchNavItem[]) => {
        const visibleItems = items.filter(item => canSee(item.permission));
        if (visibleItems.length === 0) return null;

        return (
            <div className="space-y-2">
                <div className={chromeSidebarSectionLabelClass}>{label}</div>
                {renderItems(visibleItems)}
            </div>
        );
    };

    return (
        <div className={chromeSidebarClass}>
            <div className={chromeSidebarHeaderClass}>
                <button
                    type="button"
                    onClick={() => router.push("/")}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]"
                    aria-label="Back to home"
                >
                    <LogoMark className="h-10 w-10" title="" />
                </button>
                <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold leading-tight text-[color:var(--text-primary)]">{access?.branchName ?? "Loading..."}</span>
                    <span className="block truncate text-[10px] font-semibold uppercase tracking-wider text-[color:var(--ui-form-accent)]">
                        {access?.role ?? (loading ? "Checking access" : "Branch Connected")}
                    </span>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3 scrollbar-none">
                <div className="space-y-4">
                    {renderSection("Overview", overviewItems)}
                    {renderSection("Operations", operationItems)}
                    {renderSection("Intelligence", intelligenceItems)}
                </div>
            </div>

            {(access?.isOwner || canSee("manage_branch")) && (
                <div className={chromeSidebarFooterClass}>
                    <div className="space-y-2">
                        {access?.isOwner && (
                            <SidebarItem
                                icon={ArrowLeft}
                                label="Back to organization"
                                isActive={false}
                                onClick={() => router.push(`/org/${access.organizationId}`)}
                                density="compact"
                            />
                        )}
                        {canSee("manage_branch") && (
                            <SidebarItem
                                icon={Settings}
                                label="Branch Settings"
                                isActive={pathname === `${basePath}/settings`}
                                onClick={() => router.push(`${basePath}/settings`)}
                                density="compact"
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
