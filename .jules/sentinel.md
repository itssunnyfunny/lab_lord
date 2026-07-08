
## 2026-07-08 - Rate Limiting on Branch-Specific Endpoints
**Vulnerability:** Missing rate limiting on sensitive API endpoints (e.g., staff invites) can lead to abuse, brute-force attacks, and resource exhaustion.
**Learning:** Implementing rate limits without incorporating the tenant or context (like 'branchId') in the namespace can either be too restrictive globally or easily bypassed by rotating users.
**Prevention:** Incorporate context identifiers like 'branchId' directly into the rate limit key namespace (e.g., 'staff-invite-${branchId}') and apply checks immediately after authentication but prior to parsing request bodies.
