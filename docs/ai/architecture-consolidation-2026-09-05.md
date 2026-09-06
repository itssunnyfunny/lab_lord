# Architecture consolidation execution matrix

Start: `6ee00d0`, main, clean worktree. Retain all six hardening commits and
their regressions. No Production, provider mutations, push, deployment or
historical reset. New disposable database: `lab_lords_architecture_test` on the
verified local hardening container, loopback 55439.

| Outcome | Current evidence | Gap / condition | Implementation | Validation |
| --- | --- | --- | --- | --- |
| A Tenant integrity | 166 owning relationships inventoried and checked against PostgreSQL | None in implemented tenant relationship scope | Composite keys, scope-presence checks and typed row/run/retained-plan target ledger; historical foreign references block | Direct mixed-parent writes, good/bad upgrade fixtures and installed catalog |
| B Canonical commercial flow | V2-only onboarding, one cancellation/provisioning protocol | Final historical retirement requires authorized data/provider inventory and owner disposition | Unused creation dispatcher removed; necessary legacy access/cancellation policy isolated | Creation/flag controls and historical access tests retained |
| C Billing protocol | All ten subscription mutation sites use durable per-action executor | Provider canary requires separate authorization | Immutable admission, independent outcomes, UNKNOWN replay hold, exact finalizers and AST boundary | Fault injection, delayed evidence, stale ownership, confirmed-result reuse, healthy-source regression |
| D Authorization | Shared AccessPolicy, pure overrides, capability definitions, delegating facades | Daily dues cron policy discrepancy retained for owner decision | Branch/org/billing ownership, interactive analytics, direct AI rechecks, staff projections and import/domain mutations | Owner/manager/staff/foreign, forged/stale context, entitlement and read-only parity |
| E Work ownership | Existing AI/WhatsApp/Workflow protocols retained | External uncertainty remains separate from lease ownership | Added analysis token fencing; removed unused unfenced V1 executor | Late success/failure takeover, inbound replay, item atomicity and durable Workflow replay |
| F Bootstrap/cutover | New empty database applies all 48 migrations and required identity, repeat succeeds | Production migrate-vs-fresh choice remains approval/evidence-gated | Safe local bootstrap, executable restricted inventory/preflights, writer drain and forward-repair plan | Fresh rehearsal and upgrade/blocker fixtures; final complete verification recorded below |


First slice: payments/history, student fee sources, drafts and bundle components
currently permit independent mixed-parent references. Preserve existing branch
ownership, soft deletion, null historical references, dues and bundle-edit guard.
Add scoped keys, backfill only component branch IDs after proving both parents
agree, update component writers, and reject inconsistent history before changes.
No service authorization is removed. Target payment/student/bundle/onboarding,
draft and raw SQL tests; migrations run only in the new disposable database.

Operational tenant slice implemented: seven relationship families now have
composite FKs; nested component writes inherit branchId without duplicating
caller logic. Prisma validate/generate and all 42 migrations passed on the new
database. `pnpm test operational-tenant multiShift payment.test student.test
onboarding.test generation-callers`: 8 files / 109 tests passed. Tests include
sibling and foreign organizations, nullable draft history, all seven bad-data
fixture families and unchanged service flows. `pnpm exec tsc --noEmit --pretty
false` passed. Initial test corrections concerned Prisma adapter error shape,
the newly rejected corrupt-payment fixture and exact preflight reference count;
no integrity constraint or service protection was weakened.

Billing/WhatsApp tenant slice: migration 43 enforces 55 additional scoped foreign
keys and five scope-presence/identity checks. The frozen relationship contract
is `prisma/tenant-relationship-contracts.json`; matching read-only counts are in
`prisma/preflight/billing-and-whatsapp-tenants.sql`. Valid fixtures retain every
row; seven corrupt-history families block atomically. Catalog tests verify all
55 installed keys, validated checks and column-specific nullable deletion.
`pnpm test billing whatsapp`: 90 files passed, two failed (catalog qualification,
now-invalid corrupt fixture, one setup timeout). After correcting assertions,
`pnpm test billing-whatsapp-tenant-migration whatsapp-delivery`: 3 files / 27 tests
passed. Prisma validate/generate, migration deploy and TypeScript passed. The
broader complete invocation remains due at the final milestone.

Import/grouped-payment scope is implemented in migrations 44 and 45: ten more
branch-scoped keys, a question/row/session key and typed ImportTargetReference
rows maintained atomically by PostgreSQL triggers for staged-row output and
run-item input/output IDs. Six target kinds have live scoped foreign keys;
deleted historical targets retain detached snapshots. Bad historical foreign
references block the migration. Grouped WhatsApp payment writers now supply
branchId; import direct bulk writers supply their proven parent branch.
`pnpm test import-tenant importing whatsapp-payment`: 40 files / 269 tests passed.
With target ledger installed, the same affected services passed (39 files), while
one new test needed to update the snapshot ID together with its live ID to reach
the FK rather than the stronger snapshot-identity CHECK. TypeScript passed.
The complete relationship matrix and final combined validation remain due.

Commercial consolidation: every subscription mutation now uses one durable
per-action executor (migration 46), with an enforceable adapter boundary and
separate create/source/candidate outcomes. Recovery acknowledges only its own
action. Cancellation has one service entry point; historical entitlement and
cancellation policies are isolated. The unused commercial-version flag dispatcher
is removed. Exact inventory/protocol/retirement conditions are in
`commercial-consolidation-contracts.md`. `pnpm test billing entitlement onboarding`
passed: 46 files / 486 tests. TypeScript and diff checks passed. Prior focused
failures corrected a unit mock of the replaced boundary, recognized application
methods with similar names, and retained provider discovery before fallback to a
confirmed identity. No provider evidence or rejection protection was weakened.

Authorization/ownership/bootstrap completion: shared policy and protected analytics entry points are implemented; direct AI calls require issued contexts and mutable-policy rechecks. Import analysis uses a five-minute token lease with token/revision publication and cleanup predicates. Retained retry-plan student inputs now share the typed target ledger (migration 48). The inactive V1 import executor, its isolated tests and two obsolete unscoped AI scripts were removed; active Workflow/domain regression tests remain.

`pnpm test import-target-migration` passed 6 tests including retained-plan history/blockers. The other targeted policy/tenant/analytics/caller suites passed 148 tests. All 48 migrations and a repeat bootstrap passed on new `lab_lords_final_fresh_test`. Preflight SQL executed successfully on the isolated rehearsal database. No sample data, provider objects, grants or external accounts were seeded.

Final verification: the complete `pnpm test --pool=forks --maxWorkers=1` invocation passed 266 files / 1,992 tests (exit 0). Workflow replay, TypeScript, lint and Production build/Workflow manifest verification passed. Browser harness: 26 passed, 2 pre-existing visual-baseline mismatches, 118 unavailable-fixture skips. See the [final handoff](architecture-consolidation-handoff-2026-09-06.md) for exact commands, local commits, limitations and rollout requirements.
