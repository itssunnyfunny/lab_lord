## 2024-07-08 - Rate Limiting Branch-Specific Endpoints
**Vulnerability:** Missing rate limit on sensitive state-mutating endpoints (e.g., `/staff-invites`) allowed brute-force attacks and abuse.
**Learning:** Checking rate limits before parsing the request body (`req.json()`) conserves server compute resources on rejected requests. Rate limits for branch actions must incorporate `branchId` and `user.id` to correctly scope limits per user per branch.
**Prevention:** Use `getRequestRateLimitKey(req, "action-name-" + branchId, user.id)` and `checkRateLimit` after authentication but before body parsing on all branch-specific endpoints.
