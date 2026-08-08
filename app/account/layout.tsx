import type { Metadata } from "next";
import { AppShell } from "@/components/layout/AppShell";
import { AccountSidebar } from "@/components/layout/AccountSidebar";

export const metadata: Metadata = {
    title: "Account settings",
    robots: { index: false, follow: false },
};

export default function AccountLayout({ children }: { children: React.ReactNode }) {
    return <AppShell sidebar={<AccountSidebar />}>{children}</AppShell>;
}
