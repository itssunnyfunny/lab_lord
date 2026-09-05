# Pre-customer hardening execution note

Baseline: `ca5e9b50b05bff49d81becafe27417a1c343801c`, branch `main`, clean worktree.
No complete pre-change baseline suite was run. Production inventory, customer data, and provider
mandates are unknown; no Production/provider operation is authorized or needed
for local engineering.

Sequence: A (#1–3 creation and allocation boundaries), B (#4–8 durable billing),
C (#11,14,16 authorization and bounded analytics), D (#12,13,15,9,10,17).
Each coherent slice gets targeted tests, documentation, diff review, and a local
commit. Full gates run at milestones. No push or deployment.

## Slice A evidence and contract

- #1 confirmed: organization POST/service omits commercial state and defaults to
  LEGACY. Its client helper has no runtime caller. Canonical onboarding also
  selects LEGACY when the V2 release flag is disabled. Retire the alternate
  creation path; require enabled V2 onboarding and explicitly persist V2 plus
  the selected plan and existing once-per-owner trial. Existing legacy records
  and their deliberate Basic writable fallback stay supported.
- #2 confirmed: bulk shift deletion resolves the target by bare ID.
- #3 confirmed: manual deletion trusts arbitrary allocation IDs, permits an
  incomplete/empty set, and reads source/count outside the mutation transaction.
  Allocation creation already uses serializable transactions, including import
  execution. Deletion must participate in the same concurrency protocol.
- Preserve same-branch ownership, exact active source membership, allocation
  history, bundle representation, capacity/overlap, and at least one active shift.
- Planned tests: disabled creation, canonical V2/trial, foreign targets, invalid
  exact sets, rollback, bundles, and real concurrent allocation/deactivation.
- Evaluate branch-scoped allocation foreign keys separately from authorization;
  never guess a backfill for inconsistent historical rows.

## Approval-dependent operations

Production deployment, migrations, preflight inventory, provider actions, and
legacy data removal require separate approval. None has been performed.

## Slice A implemented and validated

#1–3 implemented, including branch-scoped allocation foreign keys. Consolidated
bulk/manual resolution and the serializable allocation transaction boundary.
Deletion preview accounts for released bundle siblings. The independent review
identified a seed caller branch mismatch and the stale capacity preview; both
were corrected and the preview has a regression test. Seed callers were updated
for the new required column; seed data was not executed or redesigned.

Validation on a newly created Docker PostgreSQL container, bound only to
`127.0.0.1:55439`, with database identity and empty initial tables verified:

- `pnpm test tests/unit/api/organization-creation.route.test.ts`: reproducer
  failed before the fix and passes (2 tests) afterward.
- `pnpm test` with the ten affected integration files: 140 tests passed,
  including raw database foreign-key and pre-change migration fixture checks.
- `pnpm test tests/integration/services/shift-hardening.test.ts
  tests/integration/services/shift.test.ts`: 27 passed after review corrections,
  including controlled post-source-read inserts and concurrent last-shift removal.
- Payment, admission flow, billing-cycle, migration and endpoint checks: 54
  passed on their combined run; the two initially failing synchronization tests
  were corrected to clear PostgreSQL's cached statistics snapshot and then passed.
- `pnpm exec tsc --noEmit --pretty false`: passed.
- `pnpm lint`: passed, with two warnings in generated Workflow/coverage assets.
- `pnpm build`: passed with Workflow manifest verification after sandbox rerun.
  The initial sandbox attempt was blocked by parent-directory filesystem access.
- `pnpm test:workflow`: 1 passed.
- `pnpm exec node node_modules/prisma/build/index.js validate` and `generate`:
  passed. Both `pnpm prisma` and `pnpm exec prisma` failed to resolve the local
  Windows shim, so the same installed CLI was invoked through Node via pnpm.
- `pnpm exec node node_modules/prisma/build/index.js migrate deploy`: all 40
  migrations passed from empty `lab_lords_hardening_fresh_test`; the new migration
  also applied over pre-change application data in `lab_lords_hardening_test`.
  SQL fixture tests separately prove history preservation and blocker rollback.
- `git diff --check`: passed. Broader `pnpm test` is running at this checkpoint.

The documented `pnpm test -- <file>` form unexpectedly ran all files with this
pnpm/Vitest combination against the deliberately unreachable new loopback target.
It was stopped; those connection failures are setup failures, not a baseline
regression result. All subsequent filtering uses `pnpm test <file>`.

## Continuation evidence

The next slice is #4–8. Read-only investigation confirms replacement provisioning
does not update the outer dispatch flag; source cancellation has no durable
processing fence; checkout retirement trusts local CREATED; reconciliation can
return stale candidate lifecycle when commercial evidence is pending; and legacy
cancellation drops the client key and reverses on local-finalization failure.
Current Razorpay lifecycle documentation distinguishes recoverable HALTED from
terminal CANCELLED/COMPLETED/EXPIRED; cancellation has no observed conditional
status precondition. Verify assumptions before modifying those paths.

Remaining #4–17 are open at this checkpoint, not represented as fixed by slice A.
