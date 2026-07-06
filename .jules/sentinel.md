## 2024-05-24 - Rate Limiting on Branch-Specific Endpoints
**Vulnerability:** Missing rate limiting on the staff invites POST endpoint allowed potential abuse and spam of invites per branch.
**Learning:** Rate limiting was not applied consistently to sensitive mutating endpoints, and the implementation requires scoping by branchId rather than a global action to prevent users from bypassing branch-specific limits.
**Prevention:** Always implement `checkRateLimit` on state-mutating endpoints, perform the check immediately after authentication and before body parsing, use branch-scoped keys (e.g., `staff-invite-${branchId}`), and return HTTP 429 with a `Retry-After` header.
