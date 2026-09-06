# Auth Environments

> **Scope:** This is an authentication-only supplement. For the complete
> environment inventory, database isolation, migrations, cron, deployment, and
> incident procedures, use
> [`production-runbook.md`](production-runbook.md).

Lab Lords uses Clerk for real identity and Prisma `User` rows for app ownership, staff roles, settings, and audit history.

## Local Development

Use a Clerk development instance for local work. Development keys intentionally show Clerk's development-mode banner.

Required local configuration names are `DATABASE_URL`,
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, and `CLERK_SECRET_KEY`. Obtain values from
the approved local/development sources; do not copy them into documentation or
reports.

Application routing is defined in code: sign-in is `/sign-in`, sign-up is
`/sign-up`, and an unqualified successful authentication falls back to `/app`.
Do not invent environment-variable overrides for these routes.

Smooth seeded demo account:

1. Run migrations and seed local data.
2. In the Clerk development dashboard, create or sign up a user with `alice@lablord.com`.
3. Sign in locally at `http://localhost:3000/sign-in`.
4. The first authenticated request links Clerk's user ID to the seeded local Alice row.

Seeded emails that already have app data:

- `alice@lablord.com` owner demo account
- `bob@lablord.com` owner plus manager demo account
- `carol@lablord.com` manager demo account
- `dave@lablord.com` staff demo account

If you sign in with a different email, the app creates a new local user and sends you through onboarding.

## Tests

Tests use `.env.test` and a separate PostgreSQL database whose URL must include `test`.

Clerk keys are not needed for Vitest. Clerk/auth behavior is mocked in tests that need it.

### Authenticated Playwright release checks

Use an existing owner-approved Clerk development test identity. Sign in through
`/sign-in`, select the email-code alternative where necessary, and enter the
Clerk test code with keyboard events (segmented OTP controls may not accept a
programmatic whole-field replacement). Wait for `/app` to resolve and a protected
page to load before saving browser context storage state in ignored `.clerk/`.
Never commit cookies or invent an application authentication bypass.

The browser harness reads PLAYWRIGHT_OWNER_AUTH_STATE / PLAYWRIGHT_OWNER_BRANCH_ID,
PLAYWRIGHT_MANAGER_AUTH_STATE / PLAYWRIGHT_MANAGER_BRANCH_ID,
PLAYWRIGHT_STAFF_AUTH_STATE / PLAYWRIGHT_STAFF_BRANCH_ID and
PLAYWRIGHT_READ_ONLY_AUTH_STATE / PLAYWRIGHT_READ_ONLY_BRANCH_ID.
Billing UI fixtures additionally use PLAYWRIGHT_AUTH_STATE and
PLAYWRIGHT_OWNER_ORG_ID. The organization must really belong to that session:
browser API mocks do not override the server layout's ownership check.

Clerk session tokens expire quickly. The shared browser helper first loads a
public page and refreshes the real session using Clerk's normal getToken API;
an absent/revoked session fails explicitly. Direct authenticated API requests in
the RC smoke use current Clerk-issued bearer tokens, verified by the same server
middleware. See Clerk's [testing token lifecycle](https://clerk.com/docs/guides/development/testing/overview).
This provides real identity evidence; mocked billing/import UI responses remain
mocks and must be described separately.

The opt-in `tests/browser/release-candidate.spec.ts` mutates synthetic local data.
It requires PLAYWRIGHT_RC_ISOLATED_CONFIRM=lab_lords_final_fresh_test and a
localhost PLAYWRIGHT_BASE_URL, plus owner/staff sessions, owner branch/org and
PLAYWRIGHT_FOREIGN_BRANCH_ID / PLAYWRIGHT_FOREIGN_ORG_ID. Independently verify
the server's actual database before setting that confirmation. Prepare the owner
through canonical V2 onboarding, a STAFF membership with VIEW_PAYMENTS explicitly
denied, and a different owner's foreign V2 organization/branch. Never point the
test at Production, shared Preview or a real customer's local database. The test
does not reset or delete fixture data. Fixture creation authority is separate
from permission to invite users, contact providers or enable Production flags.

Public redirect tests need the existing development
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY in the Playwright process,
not just in the dev server's dotenv environment. Pass them in memory from the
approved source without printing values. Test-local import processes require
IMPORT_V2_ENABLED and a positive IMPORT_MAX_PLANNED_MUTATIONS; keep GEMINI_API_KEY
empty for the deterministic local rehearsal. None of this authorizes external
Razorpay/Meta/Gemini canaries.

## Production

Production should use a separate Clerk production instance, live keys, and a production database.

Production uses the same three configuration names with values from the
operator-approved Production database and Clerk production instance. Never
print or copy those values into a local report.

Production checklist:

- Configure allowed origins and redirect URLs in Clerk for the deployed domain.
- Use live Clerk keys only in the production hosting environment.
- Follow `production-runbook.md` for the reviewed application/migration order.
- Never seed demo data into Production.

## Check The Current Env

Run:

```bash
pnpm auth:check
```

For the test env:

```bash
pnpm auth:check .env.test
```
