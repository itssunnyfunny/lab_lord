# Architecture consolidation execution matrix

Start: `6ee00d0`, main, clean worktree. Retain all six hardening commits and
their regressions. No Production, provider mutations, push, deployment or
historical reset. New disposable database: `lab_lords_architecture_test` on the
verified local hardening container, loopback 55439.

| Outcome | Current evidence | Gap | Implementation | Validation |
| --- | --- | --- | --- | --- |
| A Tenant integrity | Allocation composite FKs; most other models have independent IDs | Payment/history, fee source, component, draft, billing, import and WhatsApp links need full coverage | In progress: scoped FKs and explicit historical-data blockers; coverage matrix follows actual relationships | Direct PostgreSQL mixed-parent rejection, supported history, blocker rollback |
| B Canonical commercial flow | V2-only onboarding and disabled alternate organization creator; legacy access retained | Inventory/remove unused paths and isolate historical compatibility | Pending | Creation/flag controls; historical access preserved |
| C Billing protocol | Durable admission in initial, replacement and generic mutation services | Mutating adapter calls still spread across three services | Pending common dispatch boundary and enforceable import rule | Response loss, stale ownership, independent actions, confirmed-result reuse |
| D Authorization | StaffService, entitlement and owner helpers exist | Policy composition remains duplicated | Pending canonical server-derived policy and caller migration | Role/override/entitlement/writability parity, system exceptions |
| E Work ownership | AI tokens, WhatsApp receipts and import leases exist | Verify remaining publication/cleanup predicates and event scope | Pending bounded contract mapping and missing fences | Takeover, redelivery, durable progress |
| F Bootstrap/cutover | 41-migration fresh rehearsal and blocker fixtures retained | Repeatable safe bootstrap, complete preflight and migration-vs-fresh decision conditions | Pending; Production choice evidence-gated | New empty database, upgrade fixtures, clean complete test invocation |

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
