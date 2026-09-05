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
- `git diff --check`: passed. Broader `pnpm test`: 249 files, 1,913 tests passed.

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

Slice A was committed locally as `e5c211b`.

## Slice B dispatch hardening

#4 now records the replacement protocol before fallible provider reads, freezes
the provider scheduling tuple before dispatch, and records one-time admission
under the organization lease and exact attempt. An accepted response binds its
provider ID before local candidate finalization. Recovery through both the
service and owner API is read-only: it adopts one exact uncharged CREATED
candidate and records an immutable adopted-resolution audit. Empty discovery,
duplicates, authorized/charged objects, and old attempts without dispatch proof
remain manual review. No duplicate is automatically cancelled. New client keys
cannot bypass unresolved replacement work. A known pre-dispatch read failure
remains retryable after the existing source-state checks.

#5 has a separate source-cancellation processing attempt, expiry classification,
exact finalization fence, and immutable admission audit. Response loss, failed
local finalization, and expired workers do not resubmit cancellation. Candidate
reconciliation cannot clear that action; the immutable audit also prevents replay
after unrelated lifecycle/error fields change. Confirmed successful scheduling
is retained and repeated calls return that result. Ambiguous source outcomes
remain held: a dedicated source-evidence recovery/finalization path is still
unfinished, so #5 is recorded as open/partial rather than fully closed against
the sprint's confirmed-result recovery requirement.

No billing schema, pricing, trial, environment, or provider configuration change.
No provider network calls were made by these tests. Existing fake Razorpay
interfaces drive real PostgreSQL fault-injection and ownership checks.

Review corrections addressed a pre-dispatch retry regression, candidate
reconciliation clearing the source fence, and a missing successful-recovery
audit. Test cleanup was fixed after a leaked method spy affected subsequent
tests; a unit transaction mock was extended for the new audit read. No test
expectation was weakened.

Validation:

- `pnpm test tests/integration/services/billing-mutation.test.ts`: 52 passed
  before adding the final successful source-cancellation control.
- `pnpm test billing`: 33 files, 398 tests passed before that final control.
- `pnpm lint`: passed, two generated Workflow/coverage warnings.
- `pnpm exec tsc --noEmit --pretty false`: passed after correcting a nullable
  result assertion in the new test.
- `pnpm build`: passed, including TypeScript and both import Workflow manifests;
  initial sandbox build failed on Workflow parent-directory access and the
  approved rerun succeeded with the isolated database override.
- Final `pnpm test`: **249 files, 1,922 tests passed**, including the new
  successful source-cancellation control (272.80 seconds).
- Final `pnpm test:workflow`: 1 passed.
- Final `pnpm exec tsc --noEmit --pretty false` and `git diff --check`: passed.

The disposable container `lab-lords-hardening-20260905` remains available on
loopback port `55439`; the user's original `lab_lords` container was not used or
changed. Test databases created here are `lab_lords_hardening_test`,
`lab_lords_hardening_fixture_test`, and `lab_lords_hardening_fresh_test`.
Reconfirm the container and database identity before reusing them. The test
invocation used process overrides, without editing environment files:

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55439/lab_lords_hardening_test'
$env:TEST_DATABASE_RESET_CONFIRM='lab_lords_hardening_test'
$env:ACCELERATE_URL=''
pnpm test
```

## Findings checkpoint

| Finding | Status | Continuation |
| --- | --- | --- |
| #1 Legacy creation | Fixed | Canonical V2 onboarding; retired alternate creator. |
| #2 Foreign bulk target | Fixed | Same-branch validation and database constraints. |
| #3 Arbitrary/incomplete manual set | Fixed | Exact transactional set, bundle release, serializable concurrency. |
| #4 Replacement create replay | Fixed | Durable admission, frozen intent, fenced read-only recovery. |
| #5 Source cancellation ambiguity | Open / partial | Replay fenced; add source-specific read-only confirmed-result recovery. |
| #6 Checkout retirement | Open, confirmed | Local CREATED retirement can race provider authorization. |
| #7 Replacement viability | Open, confirmed | Separate current negative lifecycle projection from paid entitlement; validate fresh candidate evidence before source cancellation. |
| #8 Legacy cancellation | Open, confirmed | Preserve client key through durable handling; remove unfenced compensation. |
| #9 Full-day overlap | Open | Not implemented in this run. |
| #10 Allocated MultiShift edits | Open | Not implemented in this run. |
| #11 Staff projection entitlement | Open | Not implemented in this run. |
| #12 WhatsApp message deduplication | Open | Not implemented in this run. |
| #13 AI ownership fencing | Open | Not implemented in this run. |
| #14 AI payment-derived response | Open | Not implemented in this run. |
| #15 Draft generation ownership | Open | Not implemented in this run. |
| #16 Bounded analytics dates | Open | Not implemented in this run. |
| #17 Import payment aliases | Open | Not implemented in this run. |

No finding is classified as already fixed at baseline. Items #9–17 retain the
user's audit status and have not received the same focused confirmation as A/B.

Next work: finish #5 recovery without trusting candidate authorization or an
absent provider match, then #6–8. Razorpay HALTED is recoverable and must not be
treated as universally terminal. Provider docs consulted:
[subscription states](https://razorpay.com/docs/payments/subscriptions/states/)
and [cancellation API](https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/).
No documented conditional cancellation guarantee was established. Keep the
subsequent C/D ordering from the opening sequence.

The allocation migration and application require coordinated writer drain,
preflight counts, verified backfill, constraints, and deployment as documented
in the runbook. Billing protocol rollout also requires draining old mutators
and inventorying their unresolved source actions. Production inventory,
migration, operational recovery, provider mutations, and deployment all remain
approval-dependent and were not performed. No Production readiness claim is
made while these findings and rollout gates remain open.
