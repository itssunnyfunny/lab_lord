# AGENTS.md

Repository-wide instructions for coding agents. Keep this file small: it routes
work to the durable sources of truth instead of duplicating them.

## Repository purpose

Lab Lords is a production, multi-tenant SaaS for study halls, libraries,
coaching centres, and tuition centres in India. It manages organizations,
branches, students, seats, shifts, staff, payments, analytics, imports, and
AI-assisted workflows.

## Source of truth

- Inspect the repository before making assumptions.
- Code, Prisma schema, migrations, tests, and observed behavior describe the
  current implementation.
- The **Must preserve—enforced** and **Service-layer contract—not DB-enforced**
  entries in [`docs/domain-invariants.md`](docs/domain-invariants.md), together
  with [`SECURITY.md`](SECURITY.md) and Accepted ADRs, describe required
  behavior. **Known discrepancy—do not rely on** entries are cautions to resolve,
  not behavior to preserve.
- [`docs/ai/current-state.md`](docs/ai/current-state.md) is the dated
  architecture and implementation snapshot, not a substitute for inspection.
- If implementation and required behavior conflict, record the discrepancy and
  escalate it. Never silently redefine either side.

## Read before changing

- Domain behavior: `docs/domain-invariants.md`.
- Authentication, authorization, tenancy, billing, imports, secrets, or AI data
  handling: `SECURITY.md`.
- Architecture or implementation status: `docs/ai/current-state.md`.
- Schema, migrations, deployment, cron, environment, or incidents:
  `docs/production-runbook.md`.
- Architectural or policy choices: `docs/decisions/README.md` and applicable
  Accepted ADRs.

No nested `AGENTS.md` currently overrides these instructions.

## Working agreement

- Keep changes narrowly scoped to the approved goal. Avoid unrelated refactors,
  formatting churn, and dependency changes.
- Do not change package versions, database schema, migration history, seed data,
  or environment configuration unless the task explicitly requires it.
- Keep API handlers thin and business logic in `services/`; use the shared
  Prisma client from `lib/prisma.ts` in application code.
- User-initiated mutations must re-check object authorization, tenant scope,
  permissions, entitlements, and branch writability server-side.
- A machine-authenticated cron or maintenance operation may bypass user
  entitlement only when explicitly documented as system-owned behavior,
  tenant-scoped, idempotent, and incapable of granting SaaS access or initiating
  provider charges.
- Tenant isolation is application-enforced. Never assume a bare ID or foreign
  key proves organization or branch ownership.
- Preserve generic, tenant-safe responses for foreign and nonexistent records.
  Where current code differs, treat that as a documented discrepancy rather
  than precedent.
- Do not weaken provider-authoritative billing checks, webhook or callback
  verification, mode isolation, durable idempotency, ordering, or replay safety.
- Treat AI output as untrusted and advisory. It must not become authorization,
  billing truth, or an automatic external action.
- Do not access or modify Production data. Never run tests against shared,
  Preview, or Production databases.
- Never print secrets, tokens, environment values, raw webhook bodies, or
  unnecessary personal data in commands, logs, patches, or reports.

## Before editing

1. Inspect the relevant implementation, schema, tests, and applicable guidance.
2. State the current behavior and identify affected invariants and trust
   boundaries.
3. Choose the smallest safe change and identify affected callers, data, and
   deployment surfaces.
4. Plan targeted tests and any migration, rollout, or rollback requirements.

## Commands

Use `pnpm`.

```bash
pnpm install
pnpm dev
pnpm test -- <test-file-or-pattern>
pnpm test
pnpm test:coverage
pnpm lint
pnpm build
pnpm prisma generate
```

Local schema work, only when explicitly in scope:

```bash
pnpm prisma migrate dev
pnpm prisma db seed
```

If direct `pnpm` invocation fails in PowerShell, use Git Bash or:

```text
cmd /c "%APPDATA%\npm\pnpm.cmd" <command>
```

Integration setup loads `.env.test`, requires `DATABASE_URL` to contain `test`,
and truncates the configured database. The substring guard is not sufficient
proof that a database is disposable; verify the exact target first.

## Validation

- Run the most relevant targeted tests while developing and the broader affected
  suite before completion.
- Run lint and a Production build when the change can affect them.
- For documentation-only work, validate links, paths, examples, and
  `git diff --check`; runtime tests may be omitted with the reason reported.
- Report exact commands and pass/fail results. Never claim verification without
  command evidence.

## Documentation maintenance

Update the canonical document in the same change when work alters:

- architecture or implementation status: `docs/ai/current-state.md`;
- required domain behavior: `docs/domain-invariants.md`;
- trust boundaries or security requirements: `SECURITY.md`;
- migration, environment, cron, deployment, rollback, or incident procedures:
  `docs/production-runbook.md`;
- an approved architectural or policy decision: add or update an ADR under
  `docs/decisions/`.

Do not invent an Accepted decision. Agents may draft ADRs, but a human owner
must approve them.

## Completion report

Include behavior changed, files changed, tests added or updated, commands and
results, schema/migration/environment requirements, remaining risks, and
intentionally unchanged behavior.

## Git

Do not commit, push, create or switch branches, or open a pull request unless
explicitly requested.
