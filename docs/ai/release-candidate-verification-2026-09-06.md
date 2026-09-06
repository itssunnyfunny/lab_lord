# Release candidate verification — 2026-09-06

Baseline code anchor: `ac639e95055bec83393d268567bace6bc5a3e4f8` on `main`.
The owner subsequently gave direct approval to stage and commit only the 11
intended release-verification files locally. This approval excludes push, merge,
deployment, Production access/change and external provider mutation. The six
changed application/browser source files were rechecked against manifest SHA-256
`3903a7feb491a7a05e4bb442733bc18dba089a917ccaf1ca64d13525e8c14e25`
(sorted relative path + NUL + file bytes + NUL for each file). Final Git status
and the resulting local release-candidate commit SHA belong in the completion response.
This pass changes browser tests/documentation and four dashboard label colors.
Services, schema, migrations, dependencies and persisted environment files are unchanged.
All 17 hardening fixes and A–F remain in history. ADR 0005 remains Proposed.

## Evidence and boundaries

The user authorized local fixtures/commits and bounded read-only Production
inspection. No push, deployment, Production query or mutation, provider billing
mutation, external account creation/deletion, or existing database reset occurred.
Clerk sign-ins used two explicitly supplied development test identities and the
normal email-code form. Those sign-ins are real authentication, not billing
provider canaries. Session files remain in ignored `.clerk/`; never commit them.

The independently checked loopback PostgreSQL container on port 55439 supplied
two isolated targets. Newly created `lab_lords_release_candidate_test` received
all 48 migrations and was used solely for the disposable regression fixtures.
The previously empty `lab_lords_final_fresh_test` received synthetic browser
fixtures without a reset. It now contains test data and is **no longer an empty
bootstrap target**. Do not run the empty-bootstrap wrapper against it.

The browser server used explicit DATABASE_URL/DIRECT_URL and empty ACCELERATE_URL.
Real import rehearsal additionally used process-only IMPORT_V2_ENABLED=true,
IMPORT_MAX_PLANNED_MUTATIONS=10 and empty GEMINI_API_KEY. The initial 503 responses
with the import flag/cap absent were correct configuration holds; they did not
justify weakening either check. No external Gemini request was made.

## Authenticated browser evidence

The normal Clerk form required keyboard events for its segmented OTP input.
After first sign-in, `/app` routed the new account to `/onboarding`. The UI
completed the four-step canonical flow; POST /api/onboarding returned 201 and
redirected to the new branch. SQL independently confirmed WORKSPACE_V2, one
owner trial grant, one branch, five seats and three default shifts.

A student was created through the UI (201). Additional real browser/API tests
cover seat creation, shift listing, student admission with allocation, persisted
student reload, branch page navigation, owner billing access, foreign/missing
response equality, and restricted STAFF with an explicit VIEW_PAYMENTS denial.
The STAFF fixture can read students but payment/staff/analytics endpoints return
only an error object; owner billing returns generic 404. UI navigation must hide
Payments and Staff. These requests use real Clerk-issued tokens and normal
server authorization; no API/provider mocks are installed in
`tests/browser/release-candidate.spec.ts`.

The real single-row import used authenticated HTTP from the browser, deterministic
mapping fallback, the actual local Workflow runtime and PostgreSQL. Analysis
reached READY_TO_COMMIT at revision 1. A reviewed plan was explicitly confirmed;
commit returned 202 with a Workflow attachment. SQL confirmed both runs COMPLETED,
one committed item and one imported student. No replay was issued when a browser
poll lost its session. Result-page/reload evidence is recorded with final commands
below. This proves local Workflow behavior, not hosted Vercel Workflow operation.

Existing billing/import UI cases use real Clerk authentication **and mocked API /
Razorpay state**. They exercise trial versus paid presentation, future mandate
authorization, non-dismissible payment warnings, unknown checkout failure,
pending eMandate replacement, workbook/header review and persisted-results UI.
They are not evidence of real Razorpay settlement or webhook delivery.

Harness defects fixed:

- Refresh saved short-lived Clerk authentication from a public page before a
  server-protected navigation; fail explicitly if the real session is absent.
- Bind billing tests to PLAYWRIGHT_OWNER_ORG_ID so the real server layout can
  authorize the fixture instead of redirecting away from a fictitious tenant.
- Scope a repeated billing date and the import error alert; Next's route announcer
  is also an alert. Check the current billing recovery action and the existing
  replacement date format. No product copy or typography changed.
- Add two opt-in real tenant/permission/operation tests. Their isolated fixture
  confirmation is a guard, not a substitute for checking the server database.

The final broader dashboard axe run exposed a real desktop contrast defect:
collection-summary labels used text-gray-500 (#6a7282), measuring 4.02:1 against
the panel background. Four adjacent labels in `app/branch/[branchId]/page.tsx`
now use the existing --ui-text-muted token (#8b93a3). This is the sole application
fix; the analytics authorization guard and all collection calculations are
unchanged. The existing desktop/mobile axe test verifies the correction.

The initial complete browser run produced 28 passes, two visual failures and
116 skips (128.56 seconds, zero retries). Earlier 26/2/118 is historical: loading
the existing TEST Clerk keys into the Playwright process exercised both public
authentication redirects. Subsequent targeted authenticated results supersede
the relevant missing-fixture skips, not every skip in the original suite.

| Skip classification | Disposition |
| --- | --- |
| Release-critical, exercised | Real development sign-in/redirect, V2 onboarding, owner operations, restricted complete payload denial, foreign access, local import analysis/commit and billing access; exact final results below |
| Equivalent regression evidence | Exhaustive role/override/entitlement/revocation combinations: access-policy, branch-access, generation-callers and tenant-safe route/service tests; billing ambiguity/replay: billing-provider-action, billing-mutation and webhook suites; import atomicity/replay: import-commit-flow, runner/executor and Workflow suite |
| Still environment-dependent | Full manager/read-only visual/accessibility matrix and mobile private journeys need matching role fixtures; hosted Workflow and external billing/Meta behavior need their own approved environment/canaries. Existing mocks cannot close those gates |
| Conditional feature gate | WhatsApp settings/collections/reports scenarios (24 initial skips) are required before enabling those capabilities; they are not a core-release prerequisite only if the owner verifies all corresponding Production capabilities remain held. Their current Production flag values are unknown |
| Not a zero-skip target | Desktop-only Clerk profile contrast need not be duplicated on mobile. Broader keyboard/a11y matrices remain follow-up after representative authenticated paths; no tests were skipped merely to make a result green |

## Visual diagnosis

Both existing baselines originated at `8228b644f1160cc4da54788671e96029dd6627ea`.
The later typography commit `7f0c36fd000656f9e6402f162047c092648ade49` switched
the application from the older Geist/token setup to Inter/Manrope without updating
those images. The stored images render serif text; actual images render the
configured sans-serif typography. `git diff 6ee00d0` shows no changes to the public
landing page (`app/page.tsx`), root layout (`app/layout.tsx`), global stylesheet
(`app/globals.css`), `styles/` or stored public visual baselines. Separately, four
dashboard label colors changed in `app/branch/[branchId]/page.tsx` as described
above; the public typography/baseline diagnosis does not describe that fix.

Reproduced in installed Chromium 151.0.7922.34 on Windows: desktop 1440×900,
DPR 1; Pixel 7 context overridden to 390×844, DPR 2.625; reduced motion and the
existing full-page screenshot settings. `document.fonts.ready` completed;
Inter and Manrope were loaded, with four successful font responses per context.
Actual/expected/diff images were inspected. This is a **stale baseline**, not a
current font-availability failure or demonstrated A–F UI regression. Original
baseline capture conditions cannot be reconstructed completely from the images.

No baseline was regenerated. Owner decision: approve the existing Inter/Manrope
rendering and then review replacement desktop/mobile baselines, or identify a
specific unintended visual difference. That visual approval is separate from
the passing public accessibility/reflow/navigation checks. Evidence remains under
ignored `test-results/rc-visual/`; keep those files with the private release record.

## Read-only Production access result

The connected Vercel project matched `.vercel/project.json`: **lab-lords**, with
Production aliases including lablords.in. Read-only project/deployment inspection
reported READY deployment `dpl_FwY17ByZxKgXhnrdPKw3a6wjbhWC`, Production/main,
commit `ca5e9b50b05bff49d81becafe27417a1c343801c`. This is deployment metadata,
not proof of schema, flags, database identity, worker drain or provider state.

The available connector exposes project/deployment metadata but no PostgreSQL
query or environment-secret retrieval capability. Local `.env` / `.env.test`
database settings are loopback; `.env.production.local` and an ambient approved
Production connection were absent. No verified Production database endpoint,
database-resident billing fingerprint or scoped provider account mapping was
available. No remote database was guessed from a project name or hostname.

| Required Production evidence | Result |
| --- | --- |
| Installed/failed migrations, validated constraints and historical preflights | Unknown; no database access |
| Accounts, organizations, branches and all operational table counts | Unknown, **not zero** |
| LEGACY/V2 populations, once-per-owner trials and historical dependencies | Unknown; retain all compatibility |
| Subscriptions, invoices, billing changes/audits/actions and source/replacement mappings | Unknown; retain unresolved evidence |
| Import, AI, billing, WhatsApp in-flight work and actual old invocations | Unknown; expired leases cannot establish drain |
| Required BillingDatabaseIdentity, catalog bindings, sender/template/rate-card configuration | Unknown |
| Razorpay/Meta local-to-provider and unrepresented-object inventory | Not performed: exact Lab Lords account/mode and relevant identity scope unavailable |

Missing capability: operator-provided **named access method** for the verified
Production direct database in read-only mode, together with its independently
confirmed identity; and scoped read-only Razorpay/Meta access tied to that inventory.
Never put credentials in this report. Successful Vercel access does not grant a
database or provider-account identity conclusion.

## Rollout decision and provider gates

Recommend **migrate existing, conditional on clean preflights and proven drain**.
It preserves existing IDs, trial consumption, history and provider receipts.
There is no evidence of a concrete advantage or preservation completeness for a
fresh cutover, so fresh is not recommended. Neither path is authorized to execute.
The operational checklist and count/stop contract are in the
[Production runbook](../production-runbook.md#release-candidate-operation-card--2026-09-06).

| Boundary | Mock / local fault evidence | Actual external evidence in this pass | Remaining smallest approved canary |
| --- | --- | --- | --- |
| Initial subscription / replacement / mutation / cancellation / undo | Durable action admission, immutable request, UNKNOWN hold, confirmed-response reuse, source/candidate independence; DB/service fault injection and adapter boundary tests | None for Razorpay TEST or LIVE | Verified TEST account + isolated DB/org, one initial authorization and exact invoice/captured-payment check; one scheduled change/undo and one replacement/source reconciliation; retain exact action/operation mapping |
| Lost response / stale worker | Fault injection: committed admission followed by timeout/finalizer failure; no second dispatch on another key or lease expiry | None | In an explicitly approved TEST interception, lose one response after admission, verify UNKNOWN and provider-read-only discovery; never provoke ambiguity in LIVE |
| Callback / webhook | Signature, body bound, mode isolation, conflicting event/hash, duplicate/reordered receipt and finalization fencing tests | None | Real TEST callback plus signed webhook/redelivery; confirm receipt dedupe and unchanged entitlement without exact settlement tuple |
| Import | Real local authenticated analysis, reviewed plan, durable commit and PostgreSQL item; failure/replay suite | Local Workflow only; Gemini disabled | Hosted isolated TEST/Preview Workflow start, process interruption/recovery and persisted result, with approved provider/data-processing configuration |
| WhatsApp | Mocked provider + database ownership/consent/delivery/webhook tests in full suite | None | Only if enabling: dedicated approved TEST sender/recipient/consent, one managed Utility send and signed status redelivery, budget/safety hold; use existing runbook procedure |

TEST billing/Meta mutations need explicit separate authorization, exact account /
mode, allowed objects, amount/message cap, callbacks and evidence owner before
starting. LIVE is a separate later approval and remains unexercised. A zero-result
provider list is not proof that no obligations exist; reconcile known IDs and
scope note-based discovery with explicit pagination/time bounds and retain any
unexamined remainder as uncertainty.

No provider API assumption was changed in code. Current official documentation
was checked for [subscription create](https://razorpay.com/docs/api/payments/subscriptions/create-subscription/),
[cancellation](https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/?preferred-country=IN)
and [webhook retry/ordering](https://razorpay.com/docs/webhooks/best-practices/?preferred-country=IN).
Direct markdown fetches for update/undo failed in the browsing adapter; the
unchanged request shapes remain tied to the previous commercial-contract review
and must be confirmed in the approved provider canary. No native subscription
idempotency guarantee is inferred.

## Completion status

Local architecture remains complete. This pass fixed browser-harness defects
and one dashboard contrast defect, with no domain/schema regression. Final command results and
remaining browser limitations are recorded below before the local commit.
Production rollout approval is **not ready** until inventory/preflights, backup /
drain ownership, applicable external canaries and visual disposition are closed.
No Production deployment occurred.

Non-blocking follow-up: broader private mobile/keyboard/contrast coverage where
equivalent authorization evidence is already established. The daily-dues cron
writability discrepancy remains a human policy decision; anniversary dues and
later monthly dues while earlier dues remain unpaid are unchanged. No commercial,
pricing, trial, student-lifecycle or allocation/bundle policy was revised.

## Final command ledger

Playwright invocations used `pnpm exec node` to load only approved Clerk settings
in memory and spawn `node_modules/@playwright/test/cli.js test`, the installed
implementation of `pnpm test:browser`. All runs used localhost:3106, one worker,
zero retries and the existing projects. `--max-failures` stopped exploratory
runs after failures; those runs are explicitly not clean complete passes.

| Command / scope | Evidence |
| --- | --- |
| `pnpm exec node scripts/bootstrap-isolated-database.mjs` | Exit 0; new lab_lords_release_candidate_test, 48 migrations, one required identity, validated constraints, no seeded application records |
| `pnpm test --pool=forks --maxWorkers=1` | **Final source: exit 0, 266 files / 1,992 tests passed, 428.76s**, started 2026-09-06 15:43:38 IST after all code edits. Earlier 470.40s and 599.27s passes remain intermediate evidence, not substitutes for this final run |
| `pnpm test:workflow` | Final source: exit 0, 1 file / 1 test, 5.08s |
| `pnpm exec tsc --noEmit --pretty false` | Final source: exit 0 |
| `pnpm lint` | Final source: exit 0, no errors; two existing unused-disable warnings in generated Workflow/coverage files |
| `pnpm build` | Final source: exit 0; optimized compilation 28.0s, TypeScript pass and two import workflows verified |
| Playwright `release-candidate --project=chromium` | 2 passed, 1.2m: real owner operations/tenant-safe responses/billing and restricted staff payloads. Final sidebar assertion rerun with `--grep 'complete protected'`: 1 passed, 22.7s; asserts the actual visible sidebar and Students link before proving protected links absent |
| Playwright focused billing/import cases | Final six affected cases passed: future authorization, non-dismissible warning, unknown payment.failed, pending eMandate replacement, workbook/header/request-size handling, persisted results/export/recipe UI. Combined invocation also had the earlier owner journey's 60s timeout; it is not claimed as an all-green run. The real journey was subsequently corrected and passed separately |
| Playwright public + owner dashboard matrix | 29 passed, 3 failed, 4 role-fixture skips, 3.5m. Failures: two stale public images and the now-fixed desktop dashboard contrast. Both authentication redirects passed |
| Playwright `authenticated-ui --grep 'Owner authenticated UI.*dashboard loads'` after contrast fix | **2 passed**, desktop and mobile, 51.9s; no serious/critical axe violations and no dashboard-triggered payment ensure/generate request |
| `pnpm exec tsx .clerk/rc-import-inspect.ts` / `rc-import-commit.ts` / `rc-import-result.ts` | Ignored task-local procedures: real analysis and confirmed commit returned 202; both durable runs COMPLETED; reopening result and imported student reload passed. Initial missing flag/cap held correctly; a lost browser poll did not trigger commit replay |
| Local markdown path check | Five changed canonical/report documents, zero broken local paths |
| `git diff --check` | Exit 0 during release verification and the subsequent commit-only review; tested application/browser source manifest unchanged |

Post-rehearsal **local synthetic** counts (not Production): 2 users, 2
organizations, 2 branches, 1 trial grant, 4 students, 9 seats, 4 shifts, 2
allocations, 3 operational payments, 2 staff memberships, 1 import session,
2 completed import runs and 1 successful import item. There are 0 SaaS
subscriptions and 0 BillingProviderAction rows in this browser database.
Failed exploratory assertions left their authorized synthetic fixtures intact;
nothing was deleted to make tests pass. Logs and screenshot evidence remain in
ignored `test-results/rc-evidence`, `rc-visual`, `rc-focused-final`, `rc-real-final`,
`rc-staff-final` and `rc-contrast` directories.

Final state at handoff: local engineering verification complete; source manifest
above unchanged. Direct owner approval resolves the earlier local-commit approval
gate. The commit-only review preserves the final-source test evidence and records
the resulting SHA, staged checks and final Git status in its completion response.
The release candidate contains only the 11 intended source/document files on top
of baseline `ac639e95055bec83393d268567bace6bc5a3e4f8`. The local dev server is stopped.
No push, branch change or deployment is authorized. Production rollout is not
approved or complete; database inventory, provider/canary gates and visual
disposition remain the separate operational blockers described above.
