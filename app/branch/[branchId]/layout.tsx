import type { Metadata } from "next";
import { BranchWorkspaceShell } from "@/components/layout/BranchWorkspaceShell";

export const metadata: Metadata = {
    title: "Branch workspace",
    description: "Manage students, seats, shifts, allocations, payments, staff, and branch analytics in Lab Lords.",
    robots: { index: false, follow: false },
};

export default async function BranchLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ branchId: string }>;
}) {
    const { branchId } = await params;
    return <BranchWorkspaceShell branchId={branchId}>{children}</BranchWorkspaceShell>;
}
