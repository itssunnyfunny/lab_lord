import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { LAST_ACTIVE_BRANCH_COOKIE } from "@/lib/workspaceRouting";
import { UserService } from "@/services/user.service";

export async function GET() {
    const session = await getSessionUser();
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const cookieStore = await cookies();
        const directory = await UserService.getWorkspaceDirectory(
            session.id,
            cookieStore.get(LAST_ACTIVE_BRANCH_COOKIE)?.value
        );
        return NextResponse.json(directory);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to load workspaces";
        return NextResponse.json(
            { error: message === "User not found" ? message : "Unable to load workspaces" },
            { status: message === "User not found" ? 404 : 500 }
        );
    }
}
