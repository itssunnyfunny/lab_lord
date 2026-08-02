import { runBranchAI } from "@/ai/orchestrator/branchAI.orchestrator"
import { getSessionUser } from "@/lib/auth"
import { checkRateLimit, getRequestRateLimitKey } from "@/lib/rateLimit"
import { StaffService } from "@/services/staff.service"
import { EntitlementService } from "@/services/entitlement.service"

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

        await StaffService.authorize(user.id, params.branchId, "analytics")
        await EntitlementService.assertBranchEntitlement(params.branchId, "AI_ACCESS")

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

        const result = await runBranchAI(params.branchId)

        return Response.json(result)

    } catch (error) {
        console.error("AI GENERATION ERROR:", error);
        const message = String(error)
        const status = message.includes("Unauthorized") || message.includes("disabled") ? 403 : 500
        return Response.json(
            { error: "Failed to generate AI insights", details: message },
            { status }
        )
    }
}
