## 2026-07-04 - Rate limit implemented on branch-specific endpoints
**Vulnerability:** The POST endpoint for creating staff invites lacked rate limiting, exposing the system to brute-force attacks and abuse.
**Learning:** We need to scope rate limiting per user and branch (e.g. `staff-invite-${branchId}`) when implementing rate limiting on Next.js API routes with branch-specific resources.
**Prevention:** Always implement `checkRateLimit` on sensitive, state-mutating API routes that allow multiple attempts, specifically scoping the limit key using the user's ID and relevant context.
