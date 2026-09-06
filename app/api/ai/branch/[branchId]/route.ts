import { runBranchAI } from "@/ai/orchestrator/branchAI.orchestrator"
import { getSessionUser } from "@/lib/auth"
import { checkRateLimit, getRequestRateLimitKey } from "@/lib/rateLimit"
import { AccessPolicy, BranchAccessNotFoundError } from "@/services/accessPolicy.service"

export async function GET(
    request: Request,
    props: { params: Promise<{ branchId: string }> }
) {
    try {
        const params = await props.params;
        const user = await getSessionUser()
        if (!user) {
            return Response.json({ error: "Unauthorized" }, { status: 401 })
        }

        const access = await AccessPolicy.authorizeCapability(user.id, params.branchId, "aiGenerate")

        const rateLimit = checkRateLimit(
            getRequestRateLimitKey(request, "ai-report", `${user.id}:${params.branchId}`),
            { limit: 3, windowMs: 15 * 60 * 1000 }
        )

        if (!rateLimit.allowed) {
            return Response.json(
                { error: "Too many AI report requests. Try again later." },
                {
                    status: 429,
                    headers: { "Retry-After": String(rateLimit.retryAfter) },
                }
            )
        }

        const result = await runBranchAI(access)

        return Response.json(result)

    } catch (error) {
        if (error instanceof BranchAccessNotFoundError) return Response.json({ error: error.message }, { status: 404 });
        console.error("AI GENERATION ERROR:", error);
        const message = String(error)
        const status = message.includes("Unauthorized") || message.includes("disabled") ? 403 : 500
        return Response.json(
            { error: "Failed to generate AI insights", details: message },
            { status }
        )
    }
}
