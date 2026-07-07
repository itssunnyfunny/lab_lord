## 2024-05-24 - Rate Limiting on Branch-Specific Endpoints
**Vulnerability:** Missing rate limiting on sensitive branch-specific endpoints (like staff-invites) allows brute-force and spam attacks.
**Learning:** In Next.js API routes, rate limiting checks must be placed after authentication but before `req.json()` to avoid unnecessary compute overhead from body parsing on rejected requests. Also, limits should be scoped using both `branchId` and `user.id` to prevent global lockouts while properly throttling individual abusers per branch.
**Prevention:** Use `getRequestRateLimitKey(req, 'action-' + branchId, user.id)` and return a 429 response with a `Retry-After` header.
