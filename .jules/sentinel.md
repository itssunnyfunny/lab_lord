
## 2024-07-03 - Missing Rate Limiting on Sensitive Endpoints
**Vulnerability:** The API endpoints for staff invites (`/api/branches/[branchId]/staff-invites`) and onboarding (`/api/onboarding`) did not implement rate limiting.
**Learning:** These are sensitive, state-mutating endpoints where missing rate limiting leaves the application vulnerable to brute-force attacks, spamming, and denial of service. The lack of branch-scoping on invites also meant an attacker could exhaust resources.
**Prevention:** Always wrap state-mutating, un-cached, sensitive endpoints (like invites, onboarding, authentication) with the project's internal `checkRateLimit` utility. For branch-specific endpoints, incorporate the `branchId` in the rate limit key to properly scope limits. Perform the check after user authentication but before request body parsing to minimize computational waste.
