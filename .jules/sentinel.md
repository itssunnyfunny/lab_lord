## 2026-07-04 - Rate Limiting on Branch-Specific API Routes
**Vulnerability:** Missing rate limiting on state-mutating and sensitive endpoints like staff invites, allowing potential brute-force attacks or spamming.
**Learning:** API routes must explicitly implement rate limiting to prevent abuse, and the limit key needs to be properly scoped (e.g. including branchId) rather than relying on a global key.
**Prevention:** Apply `checkRateLimit` after user authentication using the user ID as the actor key and scope it with branch-specific identifiers before parsing the request body to conserve resources.
