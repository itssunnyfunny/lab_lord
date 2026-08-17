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
