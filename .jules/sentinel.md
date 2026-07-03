
## 2024-05-24 - Rate Limiting Scoping and Placement
**Vulnerability:** Missing rate limits on state-mutating API routes allows brute-force and spam attacks.
**Learning:** Rate limits for branch-specific actions must include the `branchId` in the rate limit key to properly scope per user per branch. Furthermore, the check must be performed after user authentication (to use `user.id` as actor) but before parsing the request body (`req.json()`) to conserve server resources.
**Prevention:** Always implement `checkRateLimit` and `getRequestRateLimitKey` on sensitive endpoints like onboarding or invites, ensuring proper actor scoping, optimal placement before body parsing, and returning a 429 status with a `Retry-After` header.
