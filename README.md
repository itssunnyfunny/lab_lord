# Lab Lords

Lab Lords is a Next.js micro-ERP for offline education businesses such as study halls, coaching centers, and libraries. It manages organizations, branches, seats, shifts, students, staff, payments, analytics, and AI-assisted branch insights.

## Repository Guidance

The durable guidance bridge for humans and AI agents is:

- [`AGENTS.md`](AGENTS.md) — repository working agreement and reading map.
- [`SECURITY.md`](SECURITY.md) — trust boundaries and security review policy.
- [`docs/ai/current-state.md`](docs/ai/current-state.md) — dated architecture and implementation snapshot.
- [`docs/domain-invariants.md`](docs/domain-invariants.md) — required business rules and known discrepancies.
- [`docs/production-runbook.md`](docs/production-runbook.md) — environment, migration, deployment, cron, and incident procedures.
- [`docs/decisions/README.md`](docs/decisions/README.md) — ADR index, template, and approval rules.

## Tech Stack

- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- Prisma
- PostgreSQL
- Vitest
- Axios
- Clerk via `@clerk/nextjs`
- Google Gemini via `@google/genai`

## Project Structure

```text
app/          Next.js pages, layouts, loading/error UI, and API routes
components/   Shared UI, layout, dashboard, analytics, AI, payment, and table components
services/     Backend/business logic used by API routes
lib/          Prisma client, auth helper, API clients, and shared utilities
prisma/       Prisma schema, migrations, and seed data
tests/        Vitest unit, integration, e2e-style tests, and setup helpers
ai/           Gemini client, prompts, contracts, readers, orchestrator, and reports
analytics/    Analytics calculations and trend helpers
hooks/        Client-side React hooks
types/        Shared TypeScript domain types
utils/        Date, money, formatting, and shift-time helpers
scripts/      Debugging, audit, and verification scripts
styles/       Design tokens and shared styling assets
public/       Static assets
```

## Requirements

- Node.js
- pnpm
- PostgreSQL

## Environment Variables

Local development uses the configuration names `DATABASE_URL`,
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, and `CLERK_SECRET_KEY`.
`GEMINI_API_KEY` is required only for live Gemini-backed AI behavior. Obtain
values from approved local/development sources and keep them in an ignored
environment file; never copy values into documentation or reports.

Sign-in (`/sign-in`), sign-up (`/sign-up`), and the `/app` fallback are defined
in code, not through Clerk route environment variables.

Tests use `.env.test`. The test `DATABASE_URL` must include the word `test`; the Vitest setup intentionally aborts otherwise and can truncate all application tables. Verify that the exact target is a dedicated disposable database—never shared, Preview, or Production data.
Clerk keys are not required for Vitest because Clerk is mocked in auth tests.

Check the current auth environment:

```bash
pnpm auth:check
```

See [docs/auth-environments.md](docs/auth-environments.md) for authentication-specific separation and [docs/production-runbook.md](docs/production-runbook.md) for the full environment and database safety procedure.

## Install

```bash
pnpm install
```

## Database Setup

Generate the Prisma client:

```bash
pnpm prisma generate
```

Run migrations:

```bash
pnpm prisma migrate dev
```

Seed local demo data:

```bash
pnpm prisma db seed
```

The seed creates demo users, organizations, branches, seats, shifts, students, payments, staff, and AI sample data.

## Run Locally

```bash
pnpm dev
```

Open:

```text
http://localhost:3000
```

Local development should use Clerk test keys when testing real auth. Clerk will show its development-mode banner with `pk_test` / `sk_test` keys; that is expected locally.

For a smooth seeded demo account, create or sign up a Clerk development user with `alice@lablord.com` after seeding. The app will link that Clerk user to the seeded local Alice account on first authenticated request.

## Tests

Run all tests:

```bash
pnpm test
```

Watch mode:

```bash
pnpm test:watch
```

Coverage:

```bash
pnpm test:coverage
```

Vitest is configured in `vitest.config.ts`. Tests run in a Node environment and use the global setup in `tests/setup/global.ts`.

Before running integration tests, make sure the test database exists and has the Prisma schema applied.

## Lint and Build

Lint:

```bash
pnpm lint
```

Build:

```bash
pnpm build
```

Start a production build:

```bash
pnpm start
```

## Useful Scripts

This repo includes diagnostic and verification scripts in `scripts/`, including checks for payments, shifts, allocation safety, analytics consistency, Gemini connectivity, and rate limiting.

Inspect a script before running it because most scripts assume a valid `DATABASE_URL`, and some may read or modify local database data.

## Development Notes

- Keep API route handlers focused on request/response handling.
- Keep domain behavior in `services/`.
- Use the shared Prisma client from `lib/prisma.ts`.
- Use existing helpers from `lib/`, `utils/`, `types/`, `analytics/`, and `ai/` before adding new abstractions.
- Add or update tests when changing service behavior, analytics calculations, utilities, or API behavior.
- Existing Prisma migrations should be treated as history; add new migrations instead of editing old ones.

## Important Files

- `package.json` - scripts, dependencies, lint-staged config, Prisma seed command
- `prisma/schema.prisma` - database schema
- `prisma/seed.ts` - local demo seed data
- `lib/prisma.ts` - Prisma client setup
- `lib/api/core.ts` - Axios API client
- `lib/auth.ts` - Clerk-backed local user provisioning helper
- `services/` - business logic
- `app/api/` - API route handlers
- `vitest.config.ts` - test configuration
- `tests/setup/` - test environment and database helpers

## Known Setup Notes

- The app requires PostgreSQL for normal local use.
- Tests require a separate test database.
- AI features warn or fail gracefully when `GEMINI_API_KEY` is missing, depending on the path being exercised.
- This project uses `pnpm`; prefer it over `npm`, `yarn`, or `bun`.
