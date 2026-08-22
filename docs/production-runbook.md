# Production runbook

This runbook covers the repository-owned procedures for operating Lab Lords. It
does not grant access to Production and does not replace provider dashboards,
database recovery documentation, or an approved incident-response policy.

Last reconciled with the repository: 2026-08-22.

## Stop conditions and operator-owned preconditions

Do not migrate, deploy, enable billing, rotate a secret, restore data, or invoke
a protected Production job until the operator has supplied and verified the
items that are not encoded in this repository:

- the Vercel team, project, Production branch, Production domains, deployment
  path, deployment approvers, and rollback authority;
- the Vercel plan and function limits. The hourly billing schedule requires a
  plan that accepts hourly cron expressions; Import Assistance V2 additionally
  requires the approved Workflow 4.6/Fluid Compute configuration and limits;
- the exact Production database identity and a direct migration endpoint that
  has been checked independently of its URL text;
- the database backup owner, backup command, retention, most recent successful
  restore test, recovery point objective, and recovery time objective;
- the incident commander, on-call contact, escalation path, customer and
  regulatory notification owner, and approved private evidence location;
- the monitoring provider, alert thresholds, runtime-log retention, and the
  procedure for confirming that a deployment is healthy;
- the Import Assistance V2 owner/security approval, provider processing and
  data-residency review, benchmark evidence, analysis/completion SLOs,
  mutation-cap owner, Workflow/ledger monitoring, and active-run rollback or
  cancellation authority;
- the authority and dashboard procedure for disabling Vercel Cron Jobs or
  stopping Production traffic;
- the allowed overlap period for old and new Razorpay webhook secrets;
- the stable Preview and Production webhook hostnames and any Deployment
  Protection exception needed for Razorpay delivery; and
- the canonical Node.js and pnpm versions. CI currently uses Node.js 20 and
  pnpm 9, while the Production migration workflow uses Node.js 24 and pnpm 9;
  `package.json` does not pin either runtime.

If any applicable item is unknown, stop and obtain an operator decision. Do not
infer it from a hostname, environment-variable name, successful connection, or
previous deployment.

## Non-negotiable safety rules

- Never expose, commit, paste into an issue, or print secret values, connection
  strings, bearer tokens, webhook signatures, raw webhook bodies, or customer
  data.
- Never give Local, Test, or Preview a Production database, Clerk instance,
  Razorpay credential, webhook secret, or cron secret.
- Never run `prisma migrate dev`, `prisma db push`, or the seed command against
  Production. Never edit an applied migration.
- Never use browser success, a callback alone, or a locally inferred provider
  state as proof of payment. Signed webhooks and provider reconciliation remain
  authoritative.
- Never improvise cleanup SQL, reverse an applied migration by hand, or
  automatically refund an ambiguous charge.
- Record the commit, deployment ID, migration workflow run, UTC start/end time,
  operator, checks, and outcome for every Production change.

## Environments

Vercel distinguishes Development, Preview, and Production deployments and lets
variables be scoped to each environment. See Vercel's official
[Environments](https://vercel.com/docs/deployments/environments) and
[Environment variables](https://vercel.com/docs/environment-variables)
documentation.

| Environment | Data and identity | Razorpay | Scheduled jobs | Data policy |
| --- | --- | --- | --- | --- |
| Local Development | Dedicated local/development database and Clerk development instance | Test Mode only when billing is exercised | No automatic Vercel schedule; invoke protected routes manually | Synthetic or approved development data only |
| Automated Test | Dedicated disposable PostgreSQL test database; Clerk is mocked where needed | Test/fake configuration supplied by the test harness | None | Disposable fixtures only |
| Preview | Database and Clerk development instance isolated from Production | Test Mode with a Preview-only webhook secret | Vercel does not schedule Preview cron jobs; invoke the protected Preview route manually | Demo or approved sanitized data only |
| Production | Production database and Clerk production instance | Live Mode with Production-only credentials and webhook secret | `vercel.json` declares schedules for the active Production deployment; verify that they are deployed and enabled | Customer data under the approved access and retention policy |

Preview and Production must have different database fingerprints, Clerk
instances, Razorpay modes and credentials, webhook secrets, and cron secrets.
The detailed proof and release gates are in the
[Workspace billing V2 rollout](./workspace-billing-rollout.md).

### Configuration inventory

This is a name-only inventory. Obtain values from the approved secret manager or
provider dashboard; do not copy values into this document or command output.

| Area | Configuration names |
| --- | --- |
| Application database | `DATABASE_URL`, `ACCELERATE_URL` |
| Direct migration connection | `DIRECT_URL`; GitHub Environment secret `PRODUCTION_DIRECT_DATABASE_URL` is mapped to it by the migration workflow |
| Clerk | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`; sign-in, sign-up, and fallback paths are code-defined rather than environment-defined |
| Razorpay credentials and mode | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_MODE`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_OLD_SECRETS`, `RAZORPAY_DEFAULT_SUBSCRIPTION_CYCLES` |
| Billing release controls | `RAZORPAY_BILLING_WRITES_ENABLED`, `RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED`, `RAZORPAY_LIVE_CANARY_ORG_IDS`, `WORKSPACE_BRANCH_BILLING_V2_ENABLED` |
| Import V2 release controls | `IMPORT_V2_ENABLED`, `IMPORT_MAX_PLANNED_MUTATIONS` |
| Scheduled jobs | `CRON_SECRET` |
| Gemini | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FLASH_MODEL`, `GEMINI_PRO_MODEL`, `GEMINI_IMPORT_MODEL`, `GEMINI_FALLBACK_MODELS` |
| Public application configuration | `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `NEXT_PUBLIC_BUSINESS_ADDRESS`, `NEXT_PUBLIC_GA_MEASUREMENT_ID` |
| Script/deployment context | `BILLING_ENV_FILE`, `VERCEL_ENV`, `NODE_ENV` |

Every `NEXT_PUBLIC_` variable is browser-visible and must contain no secret.
`RAZORPAY_KEY_ID` remains server-only; do not introduce
`NEXT_PUBLIC_RAZORPAY_KEY_ID`.

Environment-variable changes apply only to new Vercel deployments. After any
addition, removal, flag change, or secret rotation, create a new deployment and
verify that deployment before invalidating an old credential. A running local
Next.js process must likewise be restarted. Old deployments can continue using
their original configuration; account for that during rotation and rollback.

## Validation and destructive test-database warning

Use pnpm and retain exact command results:

```text
pnpm install --frozen-lockfile
pnpm prisma generate
pnpm lint
pnpm test
pnpm test:workflow
pnpm build
```

Run more targeted tests while developing, then the broader affected suite. CI
also runs coverage. Browser tests are available through `pnpm test:browser` when
the change affects an end-to-end flow.

> **Destructive database warning:** Vitest loads `.env.test`, checks only that
> `DATABASE_URL` contains the text `test`, and integration-test setup can execute
> `TRUNCATE ... CASCADE` across all application tables. That substring check does
> not prove isolation. Before any integration test, independently verify the
> database host, database name, account, and environment. Never point `.env.test`
> at a shared Development, Preview, staging, or Production database.

CI provisions its own PostgreSQL service, applies migrations with
`pnpm prisma migrate deploy`, and then runs lint, tests, build, and coverage. A
green CI run is required evidence, but it does not prove that external Clerk,
Razorpay, Gemini, Vercel, DNS, backup, or alerting configuration is correct.

## Database migrations

Prisma reads migrations from `prisma/migrations`. Application traffic normally
uses `DATABASE_URL` or `ACCELERATE_URL`; `prisma.config.ts` uses `DIRECT_URL` when
present and otherwise falls back to `DATABASE_URL`.

### Creating and validating a migration

1. Create a migration only against an isolated development database with
   `pnpm prisma migrate dev --name <descriptive-name>`.
2. Inspect the generated SQL, schema diff, indexes, constraints, backfill,
   locking behavior, and compatibility with both the old and new application.
3. Do not rewrite prior migration history. Commit the schema and new migration
   together.
4. Apply from a clean checkout to a disposable Test database with
   `pnpm prisma migrate deploy`.
5. Apply to the isolated Preview database and run the affected tests and smoke
   checks.
6. For destructive, long-running, or contract migrations, use an approved
   expand/backfill/compatible-code/contract sequence. Do not assume an
   application rollback will make an incompatible database schema safe.

The workspace-billing migrations have a specific expansion, backfill, cutover,
and release sequence. Follow the
[Workspace billing V2 rollout](./workspace-billing-rollout.md) rather than
reconstructing that order here.

### Payment identity and resolution-event migration

Migration `20260822090000_payment_type_identity_and_resolution_events` changes
payment identity from `(studentId, periodStart)` to
`(studentId, type, periodStart)` and creates an initially empty immutable
resolution-event ledger. It does not rewrite or delete any `Payment` row and it
does not fabricate events for resolutions that occurred before deployment.

Before applying it to any operator-approved target, record the payment count
and run these read-only checks:

```sql
SELECT COUNT(*) AS payment_count
FROM "Payment";

SELECT
  "studentId",
  "type",
  "periodStart",
  COUNT(*) AS row_count
FROM "Payment"
GROUP BY "studentId", "type", "periodStart"
HAVING COUNT(*) > 1;

SELECT
  "studentId",
  "periodStart",
  COUNT(*) AS row_count,
  COUNT(DISTINCT "type") AS type_count
FROM "Payment"
GROUP BY "studentId", "periodStart"
HAVING COUNT(*) > 1;
```

Both duplicate queries are expected to return zero groups while the old unique
index is still enforced. If either returns rows, stop. Record the exact
conflicting identifiers privately and obtain a separately reviewed data plan;
do not delete, merge, or rewrite payments automatically.

Inspect the actual PostgreSQL objects rather than inferring them from migration
filenames:

```sql
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('Payment', 'PaymentResolutionEvent')
ORDER BY tablename, indexname;

SELECT
  conrelid::regclass::text AS table_name,
  conname,
  contype,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = '"Payment"'::regclass
   OR conrelid = to_regclass('"PaymentResolutionEvent"')
ORDER BY table_name, conname;
```

The migration creates `Payment_studentId_type_periodStart_key` before dropping
`Payment_studentId_periodStart_key`. Immediately afterward, verify all of the
following before allowing payment writes:

- the `Payment` row count exactly equals the recorded pre-migration count;
- the same-type duplicate query still returns zero rows;
- `Payment_studentId_type_periodStart_key` exists and is unique;
- `Payment_studentId_periodStart_key` no longer exists;
- `PaymentResolutionEvent` exists with restrictive payment and branch foreign
  keys, a nullable actor foreign key using `ON DELETE SET NULL`, and indexes on
  `(paymentId, occurredAt, id)` and `(branchId, occurredAt, id)`;
- `SELECT COUNT(*) FROM "PaymentResolutionEvent";` returns zero immediately
  after migration, before the new application accepts resolution writes; and
- `pnpm prisma migrate status` reports a clean migration state.

Rollback has a data-dependent boundary. Before the new application writes an
admission and monthly payment sharing the same student and period start, it may
be possible to restore the old untyped unique constraint. After legitimate
typed-coexistence rows exist, that constraint cannot be restored without a
conflict. Disable payment writes before any rollback attempt, inspect exact
conflicting rows, never delete a legitimate payment merely to make rollback
easier, and prefer rolling the application forward. Any post-write schema
rollback is a controlled data-reconciliation operation requiring separate
operator approval; this repository does not provide an automatic down
migration.

### Production migration procedure

The protected
[`Production Prisma Migration`](../.github/workflows/production-migrate.yml)
GitHub Actions workflow is the repository's supported Production migration
path.

1. Confirm the selected Git ref contains exactly the reviewed migration set.
2. Confirm the GitHub `production` Environment approvals and the
   `PRODUCTION_DIRECT_DATABASE_URL` secret are controlled by the Production
   operators.
3. Verify the target database identity independently. The workflow rejects an
   empty URL and some obvious local/test URL strings, but that is not proof that
   the target is the intended Production database.
4. Take or verify a current recoverable backup according to the operator-owned
   backup procedure. Record its identifier without exposing credentials.
5. Independently review `pnpm prisma migrate status` against the approved direct
   target. The workflow's status step is `continue-on-error`, so it is diagnostic
   output, not a blocking safety gate.
6. Review migration/application compatibility and the required database-first,
   application-first, or staged order for this change.
7. Manually dispatch the workflow and enter its required confirmation phrase.
8. Watch the install, URL guard, status, and `pnpm prisma migrate deploy` steps.
   Stop the release if any output is unexpected.
9. Recheck migration status, database invariants, and application compatibility
   before enabling traffic or release flags.

Do not seed Production. Do not run the workflow merely to discover which
database its secret targets.

## Application deployment

The repository contains CI and a manual database-migration workflow, but it does
not encode the Vercel project, Production branch, domain-promotion policy, or a
complete Production deployment workflow. The operator must confirm the approved
Vercel Git or CLI path before release. See Vercel's official
[Git deployment](https://vercel.com/docs/git) and
[deployment overview](https://vercel.com/docs/deployments/overview).

### Normal release

1. Identify the approved commit and classify schema, environment, cron,
   webhook, billing, and external-provider impact.
2. Require green targeted validation and CI for that commit.
3. Validate the Preview deployment with isolated Preview services. For a schema
   change, confirm the Preview migration from a clean state.
4. Confirm the operator-owned backup, monitoring, incident, and rollback
   preconditions that apply.
5. Execute the reviewed application-and-migration sequence. Depending on
   compatibility, that may be database-first, application-first, or a staged
   expand/backfill/compatible-code/contract rollout; do not substitute this
   numbered list for the change-specific order.
6. Deploy or promote only the exact approved artifacts using the
   operator-approved Vercel path.
7. Verify the deployment ID, commit, domains, environment scope, migration
   state, authenticated owner and restricted-staff flows, tenant isolation, and
   affected business behavior.
8. Check runtime logs and operator-owned alerts for the observation window.
9. Enable billing or other release flags only in separately observed
   deployments when the change-specific runbook requires staged gates.

Do not treat a successful build or domain assignment as a successful release.

## Import Assistance V2 rollout

The repository pins `workflow` 4.6.0 and implements opaque-ID Workflow
orchestration over an application-visible PostgreSQL ledger. The architecture
proposal is
[`0001-managed-workflow-for-import-execution.md`](./decisions/0001-managed-workflow-for-import-execution.md),
whose status remains **Proposed**. Code presence, a green build, or a deployed
migration does not approve Production execution. A human owner must explicitly
approve the decision and the security/data-residency review before enabling the
feature.

The PostgreSQL ledger—not Workflow state—is business truth for branch scope,
requesting user, target revision, immutable plan hash, deterministic item keys,
leases, retries, cancellation, progress, and redacted outcomes. Workflow inputs
and step outputs contain opaque run IDs and bounded counters only. A step may
claim at most 25 items; each item rechecks current authorization, entitlement,
branch writability, object scope, plan revision, and lease inside the same short
transaction as the domain mutation and completion marker. No import mode is a
whole-file transaction, and cleanup is not rollback.

### Required evidence before enabling

1. Keep `IMPORT_V2_ENABLED=false` or absent. Apply the additive V2 migration
   through the normal reviewed migration path and confirm old application code
   remains compatible. Verify unfinished V1 sessions are archived and receive
   the migration's 30-day purge deadline; do not rewrite terminal V1 history.
2. In an isolated Preview environment, verify `workflow` 4.6.0, the Next.js
   Workflow build integration, provider-authenticated internal endpoint, Fluid
   Compute/runtime configuration, deployment pinning, retry/resume behavior,
   provider operator access, and actual orchestration-data retention/region.
   The Proposed ADR records `iad1` for stable Workflow v4, but the operator must
   verify current provider truth instead of relying on that statement.
3. Complete and approve the personal-data review. Prove Workflow receives only
   opaque IDs/revisions/hashes/cursors/counts while source rows, personal
   values, branch configuration, and complete mutation payloads remain in the
   authorized PostgreSQL ledger. Use synthetic data for all acceptance and
   benchmark work.
4. Benchmark representative 100-, 500-, and 2,000-row imports, including the
   highest-fan-out approved goal and configuration/allocation/payment cases.
   Record row count, deterministic mutation-item count, analysis duration,
   completion duration, retries, database/runtime usage, and observed
   percentiles. Derive separate owner-approved analysis and completion SLOs;
   do not invent thresholds in configuration or this runbook.
   `pnpm benchmark:import-v2` provides a reproducible synthetic parser and
   immutable-plan expansion baseline. Its output is explicitly compile-only;
   it cannot substitute for staging-equivalent durable execution evidence.
5. Derive `IMPORT_MAX_PLANNED_MUTATIONS` from measured item counts, not the row
   cap. Demonstrate the approved largest workload with at least a further
   two-times passing headroom, record the evidence and owner, then set the
   positive integer cap. A missing/invalid cap or a plan above it must fail
   closed before a run is created.
6. Exercise authentication revocation, tenant/branch mismatch, permission and
   writability changes between items, stale revisions, duplicate idempotency
   keys with same and different request hashes, duplicate Workflow delivery,
   lease expiry, transient retry, permanent failure, cancellation, browser
   resume, provider-terminal attached-run replacement, repair through a new
   revision, and both readiness policies. Use an independently verified
   disposable PostgreSQL target for real V2 mutation-plus-marker and replay
   tests. Confirm already completed items are not duplicated or described as
   rolled back.
   For a deliberately isolated local database, the integration bootstrap may
   use `TEST_DATABASE_URL` only when `TEST_DATABASE_RESET_CONFIRM` exactly
   matches the URL's database name. This opt-in does not remove the operator's
   responsibility to prove the target is disposable before the truncating test
   starts.
7. Exercise the 4.25 MiB request, 4 MiB source, 2,000-row, 64-column, 8 KiB-cell,
   and 32 MiB expanded-workbook limits; signature/encoding failures; malformed
   CSV quotes; duplicate/blank headers; multi-sheet/header selection; PDF beta
   warnings; AI prompt redaction; and recipe write/read redaction.
8. Verify terminal and inactive-draft transitions set `purgeAfter` 30 days out.
   Invoke `/api/cron/imports/daily` with the Preview-only secret; verify bounded
   counts, duplicate delivery, expired waiting/queued/retryable-run
   terminalization, running-lease concurrency, consistent final counters,
   payload/error scrubbing, staging deletion, and retained redacted run history.
   Establish monitoring for overdue staging rather than assuming the declared
   schedule executed.
9. Require green targeted tests, `pnpm test:workflow`, the broader affected
   suite, lint, build, and Preview smoke evidence. Record the approved rollback
   authority, observation window, alerts, and how active runs will be drained
   or cancelled.
10. Deploy the reviewed mutation cap while the flag is still held. Only after
    the evidence and human approvals above, create a separate observed
    deployment with `IMPORT_V2_ENABLED=true`. Verify one synthetic/restricted
    run and its ledger/Workflow/retention telemetry before wider use.

### Disable, rollback, and recovery

- To stop new V2 starts, set `IMPORT_V2_ENABLED=false` and create a new
  deployment. Changing the variable without redeployment does nothing, and the
  flag does not cancel an already-started Workflow run.
- Inspect durable PostgreSQL run/item state before choosing to drain or request
  cancellation. Do not delete Workflow state, run items, plans, idempotency
  keys, or success markers to simulate rollback.
- Workflow runs are deployment-pinned. Application Instant Rollback does not
  stop them, reverse committed domain mutations, reverse the additive schema,
  restore archived V1 drafts, or change the active retention schedule.
- Keep the additive migration in place and prefer a compatible forward fix.
  Before repointing traffic to older code, prove it tolerates the current schema
  and nullable retained run references.
- Disable the import-retention cron separately only when retention itself is
  harmful, then verify the Cron dashboard and track the staging backlog. A
  disabled purge is not a substitute for stopping Workflow execution.
- Recovery means reconciling plan/run/item counts and created entity IDs,
  repairing through a new revision/plan when appropriate, and preserving a
  truthful partial-result history. It does not mean file-wide rollback.

## Vercel Cron Jobs

[`vercel.json`](../vercel.json) defines three HTTP `GET` schedules:

| Path | Schedule | UTC interpretation | Repository behavior |
| --- | --- | --- | --- |
| `/api/cron/payments/daily` | `0 0 * * *` | Daily at 00:00 UTC | Generates due payments for active students using duplicate-safe database writes |
| `/api/cron/billing/hourly` | `0 * * * *` | At minute 0 of every UTC hour | Processes billing deadlines, retries, cancellations/replacements, expired leases, and reconciliation |
| `/api/cron/imports/daily` | `30 0 * * *` | Daily at 00:30 UTC | Drains at most 20 batches of 100 expired staging sessions, terminalizing stale active ledger work before scrubbing retained run-item payloads/errors |

Vercel cron expressions always use UTC and scheduled invocations run only for
Production deployments. Updating, deleting, or adding a schedule requires a
redeployment. See the official [Cron Jobs](https://vercel.com/docs/cron-jobs),
[Cron quickstart](https://vercel.com/docs/cron-jobs/quickstart), and
[Cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
documentation.

All three routes fail closed unless the request carries the exact `CRON_SECRET`
as a Bearer authorization header. Never place the secret in a URL, screenshot,
ticket, shell history, or report. Use an approved client that can set a private
header when manually testing a protected route.

Operational expectations:

- Vercel may deliver a scheduled event more than once or overlap executions.
  The application has duplicate-safe payment creation and durable billing
  idempotency/leases; import retention rechecks explicit deadlines, locks
  attached ledgers, and terminalizes expired active work in a serializable
  transaction. Operators must still inspect errors, runtimes, and overdue
  staging.
- Preview schedules do not run automatically. Invoke the protected Preview
  endpoint manually, verify a `2xx`, and inspect its isolated database and
  runtime logs.
- The payment and import daily responses report processing counts. Import
  retention reports batches, selected sessions, scrubbed run items, purged
  sessions, the exact remaining backlog, and whether the 20-batch ceiling was
  reached. The hourly response reports deadline, retry,
  replacement, and reconciliation counts plus errors. Retain only non-sensitive
  summaries for the release record.
- A `401` indicates missing or mismatched `CRON_SECRET`. A `404` indicates a
  route/deployment mismatch. A `5xx` requires log and state inspection before a
  retry.
- Rerunning either daily job is designed to be idempotent. Import retention
  automatically drains its bounded 20-by-100 window; if `limitReached` is true,
  inspect runtime/database health and the reported `remainingBacklog` before an
  approved manual rerun. A `5xx` means the invocation failed closed and must be
  investigated before retry. For hourly billing,
  retry only after checking durable operation state; ambiguous/manual-review
  billing cases must not be forced through automatically.
- To pause schedules, use the operator-approved Vercel Cron Jobs control and
  verify the dashboard state. Changing `CRON_SECRET` alone is not a clean pause.
- After an Instant Rollback, inspect the Cron Jobs dashboard explicitly. Do not
  assume application rollback, environment rollback, and active schedule state
  changed together.

## Razorpay webhook and billing rollout

The webhook endpoint is `POST /api/razorpay/webhook`. It requires a valid
Razorpay signature over the raw body before processing. The event ID and payload
hash provide durable duplicate detection: retrying the same event and body is
safe; reusing an event ID with a different body is treated as a collision.
Failed processing remains retryable.

### Webhook operations

1. Use separate Test and Live endpoints, credentials, and webhook secrets.
2. Make the endpoint publicly reachable by Razorpay without weakening
   authentication elsewhere. Confirm any Preview Deployment Protection
   exception with the operator.
3. Configure exactly the approved event set in the
   [Workspace billing V2 rollout](./workspace-billing-rollout.md) and
   [Razorpay live-review checklist](./razorpay-live-review.md).
4. Send a provider-signed Test delivery, require `2xx`, and verify one durable
   receipt and provider-authoritative reconciliation.
5. Replay the same event to confirm duplicate handling. Test out-of-order and
   lost-callback recovery in Preview before Production.
6. For secret rotation, add the new current secret and retain old secrets only
   through the owner-approved overlap in `RAZORPAY_WEBHOOK_OLD_SECRETS`. Redeploy,
   verify a signed delivery using the new secret, then remove the old secret and
   redeploy again.

Do not log or retain raw webhook bodies as incident evidence. Use event IDs,
payload hashes, timestamps, processing state, provider entity IDs, and redacted
error categories.

### Billing release controls

Billing changes are deliberately staged by
`RAZORPAY_BILLING_WRITES_ENABLED`,
`RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED`,
`RAZORPAY_LIVE_CANARY_ORG_IDS`, and
`WORKSPACE_BRANCH_BILLING_V2_ENABLED`. An environment-variable change is not
active until a new deployment uses it.

`RAZORPAY_BILLING_WRITES_ENABLED` is not a complete billing kill switch. Signed
webhooks, provider reconciliation, or work already in progress can still change
local state. When a billing incident requires a full worker pause, separately
disable the hourly cron and allow active mutation leases/provider requests to
drain according to the incident decision.

Use the repository scripts as follows:

- `scripts/razorpay-preflight.ts` is read-only and rejects mutation flags. Run
  it for the selected target with explicit expectations from the detailed
  billing runbook.
- `scripts/prepare-workspace-billing-rollout.ts` is a dry run unless `--apply`
  is present. Selecting promotion targets uses
  `--promote=<comma-separated-org-ids>`; selection alone does not apply changes.
- `scripts/audit-legacy-unsupported-method-cancellations.ts` is a dry run unless
  `--apply` is present. Resolve every manual-review row before any apply run.

Retain preflight fingerprints and redacted aggregate reports privately. Never
publish organization, subscription, payment, or credential values. Follow the
full Preview acceptance, Live canary, provider-Dashboard, migration, and flag
sequence in the [Workspace billing V2 rollout](./workspace-billing-rollout.md).

## Rollback and recovery are different operations

| Layer | Safe interpretation |
| --- | --- |
| Application deployment | Vercel Instant Rollback can point Production traffic to a previous deployment artifact. It does not reverse database migrations or external provider actions. Verify configuration and cron state afterward. |
| Environment configuration | Changing a Vercel variable does not change an existing deployment. Set the intended configuration and create a new deployment. A rolled-back artifact can carry stale configuration assumptions. |
| Database | This repository has no down-migration or automatic Production database rollback procedure. Prefer a compatible forward fix. Restore only through the operator-owned, tested backup procedure with explicit approval and a data-loss assessment. |
| Import Workflow | Holding `IMPORT_V2_ENABLED` in a new deployment stops new starts only. Existing deployment-pinned runs must be drained or explicitly cancelled; completed items and the PostgreSQL ledger are not rolled back. |
| Razorpay | An application rollback does not cancel, refund, or reverse provider subscriptions, mandates, invoices, payments, or webhook delivery. Reconcile provider and local state; ambiguous cases require manual review. |
| Scheduled jobs | Disable or update schedules through the approved Vercel control, then verify the active Cron Jobs dashboard. Do not assume deployment rollback paused them. |

Vercel's official
[Production rollback guidance](https://vercel.com/docs/deployments/rollback-production-deployment)
describes repointing traffic to a previous deployment. It does not reverse this
application's database migrations or provider actions. Before using it, prove
that the previous application is compatible with the current database schema
and provider state.

### Rollback decision

1. Identify whether the failure is in application code, schema/data,
   environment, scheduled work, or an external provider.
2. Stop new harmful work with the narrowest verified control.
3. Confirm old-code/current-schema compatibility before application rollback.
4. Preserve evidence and record the exact deployment and database state.
5. Choose application rollback, new fixed deployment, forward database repair,
   or approved backup restore. Do not combine them without an explicit sequence.
6. Verify tenant access, billing entitlements, webhook processing, scheduled
   jobs, and provider reconciliation before declaring recovery.

## Incident procedure

### Declare and assess

1. Assign the incident commander and record all times in UTC.
2. Record the current commit, Vercel deployment ID, domains, recent migration
   workflow runs, changed environment names, and affected routes or tenants.
3. Classify impact: authentication/authorization, cross-tenant access, data
   integrity, database availability, billing/provider state, secret exposure,
   cron backlog, or AI/vendor data flow.
4. Start the approved private incident record. Do not include secrets or raw
   customer data.

### Contain

- For a bad but schema-compatible application deployment, use the approved
  Vercel rollback or deploy a fixed artifact, then verify current database and
  provider compatibility.
- For a billing incident, deploy with billing writes held, remove any canary
  allowlist, separately disable the hourly cron when required, and let in-flight
  leases settle. Continue accepting valid signed webhooks unless the incident
  commander determines webhook processing itself is harmful; provider evidence
  is needed for reconciliation.
- For an import execution incident, deploy with `IMPORT_V2_ENABLED=false`,
  inspect the PostgreSQL ledger, and decide explicitly whether active
  deployment-pinned runs drain or receive cancellation requests. Disable the
  import-retention cron separately only when purging is implicated. Preserve
  immutable plans, idempotency keys, completion markers, and redacted results;
  do not delete rows or run ad hoc cleanup to claim rollback.
- For a runaway or compromised cron, disable Vercel Cron Jobs through the
  approved dashboard procedure. Rotate `CRON_SECRET` and redeploy if the secret
  was exposed.
- For a credential incident, create/rotate at the provider, update the narrowly
  scoped Vercel environment, redeploy, verify the new deployment, then revoke
  the old credential. Handle webhook overlap using the approved bounded window.
- For a database incident, stop harmful writes using the operator-owned traffic
  or database control, take a forensic backup, and engage the database owner.
  The repository has no global maintenance-mode or read-only switch.

Do not automatically refund charges, delete webhook receipts, clear billing
operations, edit migration history, or run ad hoc Production SQL during
containment.

### Evidence to retain privately

- Vercel deployment/build/runtime logs and Cron invocation summaries;
- GitHub CI and Production migration workflow run IDs and logs;
- migration status and approved database backup identifiers;
- billing operation, subscription history, invoice, and webhook receipt IDs,
  hashes, timestamps, and redacted errors;
- import session/run IDs, target revision, plan/request hashes, item/progress
  counts, Workflow run ID, lease/retry/cancellation timestamps, retention-cron
  counts, and redacted error codes—never source rows or mutation payloads;
- Razorpay subscription, invoice, payment, webhook-delivery, and Dashboard audit
  evidence; and
- actor/time records from the relevant application audit trail.

Repository evidence is incomplete on its own: there is no repository-defined
health endpoint, centralized log sink, alert routing, status page, or log
retention policy. The operator-owned monitoring and communications procedures
must fill those gaps.

### Recover and verify

1. Confirm the intended deployment, environment scope, domains, and migration
   status.
2. Confirm database invariants and that no unresolved migration or restore work
   remains.
3. Smoke-test sign-in, owner access, restricted-staff access, entitlement
   enforcement, and foreign-tenant denial with approved non-Production or
   restricted Production accounts.
4. Verify affected public routes and API responses without exposing internal
   errors.
5. For cron incidents, invoke each affected protected route once through the
   approved private client, inspect `2xx` metrics and errors, and confirm the
   intended schedule/dashboard state.
6. For billing incidents, verify a signed webhook, duplicate handling,
   subscription/invoice/payment cross-linkage, `paidThrough`, entitlements,
   queued operations, leases, and provider reconciliation. Restart with one
   reviewed canary before broad writes.
7. For import incidents, verify the feature gate deployment, current
   revision/plan hash, run and item counts, duplicate-safe replay, active leases,
   cancellation state, redacted results, staging deadline, and retention-cron
   health. Repair only through a new revision and plan.
8. Observe operator-owned logs and alerts for the approved recovery window.
9. Record residual risk, customer impact, follow-up owners, and any approved
   decision in `docs/decisions/`.

## Release and incident record template

Record the following without values or customer data:

```text
UTC start/end:
Operator / incident commander:
Approved commit and Vercel deployment ID:
Environment:
Migration workflow run and migration names:
Backup identifier and restore-test date:
Configuration names changed (names only):
Cron/webhook/billing/import Workflow impact:
Validation commands and results:
Smoke checks and observation window:
Rollback/recovery decision:
Remaining risks and owners:
```

## Related repository guidance

- [Workspace billing V2 rollout](./workspace-billing-rollout.md)
- [Razorpay live-review checklist](./razorpay-live-review.md)
- [Auth environments](./auth-environments.md)
- [Import Workflow execution proposal](./decisions/0001-managed-workflow-for-import-execution.md) — Proposed, not Accepted
- [CI workflow](../.github/workflows/ci.yml)
- [Production migration workflow](../.github/workflows/production-migrate.yml)
- [Vercel cron configuration](../vercel.json)
