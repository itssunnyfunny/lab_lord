import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { OrganizationService } from "@/services/organization.service";

export async function GET() {
    try {
        const user = await getSessionUser();
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const organizations = await OrganizationService.getOrganizationsByUserId(user.id);
        return NextResponse.json(organizations);
    } catch (error) {
        console.error("Error fetching organizations:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(_req: Request) {
    void _req;
    try {
        const user = await getSessionUser();
        if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        return NextResponse.json(
            { error: "Create workspaces through onboarding.", code: "ONBOARDING_REQUIRED" },
            { status: 410 }
        );
    } catch {
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
