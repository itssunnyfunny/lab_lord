## 2024-07-05 - Rate Limiting on Branch-Specific API Routes
**Vulnerability:** Missing rate limiting on sensitive, state-mutating endpoints like staff-invites exposes the application to brute-force attacks and abuse.
**Learning:** Branch-specific endpoints must incorporate the 'branchId' into the rate limit key (e.g., `staff-invite-${branchId}`) to properly scope limits per user per branch. Rate limiting checks (`checkRateLimit`) should occur after authentication (using `user.id` as actor key) but before body parsing (`req.json()`) to save compute resources.
**Prevention:** Implement `checkRateLimit` and `getRequestRateLimitKey` early in Next.js API routes, always returning an HTTP 429 status code with a `Retry-After` header using `retryAfter` from the response.
