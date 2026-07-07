## 2024-07-25 - Missing Rate Limiting on Branch-Specific Mutating API Route
**Vulnerability:** Missing rate limiting on the POST /api/branches/[branchId]/staff-invites endpoint, exposing it to brute-force and abuse.
**Learning:** State-mutating API routes were unprotected because they lacked usage of the available rate-limiting utilities in `@/lib/rateLimit`.
**Prevention:** Apply `checkRateLimit` and `getRequestRateLimitKey` to all sensitive, state-mutating API routes immediately after user authentication (before parsing request body) and ensure rate limit keys incorporate relevant context like `branchId` (`staff-invite-${branchId}`).
