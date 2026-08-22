# 0001: Managed Workflow for import execution

- Status: Proposed
- Date: 2026-08-18
- Deciders: Pending
- Supersedes: None
- Superseded by: None

## Context

Import commits can expand one reviewed spreadsheet row into configuration,
student, allocation, and multiple payment mutations. A serverless request is not
a reliable execution boundary for that work: browsers disconnect, deployments
change, functions time out, and delivery may be duplicated. The product does
not promise whole-file atomicity, but it must preserve authorization,
idempotency, progress, repairability, and a truthful partial-result history.

Vercel Cron does not provide a non-overlapping retrying queue, and the
self-hosted PostgreSQL Workflow world needs a long-lived worker that this Vercel
deployment does not currently operate. A provider choice also affects cost,
regional data handling, incident response, and portability, so human approval
is required before Production enablement.

## Decision

Use the stable Vercel Workflow 4.x runtime, pinned as `workflow@4.6.0`, for
durable orchestration of Import Assistance V2. PostgreSQL remains the business
system of record for tenant authorization, immutable plans, idempotency,
cancellation requests, mutation items, progress, and redacted outcomes.

Workflow inputs and step outputs contain only opaque run/session identifiers,
revisions, hashes, cursors, and counts. Uploaded source bytes are parsed and
persisted during the initial request and then discarded. Personal row values,
branch configuration, authorization decisions, and complete mutation payloads
are loaded inside bounded steps from the authorized PostgreSQL ledger.

Compile every confirmed plan into deterministic run items. Apply at most 25
items per step; write each domain mutation and its completion marker in the
same short PostgreSQL transaction. Replayed steps skip completed item keys.
Domain mutation primitives accept a Prisma transaction client and retain their
normal validation. Transactions never span Workflow steps, and cleanup is not
used as rollback.

The domain runner remains scheduler-independent so a later approved deployment
can invoke it from a different durable worker. Vercel Cron is used only for the
bounded, authenticated, idempotent staging-retention job, never as the import
worker.

## Alternatives considered

- **One synchronous function request:** simplest operationally, but cannot
  durably continue after a disconnect, timeout, crash, or deployment change.
- **PostgreSQL rows polled by Vercel Cron:** keeps one data store, but scheduled
  delivery can overlap or duplicate and does not provide worker retries or
  sufficiently prompt background progress.
- **Self-hosted PostgreSQL Workflow world:** reduces provider storage coupling,
  but requires an always-running process that is absent from the current
  serverless architecture.
- **Another managed queue/worker provider:** viable portability target, but adds
  another operating surface and was not selected for this release. The ledger
  and runner boundary are intended to keep this option open.

## Consequences

Imports gain durable continuation, bounded retries, deployment-pinned runs, and
provider observability while keeping application-visible truth in PostgreSQL.
The application incurs Vercel Workflow, function, and database usage and is
coupled to the provider's v4 orchestration format. Current published Pro rates
must be reviewed by the owner before enablement; repository code does not treat
pricing as a stable constant. The product proposal used a planning estimate of
`$2.50 / 100,000` Workflow steps and `$0.00069 / GB-hour` of Workflow storage,
excluding function and database usage. Those figures are an explicit cost
assumption, not an approved or durable price, and must be reverified at the
Production decision gate.

No mode promises whole-file rollback. `READY_ROWS_ONLY` continues independent
work after a permanent item failure. `REQUIRE_ALL_ROWS_READY` gates starting the
run and stops scheduling further work after the first permanent runtime
failure; already committed work remains. Repair creates a new revision and
plan, and deterministic item identities prevent duplicate entities.

## Security and data impact

Tenant scope, current membership, permissions, entitlement, branch
writability, configuration identity, and object ownership are rechecked at
plan creation, commit start, and every mutation transaction. A Workflow run ID
is not authorization. Foreign and nonexistent identifiers retain the same
generic response.

Stable Workflow v4 stores orchestration data in Vercel's `iad1` region. Even
though inputs are deliberately non-PII identifiers and counts, Production
enablement requires explicit security and data-residency review, confirmation
that Fluid Compute is configured, and validation of provider retention and
operator access. Failure records contain stable redacted codes, never source
rows, credentials, or exception stacks.

Staging PII is purged 30 days after a terminal state or 30 days of draft
inactivity. Redacted summaries and created entity IDs follow the existing audit
lifecycle. Workflow and Cron credentials remain server-only.

## Rollout and rollback

1. Apply the additive schema migration while V2 starts remain disabled.
2. Archive all unfinished pre-v2 sessions and set their purge deadline 30 days
   later; preserve legacy terminal history read-only.
3. Validate parsing, replay, authorization, failure, repair, cancellation, and
   browser-resume behavior against isolated Test and Preview infrastructure.
4. Obtain provider, security, and data-residency approval and verify Fluid
   Compute.
5. Benchmark 100, 500, and 2,000-row workloads. Configure
   `IMPORT_MAX_PLANNED_MUTATIONS` only from the largest workload with a further
   two-times passing headroom, and record separate analysis and completion SLOs
   from measured percentiles.
6. Deploy with `IMPORT_V2_ENABLED=false`, then enable new sessions in a
   separately observed deployment.

Rollback first disables new starts. Active runs are explicitly cancelled or
allowed to drain based on impact; their PostgreSQL ledger is retained. The
additive schema stays in place because Workflow runs are pinned to the
deployment that started them. An application rollback does not undo completed
domain mutations or Workflow/provider state.

If an attached provider run becomes terminal or disappears while its
PostgreSQL ledger is still active, authorized resume reconciles provider state,
compare-and-set fences the exact old provider ID under the run lock, and starts
a replacement. An active provider run is retained, and provider lookup failure
does not clear ownership.

## Evidence

- [Workflow general availability](https://vercel.com/blog/a-new-programming-model-for-durable-execution)
- [Workflow package](https://www.npmjs.com/package/workflow)
- [Vercel Cron delivery behavior](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [PostgreSQL Workflow world](https://workflow-sdk.dev/worlds/postgres)
- [Vercel Workflow world](https://workflow-sdk.dev/worlds/vercel)
- [Vercel limits and pricing](https://vercel.com/docs/limits)
- `prisma/schema.prisma`
- `importing/services/`
- `importing/workflows/`
- `docs/domain-invariants.md`
- `SECURITY.md`
- `docs/production-runbook.md`

## Approval

Pending explicit human owner review. This proposal is not binding and must not
be marked Accepted by an automated agent.
