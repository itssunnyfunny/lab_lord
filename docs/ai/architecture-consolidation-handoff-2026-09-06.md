# Architecture consolidation handoff — 2026-09-06

Subsequent authenticated/visual checks, scoped release fixes and rollout gates
are recorded in the [release-candidate verification](release-candidate-verification-2026-09-06.md).
The command results below remain the original consolidation evidence.

Local implementation is complete against A–F, with the explicitly permitted
Production evidence gates below. No Production migration, data/configuration
change, push, deployment, provider mutation or external-account deletion occurred.

| Outcome | Status | Delivered evidence |
| --- | --- | --- |
| A Tenant integrity | Complete locally | 166 owning relationships in [coverage matrix](tenant-relationship-coverage.md), installed-catalog check, scoped FKs/checks, typed staged/run/retained-plan targets, direct SQL rejection and valid/bad history fixtures |
| B Canonical commercial flow | Local consolidation complete; final historical retirement evidence-gated | Explicit V2 onboarding and once-per-owner trial; removed unused commercial dispatcher; one cancellation engine; historical policy isolated with exact retirement conditions in [commercial contracts](commercial-consolidation-contracts.md) |
| C Billing mutation protocol | Complete locally | All ten subscription-changing calls through immutable durable per-action admission, UNKNOWN holds and independent source/candidate evidence; enforceable adapter/import boundary and fault injection |
| D Shared authorization | Complete locally | Server-derived contexts, one role/override policy, delegating owner/staff facades, protected projections/analytics and direct AI rechecks; owner/manager/restricted/foreign/forged/revoked/entitlement/read-only tests |
| E Ownership/replay | Complete locally | Existing AI/WhatsApp/Workflow mechanisms retained; analysis token/revision fencing added; unused unfenced V1 executor removed; [actual fields/predicates/tests](access-and-worker-contracts.md) |
| F Bootstrap/cutover | Local bootstrap and executable plan complete; Production choice evidence-gated | 48 maintained migrations applied to a newly created empty database; repeat bootstrap passes; exact inventory/preflights, writer drain, identity preservation, cutover conditions and forward-repair procedures in [runbook](../production-runbook.md) |

Implementation commits, in order after the preserved hardening head `6ee00d0`:

- `002f4be` — operational tenant relationships.
- `5ff00a6` — billing/WhatsApp tenant relationships.
- `d70f4d0` — import provenance and persisted targets.
- `dfaf566` — durable SaaS provider-action dispatch and commercial compatibility.
- `f8ff8d8` — shared access, analysis fencing, retained-plan targets and bootstrap.

The subsequent handoff commit records final validation and a trailing-blank-line
cleanup only. The original six hardening commits remain in history; no branch
switch or baseline checkout was performed.

Changes are concentrated in `services/`, protected API callers, AI orchestration,
import services/Workflow, `prisma/schema.prisma` plus seven additive migrations,
targeted unit/integration/migration tests and canonical documentation. Removed
paths are the unused commercial-version dispatcher, duplicate cancellation
entry points, uncalled V1 ImportCommitService with its isolated tests, unused
organization getter, and two obsolete unscoped AI verification scripts. The
active Workflow executor and payment-cycle/authorization/atomicity regressions
remain; historical import and billing records were not removed.

Final command evidence:

| Command / verification | Result |
| --- | --- |
| `pnpm test --pool=forks --maxWorkers=1` | **Exit 0: 266 files, 1,992 tests passed**, 516.18 seconds. Complete invocation; no exclusions, skipped tests or retries added. One fork worker avoids concurrent database resets and reduces Windows worker startup pressure |
| `pnpm test:workflow` | Exit 0: 1 file, 1 durable bounded-replay test passed |
| Targeted policy/tenant/caller run | 148 passing tests; one new fixture ordering assertion corrected without changing constraints |
| `pnpm test import-target-migration --pool=forks --maxWorkers=1` | Exit 0: 6 tests passed, including retained-plan migration/blocker cases |
| `pnpm test billing-dispatch-boundary billing-provider-action billing-mutation billing-replacement --pool=forks --maxWorkers=1` | Exit 0: 3 matching files, 70 tests passed after unused provider-client variable cleanup |
| `pnpm exec tsc --noEmit --pretty false` | Exit 0 |
| `pnpm lint` | Exit 0; no errors, two unused-disable warnings in generated Workflow/coverage JavaScript |
| `pnpm build` | Exit 0, optimized compilation and TypeScript successful; manifest verifier found both import workflows. Local bundler required normal filesystem access after sandbox parent-path denial |
| `pnpm exec node node_modules/prisma/build/index.js validate` / `generate` / `migrate deploy` | Exit 0 against verified isolated target. Expected Prisma SET NULL warnings reflect PostgreSQL column-specific deletion SQL; retained scope is tested |
| `pnpm exec node scripts/bootstrap-isolated-database.mjs` | Exit 0 twice on new `lab_lords_final_fresh_test`, loopback port 55439: 48 migrations, required billing identity, validated constraints, no sample/customer/provider records |
| Cutover inventory and tenant/import/billing preflight SQL | Executed successfully on isolated fresh rehearsal databases; zero foreign-plan blockers; no Production queries |
| Local documentation link check | Seven canonical/contract documents checked; zero broken local links |
| Final `git diff --check` and staged check | Exit 0 after removing one trailing blank line identified when newly created files were staged |
| `pnpm test:browser` with `PLAYWRIGHT_BASE_URL=http://localhost:3106` | **Exit 1: 26 passed, 2 visual comparisons failed, 118 skipped**. Existing desktop/mobile harness; no new test platform |

The browser's accessibility, responsive layout, navigation, public pricing and
trust-link checks passed. Both visual failures compare stored serif baselines
against current configured sans-serif rendering. Inspected actual/expected/diff
images; `git diff 6ee00d0` shows no change to the public landing page, root layout,
global stylesheet, `styles/` or stored public visual baselines. The subsequent
release verification separately changed four dashboard label colors; that fix
does not alter this public typography diagnosis. No baselines were regenerated
to hide the difference. Authenticated
role/import/billing/WhatsApp/browser fixtures and the Clerk redirect prerequisites
were unavailable, so their existing conditional skips remain. Live provider
behavior was not exercised; mocked provider and database/service tests do not
substitute for an authorized canary.

Earlier incomplete/failed attempts are not called clean passes: caller mocks and
foreign-resource assertions needed migration, one added test expected the wrong
existing organization error code, one fixture depended on database collation,
and a thread-pool attempt was interrupted. The final complete fork invocation
above supersedes those attempts without weakening domain or security assertions.

Rollout requires the matching Prisma client/application/Workflow code, preflight
counts, verified backups and a drain of old billing/import/WhatsApp writers.
Required new scope columns, action admissions and analysis tokens cannot overlap
old writers. Preserve nullable history, typed target snapshots, immutable action
receipts and provider/local identity mappings. After new external effects,
blind database restore or old-dispatch rollback can lose replay evidence; close
writers and forward-repair instead. No package versions or persisted environment
configuration changed.

Remaining decisions: authorized Production inventory, disposition of legitimate
LEGACY workspaces and provider obligations, migrate-existing versus fresh
cutover, authenticated browser fixtures, visual baseline review and approved
provider canaries. The existing daily-dues cron writability discrepancy remains
recorded for its human policy owner. Anniversary dues, later unpaid monthly dues,
student lifecycle, allocation/bundle guard, current pricing/trials, historical
access and conservative provider-authoritative recovery are intentionally retained.
ADR 0005 remains Proposed; local tests do not establish Production readiness.
