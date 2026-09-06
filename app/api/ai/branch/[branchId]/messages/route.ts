import { draftOverdueMessages } from "@/ai/messageDrafting/branchMessageDrafter"
import { getSessionUser } from "@/lib/auth"
import { checkRateLimit, getRequestRateLimitKey } from "@/lib/rateLimit"
import { AccessPolicy, BranchAccessNotFoundError } from "@/services/accessPolicy.service"
import { NextRequest, NextResponse } from "next/server"


export async function GET(
    req: NextRequest,
    props: { params: Promise<{ branchId: string }> }
) {
    try {
        const { branchId } = await props.params
        const user = await getSessionUser()
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const access = await AccessPolicy.authorizeCapability(user.id, branchId, "aiUse")

        const { searchParams } = new URL(req.url)
        const result = await draftOverdueMessages(access, {
            language: searchParams.get("lang") === "hi" ? "hi" : searchParams.get("lang") === "en" ? "en" : undefined,
            tone: searchParams.get("tone") === "friendly" || searchParams.get("tone") === "firm" || searchParams.get("tone") === "polite"
                ? searchParams.get("tone") as "friendly" | "firm" | "polite"
                : undefined,
            include: searchParams.get("include") ?? undefined,
            allowGeneration: false,
        })

        return NextResponse.json(result)

    } catch (error) {
        if (error instanceof BranchAccessNotFoundError) return Response.json({ error: error.message }, { status: 404 });
        console.error("[AI MESSAGES ERROR]", error)
        const message = String(error)
        return NextResponse.json(
            { error: "Failed to generate message drafts", details: message },
            { status: message.includes("Unauthorized") ? 403 : 500 }
        )
    }
}

export async function POST(
    req: NextRequest,
    props: { params: Promise<{ branchId: string }> }
) {
    try {
        const { branchId } = await props.params
        const user = await getSessionUser()
        if (!user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const access = await AccessPolicy.authorizeCapability(user.id, branchId, "aiGenerate")

        const rateLimit = checkRateLimit(
            getRequestRateLimitKey(req, "ai-message-generation", `${user.id}:${branchId}`),
            { limit: 8, windowMs: 15 * 60 * 1000 }
        )

        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: "Too many message generation requests. Try again later." },
                {
                    status: 429,
                    headers: { "Retry-After": String(rateLimit.retryAfter) },
                }
            )
        }

        const body = await req.json().catch(() => ({})) as {
            language?: "en" | "hi";
            tone?: "polite" | "friendly" | "firm";
            include?: unknown;
            studentIds?: unknown;
        }
        const studentIds = Array.isArray(body.studentIds)
            ? body.studentIds.filter((value): value is string => typeof value === "string")
            : []

        const result = await draftOverdueMessages(access, {
            language: body.language,
            tone: body.tone,
            include: body.include,
            regenerateStudentIds: studentIds,
            allowGeneration: true,
            generateMissing: false,
        })

        return NextResponse.json(result)

    } catch (error) {
        if (error instanceof BranchAccessNotFoundError) return Response.json({ error: error.message }, { status: 404 });
        console.error("[AI MESSAGES ERROR]", error)
        const message = String(error)
        return NextResponse.json(
            { error: "Failed to generate message drafts", details: message },
            { status: message.includes("Unauthorized") ? 403 : 500 }
        )
    }
}
