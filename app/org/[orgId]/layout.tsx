import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OrganizationWorkspaceShell } from "@/components/layout/OrganizationWorkspaceShell";
import { getSessionUser } from "@/lib/auth";
import { OrganizationService } from "@/services/organization.service";

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
    const user = await getSessionUser();

    if (!user || !(await OrganizationService.isOwner(orgId, user.id))) {
        redirect("/app");
    }

    return <OrganizationWorkspaceShell organizationId={orgId}>{children}</OrganizationWorkspaceShell>;
}
