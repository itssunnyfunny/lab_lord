import type { Metadata } from "next";
import { OrganizationWorkspaceShell } from "@/components/layout/OrganizationWorkspaceShell";

export const metadata: Metadata = {
    title: "Organization workspace",
    description: "Review branches, organization analytics, settings, and billing in Lab Lords.",
    robots: { index: false, follow: false },
};

export default async function OrgLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ orgId: string }>;
}) {
    const { orgId } = await params;
    return <OrganizationWorkspaceShell organizationId={orgId}>{children}</OrganizationWorkspaceShell>;
}
