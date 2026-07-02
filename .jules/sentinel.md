## 2026-07-02 - Missing Rate Limiting on Branch-Specific Actions
**Vulnerability:** The sensitive POST endpoint for staff invites lacked rate limiting.
**Learning:** Branch-specific actions must incorporate the branchId into the rate limit key to properly scope limits per user per branch. The check must happen after authentication but before body parsing to conserve server compute resources.
**Prevention:** Always implement checkRateLimit and getRequestRateLimitKey from @/lib/rateLimit on sensitive API routes, particularly before parsing request bodies, returning a 429 status code with a Retry-After header when limits are exceeded.
