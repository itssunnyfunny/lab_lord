"use client";

import { UserButton, useUser } from "@clerk/nextjs";
import { ReactNode, useEffect, useRef, useState } from "react";
import { AmbientBackground } from "@/components/ui/AmbientBackground";
import { usePathname, useRouter } from "next/navigation";
import { BranchTopSearch } from "@/components/layout/BranchTopSearch";
import { BranchNotifications } from "@/components/layout/BranchNotifications";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    chromeAppRootClass,
    chromeDividerClass,
    chromeHeaderClass,
    chromeIconButtonClass,
    chromeInlineCardHoverClass,
    chromeMutedTextClass,
} from "@/components/ui/chromeSurface";
import {
    accountMenuClerkAppearance,
    accountProfileClerkAppearance,
} from "@/components/ui/entrySurface";
import { useBillingExperience } from "@/components/billing/BillingExperienceProvider";
import { BillingBanner } from "@/components/billing/BillingBanner";
import { ReadOnlyBanner } from "@/components/billing/ReadOnlyBanner";
import { WorkspaceSwitcher } from "@/components/layout/WorkspaceSwitcher";
import { UserPreferencesProvider } from "@/components/settings/UserPreferencesApplier";
import { ToastProvider } from "@/components/ui/Toast";
import { RouteTitleUpdater } from "@/components/layout/RouteTitleUpdater";
import { Drawer } from "@/components/ui/Drawer";

interface User {
    name: string;
    role: string;
    avatar: string;
}

interface AppShellProps {
    children: ReactNode;
    sidebar: ReactNode;
    user?: User;
}

function AccountSummary({ user }: { user?: User }) {
    const { user: clerkUser } = useUser();
    const displayName = user?.name ?? clerkUser?.fullName ?? clerkUser?.primaryEmailAddress?.emailAddress ?? "Account";
    const displayRole = user?.role ?? "Workspace User";

    return (
        <div className="text-right hidden sm:block">
            <p className="text-xs font-bold tracking-wide text-[color:var(--text-primary)]">{displayName}</p>
            <p className={cn("text-[10px] uppercase tracking-wider", chromeMutedTextClass)}>{displayRole}</p>
        </div>
    );
}

export function AppShell({ children, sidebar, user }: AppShellProps) {
    const router = useRouter();
    const pathname = usePathname();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const previousPathname = useRef(pathname);
    const showBranchChrome = /^\/branch\/[^/]+/.test(pathname ?? "");
    const billing = useBillingExperience();

    useEffect(() => {
        if (previousPathname.current === pathname) return;
        previousPathname.current = pathname;

        const closeTimer = window.setTimeout(() => setMobileNavOpen(false), 0);
        return () => window.clearTimeout(closeTimer);
    }, [pathname]);

    return (
        <UserPreferencesProvider>
        <ToastProvider>
        <div className={chromeAppRootClass}>
            <RouteTitleUpdater />
            <a
                href="#main-content"
                className="fixed left-4 top-3 z-[120] -translate-y-20 rounded-[var(--ui-radius-control)] bg-cyan-200 px-4 py-2 text-sm font-bold text-slate-950 shadow-lg transition-transform focus:translate-y-0"
            >
                Skip to main content
            </a>
            <AmbientBackground />

            {/* Sidebar Area - Glassmorphic */}
            <div className="relative z-30 hidden md:block">
                {sidebar}
            </div>

            <Drawer
                open={mobileNavOpen}
                onClose={() => setMobileNavOpen(false)}
                title="Workspace navigation"
                closeLabel="Close navigation"
                className="max-w-[19rem] md:hidden"
            >
                <div className="h-[calc(100dvh-7rem)] overflow-hidden">{sidebar}</div>
            </Drawer>

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-w-0 max-w-full relative z-10">
                {/* Top Header */}
                <header className={chromeHeaderClass}>
                    <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4 md:max-w-md">
                        <button
                            type="button"
                            onClick={() => setMobileNavOpen(true)}
                            className={cn("flex-shrink-0 md:hidden", chromeIconButtonClass)}
                            aria-label="Open navigation"
                            aria-expanded={mobileNavOpen}
                        >
                            <Menu size={18} />
                        </button>
                        <WorkspaceSwitcher className="w-32 shrink-0 sm:w-48" />
                        {showBranchChrome && <BranchTopSearch />}
                    </div>

                    <div className="flex flex-shrink-0 items-center gap-1.5 sm:gap-3 md:gap-4">
                        {showBranchChrome && (
                            <>
                                <BranchNotifications />
                                <div className={cn("hidden h-6 w-[1px] sm:block md:mx-2", chromeDividerClass)} />
                            </>
                        )}
                        <button
                            type="button"
                            onClick={() => router.push('/account')}
                            className={cn("hidden items-center gap-3 rounded-full border border-transparent py-1 pl-2 pr-1 transition-colors sm:flex", chromeInlineCardHoverClass)}
                        >
                            <AccountSummary user={user} />
                        </button>
                        <UserButton
                            appearance={accountMenuClerkAppearance}
                            userProfileMode="modal"
                            userProfileProps={{ appearance: accountProfileClerkAppearance }}
                        />
                    </div>
                </header>

                {/* Page Content */}
                <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6 lg:p-8 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                    {billing?.experience && <ReadOnlyBanner experience={billing.experience} />}
                    {billing?.experience && <BillingBanner experience={billing.experience} />}
                    {children}
                </main>
            </div>
        </div>
        </ToastProvider>
        </UserPreferencesProvider>
    );
}
