# Domain invariants

This document records business behavior that must survive refactors. It is a
bridge between the schema, services, routes, and tests; it is not a substitute
for inspecting them before a change.

Every statement uses one of these labels:

- **Must preserve—enforced**: enforced by the database, current application
  code, or both, and covered by current behavior/tests.
- **Service-layer contract—not DB-enforced**: required behavior enforced by
  normal service paths, but the schema alone cannot protect it. New write paths
  and maintenance scripts must call the service or reproduce the checks and
  transaction semantics.
- **Known discrepancy—do not rely on**: current behavior is inconsistent,
  incomplete, or likely defective. Do not encode it as a product guarantee;
  resolve it deliberately with tests before depending on it.

## Tenant and identity boundaries

- **Must preserve—enforced:** A user is unique by Clerk identity. Email is
  normalized before persistence and is also unique. An email already linked to
  a different Clerk identity must not be silently relinked. Concurrent account
  creation is resolved through the database uniqueness constraint.
  (`prisma/schema.prisma`, `lib/auth.ts`)
- **Must preserve—enforced:** An organization has one owner. A user's branch
  membership is unique for `(userId, branchId)`.
  (`prisma/schema.prisma`, `services/staff.service.ts`)
- **Service-layer contract—not DB-enforced:** Every tenant-owned read and write
  must be scoped through the organization or branch authorized for the current
  user. A globally unique child ID is not evidence that the caller may access
  the child.
- **Service-layer contract—not DB-enforced:** Related student, seat, shift,
  allocation, payment, message, and audit records must belong to the same
  branch. Several models use independent foreign keys or unscoped IDs, so the
  database does not prove this relationship. In particular, do not bypass the
  same-branch checks in the services.
  (`prisma/schema.prisma`, `services/student.service.ts`,
  `services/seatAllocation.service.ts`, `services/payment.service.ts`)
- **Known discrepancy—do not rely on:** Cross-branch mixing is not
  structurally impossible. `SeatAllocation`, `Payment`, `MessageDraft`, the
  student's fee-source IDs, and audit payment references do not use composite
  tenant foreign keys. Direct Prisma writes can create relationships that the
  normal services reject. Any documentation claiming database-enforced tenant
  consistency is inaccurate.
- **Known discrepancy—do not rely on:** Foreign and nonexistent IDs do not yet
  have one uniform response. Some scoped staff and MultiShift operations make
  both cases indistinguishable, while payment, allocation, and student mutation
  paths may return forbidden for an existing foreign record and not found for a
  missing record. Generic tenant-safe not-found behavior is the target policy,
  not a universal current guarantee. (Tenant-safe API tests and service tests
  under `tests/integration/`)

## Roles, permissions, and projections

- **Must preserve—enforced:** The organization owner implicitly has every
  application action and is not restricted by branch staff membership.
- **Must preserve—enforced:** The base role matrix is:
  - `MANAGER`: manage branch, students, seat allocation, view/generate/mark
    paid/waive payments, and analytics.
  - `STAFF`: manage students and seat allocation, and view/mark paid payments.
  - Organization management and staff management remain owner-only.
  (`types/staff.ts`, `services/staff.service.ts`)
- **Must preserve—enforced:** Per-user grant/deny overrides apply only to the
  supported operational actions. They must not be used to grant owner-only
  organization or staff-management powers. Analytics and staff-management
  access must also satisfy the relevant plan entitlement.
  (`services/staff.service.ts`, staff integration tests)
- **Must preserve—enforced:** Branch detail responses are permission-shaped.
  A caller with only payment access, for example, must not receive unrelated
  student, seat, allocation, or staff data.
  (`services/branch.service.ts`, branch-details-projection unit tests)
- **Service-layer contract—not DB-enforced:** API routes must authenticate,
  authorize the action, and pass tenant-scoped identifiers before calling
  unscoped helpers. UI visibility is not authorization.

## Organizations, branches, trials, and entitlements

- **Must preserve—enforced:** User-initiated operational mutations require both
  the role/action permission and a writable branch entitlement. `ARCHIVED`,
  `PENDING_ACTIVATION`, and `REMOVAL_SCHEDULED` branches reject those mutations.
  (`services/entitlement.service.ts`, entitlement integration tests)
- **Known discrepancy—do not rely on:** The daily payment cron generates dues
  for every active student without checking branch billing status or
  organization writability. Whether system-owned operational-payment generation
  should respect branch or organization writability is an unresolved product
  decision. Current behavior is not accepted policy until a human-approved ADR
  or an updated domain invariant resolves it.
  (`app/api/cron/payments/daily/route.ts`, `services/payment.service.ts`)
- **Must preserve—enforced:** Workspace Billing V2 base access fails closed:
  - an active owner trial grants the trial's PRO access;
  - paid access requires the subscription mode to match the runtime provider
    mode and `paidThrough` to be later than now;
  - `PENDING` or `PAUSED` may remain writable through an already-paid period,
    with warning state;
  - `HALTED`, an expired paid period, or an untrusted current subscription is
    read-only unless a separately authorized replacement is inside its trusted
    grace window.
  (`lib/billingState.ts`, `services/entitlement.service.ts`, entitlement tests)
- **Must preserve—enforced:** Legacy billing-model organizations remain writable.
  A legacy organization with no subscription receives the deliberate Basic
  fallback; an untrusted legacy subscription is downgraded to Basic entitlements
  but still returns full write access. Do not apply V2 fail-closed status rules
  to the legacy branch.
- **Must preserve—enforced:** An owner trial is granted once, lasts 30 days, is
  bound to its organization, and is not extended by adding branches. A migrated
  trial is available only to an organization that has never been billed.
  (`services/ownerTrial.service.ts`, owner-trial integration tests)
- **Must preserve—enforced:** Adding, scheduling removal of, and reactivating a
  billable branch are owner-only operations. The branch lifecycle update and
  durable billing-change intent are atomic and use stable idempotency. At least
  one billable branch must remain.
- **Must preserve—enforced:** Scheduled removal does not delete the branch. It
  becomes read-only and is archived only at the effective boundary after the
  required provider confirmation. Historical data remains available according
  to authorization.
  (`services/branch.service.ts`, branch-billing-lifecycle integration tests)
- **Known discrepancy—do not rely on:** `OnboardingService.createNetwork` is
  not idempotent. Repeating the request can create independent organizations
  and networks. Callers must not treat retrying it as safe until an idempotency
  contract is added. (`services/onboarding.service.ts`,
  `tests/integration/services/onboarding.test.ts`)

## Students and fee sources

- **Must preserve—enforced:** A newly created student starts `ACTIVE` and is
  owned by one branch. Within a branch, normal creation rejects a duplicate
  normalized `(name, phone)` identity; the same pair may exist in another
  branch. Imported rows without a phone do not participate in this identity
  check. Import duplicate review canonicalizes valid Indian 10-digit, leading
  zero, and `91`-prefixed phone forms before building that identity.
  (`services/student.service.ts`, student integration tests, import duplicate
  tests)
- **Service-layer contract—not DB-enforced:** The normalized student identity
  rule is application-enforced; there is no matching database unique key. New
  import or bulk-write paths must preserve the intended duplicate behavior.
- **Must preserve—enforced:** A student's current recurring fee has exactly one
  source: manual amount, an active same-branch Shift, or a same-branch
  MultiShift. Selecting a manual fee clears linked fee-source IDs. Updating a
  linked source price updates the student's current `monthlyFee`; it does not
  rewrite existing payment rows.
  (`services/student.service.ts`, `services/shift.service.ts`,
  `services/multiShift.service.ts`)
- **Must preserve—enforced:** An inactive student cannot receive a new
  allocation or monthly fee generation. Inactivation ends active allocations
  and may, only with the required payment permission, leave, pay, or waive all
  currently due payments while recording the mutation audit. Reactivation does
  not recreate prior allocations. (Student, allocation, and payment service
  tests)
- **Known discrepancy—do not rely on:** Creating a student and an admission
  payment commits before the optional initial seat allocation, which is made in
  a separate operation. If allocation fails, the student and payment remain.
  Do not describe the combined workflow as atomic.
  (`services/student.service.ts`)

## Seats, shifts, MultiShifts, and allocations

- **Must preserve—enforced:** A seat label is database-unique within a branch
  using its exact stored value. Batch generation additionally rejects
  case-insensitive duplicate labels and creates the batch atomically.
  (`prisma/schema.prisma`, `services/seat.service.ts`, seat integration tests)
- **Service-layer contract—not DB-enforced:** The case-insensitive seat-label
  rule is stronger than the schema's exact-value unique constraint. All seat
  creation paths must apply it consistently.
- **Must preserve—enforced:** A shift supplies both start and end time or
  neither. Missing times and equal endpoints represent a full-day interval.
  Overnight intervals are supported, and intervals that only touch at a
  boundary do not overlap. Active shifts in a branch must not overlap.
  (`utils/shiftTime.ts`, `services/shift.service.ts`, shift-time and shift tests)
- **Must preserve—enforced:** A branch retains at least one active shift.
  Removing a shift is a soft inactivation, closes or reallocates its direct
  active allocations, and clears students' direct `feeLinkedShiftId` references
  to that shift.
- **Service-layer contract—not DB-enforced:** Shift overlap and the minimum-one-
  active-shift rule are service checks, not schema constraints. Writes that
  bypass `ShiftService` can violate them.
- **Must preserve—enforced:** Creating or updating a MultiShift requires at least
  two distinct, active, same-branch shifts. Component order does not define
  identity; another bundle with the same unordered shift set is rejected. Its
  name is unique in the branch by the database's exact-value comparison.
- **Known discrepancy—do not rely on:** Soft-deleting a component Shift does
  not remove or rewrite `MultiShiftComponent` rows and does not clear students'
  `feeLinkedMultiShiftId`. An existing MultiShift can therefore retain an
  inactive component and linked fees even though new bundles require active
  components. (`services/shift.service.ts`, `services/multiShift.service.ts`)
- **Must preserve—enforced:** Deleting a MultiShift first removes current and
  historical references that would block deletion, including student fee links
  and allocation bundle references, and then deletes the bundle.
  (`services/multiShift.service.ts`, MultiShift integration tests)
- **Service-layer contract—not DB-enforced:** Unordered MultiShift component
  uniqueness and component same-branch membership are application checks, not
  one database constraint.
- **Must preserve—enforced:** An active seat allocation is represented by
  `endDate = null`. Release or change closes the old row instead of erasing it,
  preserving allocation history.
- **Must preserve—enforced:** A new allocation requires an active student, seat,
  and shift or MultiShift in one branch. A MultiShift allocation uses exactly
  that bundle's component shifts. A seat and a student must each be free from
  active allocations in the same or overlapping shift interval. Releasing one
  component of a bundle ends the whole bundle allocation.
- **Service-layer contract—not DB-enforced:** Active-allocation uniqueness and
  overlap exclusion are protected by a serializable service transaction with
  bounded retry, not by a partial unique or composite tenant constraint. All
  competing allocation writes must use this path.
  (`services/seatAllocation.service.ts`, seat-allocation integration tests)

## Attendance

- **Known discrepancy—do not rely on:** Attendance is not implemented in the
  current repository: there is no attendance model, service, route, or test.
  Do not infer attendance records, rules, or analytics from allocation data.

## Member payments and billing cycles

- **Must preserve—enforced:** Monthly periods are anchored to the student's
  joined calendar date. For cycle `N`, the period starts at joined date plus
  `N` months and its end/due date is joined date plus `N + 1` months. Generation
  includes only cycles due through the requested as-of date, skips periods that
  start before `billingStartAt`, and includes only active students.
  (`utils/studentBillingCycles.ts`, `services/payment.service.ts`, billing-cycle
  and payment tests)
- **Must preserve—enforced:** Monthly generation and catch-up are retry-safe for
  the current monthly key through unique `(studentId, periodStart)` plus
  duplicate skipping. A rerun must not create another monthly charge for the
  same cycle. (`prisma/schema.prisma`, payment integration tests)
- **Must preserve—enforced:** Payment states are `DUE`, `PAID`, and `WAIVED`.
  Repeating a mutation to its already-current target state is idempotent. The
  first effective transition records an audit and updates branch activity;
  marking paid also removes follow-up message drafts.
  (`services/payment.service.ts`, payment integration tests)
- **Known discrepancy—do not rely on:** Admission and first monthly payment use
  the same joined-date `periodStart`, while the database unique key omits
  payment type. A nonzero admission payment can therefore cause the first
  monthly payment to be silently skipped by duplicate-tolerant generation.
  This is a likely billing defect, not a valid one-charge invariant.
  (`prisma/schema.prisma`, `services/student.service.ts`,
  `utils/studentBillingCycles.ts`, `services/payment.service.ts`)
- **Known discrepancy—do not rely on:** `PAID` and `WAIVED` are not terminal in
  the current service. It permits `PAID -> WAIVED` and `WAIVED -> PAID`, and a
  waiver after payment can leave `paidAt`, method, and reference populated.
  Do not build reporting or integrations on those transitions until the state
  machine and field-clearing behavior are explicitly decided.
- **Must preserve—enforced:** “Overdue” is derived rather than stored. Current
  logic considers a payment overdue only while `DUE` and strictly more than
  seven calendar days past its due date. `WAIVED` payments are excluded from
  open debt and revenue.
  (`lib/utils/paymentStatus.ts`, `analytics/payment.analytics.ts`, payment
  analytics integration tests)
- **Known discrepancy—do not rely on:** `Organization.paymentGraceDays` is not
  used by overdue calculations; the code currently hard-codes seven days. Do
  not promise organization-configurable grace periods.

## SaaS subscriptions and provider events

- **Must preserve—enforced:** Subscription and billing mutation APIs are
  owner-only. Provider mode is part of the trust boundary: TEST records cannot
  grant or mutate LIVE access, and vice versa.
- **Must preserve—enforced:** An organization has one current subscription slot
  and one pending-replacement slot. Previous subscription rows remain as
  history and replacement lineage rather than being rewritten as the current
  row. (`prisma/schema.prisma`, billing integration tests)
- **Must preserve—enforced:** Provider subscription status alone never grants
  paid access. `paidThrough` advances monotonically only after reconciliation
  finds a current-period paid invoice and captured payment whose subscription,
  invoice, and payment identifiers agree and whose method is supported.
  (`services/billingReconciliation.service.ts`, billing tests)
- **Must preserve—enforced:** Checkout completion verifies the server signature,
  retrieves provider-side objects, and matches expected organization intent,
  subscription, payment, plan, quantity, and payment state before trusting the
  result.
- **Must preserve—enforced:** A webhook is only a signed reconciliation trigger,
  not proof of quantity or entitlement. Its signature is verified over the raw
  body. Event IDs are deduplicated with a payload hash; reuse with a different
  payload is rejected. Failed events remain retryable and are marked processed
  only after reconciliation succeeds. (`app/api/razorpay/webhook/route.ts`,
  billing webhook and reconciliation tests)
- **Must preserve—enforced:** Billing-change idempotency keys are globally
  unique and may be replayed only with the same payload. Each organization's
  changes have a monotonic FIFO sequence, use database locking/leases, reject a
  stale worker, and do not allow a later intent to pass an unresolved earlier
  intent. The source subscription is immutable for the mutation.
  (`services/billingMutation.service.ts`, billing-mutation integration tests)
- **Must preserve—enforced:** Replacement access remains fail-closed until the
  replacement is authenticated or active and its lineage, plan, and quantity
  exactly match the approved intent. A mismatch removes provisional trust and
  requires manual review. (Billing replacement trust/access unit tests)

## Imports and AI boundaries

- **Must preserve—enforced:** Import sessions are authenticated and scoped to a
  branch. Creating or mutating a session requires student-management permission
  and a writable branch; committing also checks every additional permission
  required by the reviewed rows, including branch, allocation, and payment
  actions. Session, plan, run, recipe, and row identifiers are resolved with an
  authorized branch or organization boundary; foreign and nonexistent import
  resources receive the same generic response.
  (`importing/services/import-session.service.ts`,
  `importing/services/import-run.service.ts`,
  `importing/services/import-recipe.service.ts`, import route tests)
- **Must preserve—enforced:** Import request and parser limits are 4.25 MiB for
  the complete request, 4 MiB for the source file or decoded text, 2,000 data
  rows, 64 columns, 8 KiB per cell, and 32 MiB of declared or measured expanded
  workbook content. Row accumulation stops at the ceiling plus one instead of
  fully materializing an oversized source. Type/signature and UTF-8 validation
  fail closed; malformed CSV quoting is rejected. Blank and duplicate headers
  remain positionally distinct instead of silently overwriting cells.
  (`importing/http/import-request.ts`,
  `importing/parsers/import-parser-guards.ts`, parser tests)
- **Must preserve—enforced:** Multi-sheet workbooks require an explicit sheet
  choice and support an explicit one-based header row. PDF import is text-only
  beta extraction; it does not promise visual-table reconstruction or OCR and
  every extracted row remains subject to review.
  (`importing/parsers/xlsx.parser.ts`, `importing/parsers/pdf.parser.ts`)
- **Must preserve—enforced:** New V2 starts fail closed unless
  `IMPORT_V2_ENABLED=true`. Plan compilation fails closed unless
  `IMPORT_MAX_PLANNED_MUTATIONS` is a configured positive integer, and a plan
  whose deterministic mutation-item count exceeds that cap is published as
  non-runnable. Compilation short-circuits at cap plus one before sorting or
  expanding the rest of a high-fan-out payment history. Repository defaults do
  not supply a Production cap.
  (`lib/importFeature.ts`, V2 start routes, import feature tests)
- **Must preserve—enforced:** V2 draft mutations advance `draftRevision`.
  Published row evaluations cover the complete staged row set for exactly that
  revision, and a plan can run only when the active evaluation revision still
  matches. `ImportRowEvaluation` and `ImportPlan` rows are update-immutable;
  repair creates a new revision and plan instead of rewriting reviewed history.
  (`importing/services/import-evaluation.service.ts`,
  `importing/services/import-plan.service.ts`,
  `prisma/migrations/20260818090000_add_import_assistance_v2/migration.sql`)
- **Must preserve—enforced:** A V2 commit requires a published deterministic
  plan, its exact `planVersion`, an explicit readiness policy, and the current
  target revision. `REQUIRE_ALL_ROWS_READY` blocks before a run when any
  non-skipped row is unresolved; `READY_ROWS_ONLY` omits unresolved rows. Neither
  policy promises one file-wide transaction or rollback of already completed
  items.
  (`importing/utils/import-plan-compiler.ts`,
  `importing/services/import-run.service.ts`)
- **Must preserve—enforced:** A successful execution whose immutable plan still
  leaves any blocked, skipped, or otherwise unscheduled non-imported row is
  `COMPLETED_WITH_ISSUES`, and its session remains `PARTIAL`. It must not be
  projected as fully committed, because unresolved rows need a new reviewed
  revision and plan. Replaying another partial repair still projects newly
  successful entity IDs onto its rows even when the session was already
  `PARTIAL`.
  (`importing/services/import-runner.service.ts`,
  `importing/services/import-run-lifecycle.service.ts`, runner lifecycle tests)
- **Must preserve—enforced:** Import run requests use a caller idempotency key
  plus a canonical request hash. Reusing the key for different content is a
  conflict; replaying the same request returns the same durable run. PostgreSQL
  enforces one active run per non-purged session and unique run-item identities.
  Claimed items use bounded batches, expiring leases, attempt limits, and
  compare-and-set completion so replay cannot duplicate a completed item.
  Workflow retry exhaustion is projected into the PostgreSQL ledger with a
  redacted terminal error: ready-row runs fail remaining independent items,
  while require-all runs fail one item and skip unscheduled work. Successful
  mutations are never rolled back. A successful `READY_ROWS_ONLY` run remains
  `COMPLETED_WITH_ISSUES`/`PARTIAL` while its immutable plan contains blocked,
  explicitly skipped, or ready-without-mutation rows; terminal replay always
  idempotently projects the current run's successful entity IDs onto rows,
  including consecutive partial repair runs.
  Repair may reuse a successful row mutation only when its persisted canonical
  mutation hash still matches the current reviewed data; a semantic mismatch
  blocks repair instead of silently linking stale results. Configuration claims
  are dependency-fenced so seat and shift items settle before a multi-shift
  that references them becomes claimable.
  (`importing/services/import-run.service.ts`,
  `importing/services/import-runner.service.ts`, V2 migration and tests)
- **Must preserve—enforced:** An attached Workflow provider run may be replaced
  only after the provider reports it terminal or missing while the PostgreSQL
  ledger remains active. Replacement clears the exact prior provider ID under
  a row lock and compare-and-set check, moves the ledger to retryable, and lets
  the next Workflow compete through the normal single-owner attachment fence.
  Provider lookup failures retain the existing owner and remain retryable;
  active provider runs are never replaced.
  (`importing/services/import-workflow.ts`,
  `importing/services/import-run.service.ts`, dispatch-recovery tests)
- **Must preserve—enforced:** Each import mutation transaction rechecks the
  current branch configuration against the reviewed item. Fee-linked shift or
  multi-shift prices and active branch-owned components must still match, and
  multi-shift allocations must retain the exact reviewed ordered component
  structure. An existing monthly payment with the same student/period key may
  be reused only when branch, monthly type, amount, period end, due date,
  allowed status transition, and any already-final payment metadata match the
  immutable cycle; otherwise the item fails stale instead of claiming the
  reviewed mutation occurred.
  (`importing/services/import-run-executor.service.ts`,
  `services/payment.service.ts`, import executor/payment exactness tests)
- **Must preserve—enforced:** Reviewed student names and approved new seat,
  shift, and multi-shift labels use the same normalized length/shape rules as
  their domain services. Approved missing shifts are checked against active
  branch shifts and against one another with the same overlap semantics as
  `ShiftService`; adjacent boundaries remain valid. Approved new multi-shifts
  require at least two distinct primary shifts and cannot duplicate an
  order-independent existing or planned component combination. Immutable plan
  revalidation repeats these deterministic checks before a run can start.
  (`importing/validators/`,
  `importing/services/import-plan-configuration.service.ts`, validation parity
  and configuration tests)
- **Service-layer contract—not DB-enforced:** Workflow orchestration is a
  scheduler, not the system of record or an authorization decision. Workflow
  inputs and step outputs contain opaque run/session identifiers, revisions,
  hashes, cursors, and counts only. Personal row values and branch configuration
  stay in PostgreSQL and are loaded only inside bounded execution steps that
  recheck tenant ownership, current permission, entitlement, and writability.
  (`importing/workflows/`, `importing/services/import-run-executor.service.ts`)
- **Must preserve—enforced:** Successful run-item results are restricted to
  entity IDs and numeric counts; error code/message fields are bounded and
  sanitized. Execution payloads are cleared after terminal item handling.
  (`importing/services/import-runner.service.ts`)
- **Must preserve—enforced:** Organization recipes are reached through a
  branch-authorized API but persist only source type, a server-computed
  normalized-header signature, normalized source-column/target mappings, goal,
  and entity types. They must never persist samples, row values, branch
  configuration, payment/default/conflict options, or model rationale.
  (`importing/services/import-recipe.service.ts`, recipe tests)
- **Must preserve—enforced:** Staging PII receives a 30-day `purgeAfter`
  deadline after a terminal state or draft inactivity. The authenticated daily
  retention job is idempotent and explicitly bounded to 20 batches of at most
  100 sessions per invocation, reports any remaining backlog, rechecks the deadline under a row
  lock, locks attached run ledgers, and terminalizes any remaining active runs
  and nonterminal items with consistent counters. It then scrubs retained
  run-item payloads and errors and deletes the session and its staged
  rows/evaluations/plans. A stale waiting, queued, retryable, or running ledger
  state must not retain expired staging indefinitely. Redacted run history
  survives through nullable references.
  (`importing/services/import-retention.service.ts`,
  `app/api/cron/imports/daily/route.ts`, retention tests)
- **Service-layer contract—not DB-enforced:** Gemini mapping output is untrusted
  input. It must be parsed, sanitized, confidence-gated, and replaced with
  deterministic mapping when unusable. Imported rows must still pass normal
  service authorization, tenant, duplicate, fee, and allocation rules.
- **Must preserve—enforced:** Import mapping runs deterministic mapping first.
  Gemini receives only sanitized aliases for ambiguous headers, masked value
  shapes and structural counts, and a branch summary made of counts/booleans;
  raw row values, complete headers, seat/shift names, fees, and branch
  configuration are not sent to the model.
  (`importing/ai/import-column-mapper.ai.ts`, AI privacy tests)
- **Must preserve—enforced:** Gemini is called only from server-side code. Branch
  report risks, health score, and actions remain deterministic; Gemini supplies
  validated narrative with deterministic fallbacks. Opening the reports page
  can trigger generation through its GET route when cache and staleness rules
  allow it.
- **Must preserve—enforced:** Overdue-message GET is cache-only. Regeneration is
  an explicit POST for selected students, produces reviewable/copyable drafts,
  and does not send WhatsApp, SMS, email, or any other external message.
- **Service-layer contract—not DB-enforced:** AI output is advisory. It must not
  decide authorization, tenant scope, entitlement, payment truth, provider
  reconciliation, or an automatic external action.
- **Known discrepancy—do not rely on:** Overdue drafting still sends selected
  student names and debt context to Gemini. The repository does not establish
  the operator's consent, retention, regional, or vendor data-processing policy
  for that flow. Vercel Workflow Production use likewise remains subject to the
  human approval and provider/data-residency review recorded in the Proposed
  import-execution ADR; do not infer approval from installed code.

## Time and money semantics

- **Must preserve—enforced:** Member fees and payments are represented as
  integer major currency units in operational domain code; the current product
  presents them as INR. SaaS billing persists both major-unit `amount` and
  provider `amountSubunits`; Razorpay INR conversion is exactly 100 subunits per
  major unit and accepts positive integers.
  (`lib/billingPlans.ts`, billing provider/services, money and billing tests)
- **Known discrepancy—do not rely on:** Validation ceilings differ between
  forms, routes, and services. There is no single repository-wide maximum
  amount, seat count, or student count unless a specific path defines one.
- **Known discrepancy—do not rely on:** User and organization timezone fields
  default to `Asia/Kolkata`, but billing-cycle and calendar-day calculations use
  runtime-local date operations and do not consult the organization timezone.
  Do not claim explicit per-organization timezone correctness.
  (`prisma/schema.prisma`, `utils/studentBillingCycles.ts`)

## Analytics

- **Must preserve—enforced:** Capacity and utilization are measured in
  seat-shift slots, not distinct physical seats: physical seats multiplied by
  active shifts. Organization rollups use the same slot unit. Legacy fields
  named `totalSeats` may therefore represent slots in analytics output.
  (`analytics/`, analytics tests)
- **Must preserve—enforced:** Branch analytics requires the analytics action and
  the `ADVANCED_ANALYTICS` entitlement. Organization snapshots require owner
  access and the entitlement. Raw analytics helpers are not tenant authorization
  boundaries and must be called only after route/service authorization.
  (`app/api/`, `services/entitlement.service.ts`, analytics route tests)
- **Must preserve—enforced:** Payment analytics use the payment semantics above:
  due means `DUE` through end-of-day, overdue means strictly more than seven
  days late, and waived rows are excluded from open debt and revenue.
- **Known discrepancy—do not rely on:** Trend analytics recompute past-looking
  values from today's mutable tables rather than immutable historical
  snapshots. Student status and the active-shift set are current, not reliably
  as-of the plotted date. Organization analytics also includes archived
  branches. Do not describe these trends as a complete historical ledger.

## Change checklist

Before changing any rule above:

1. Inspect the schema, service, route authorization, and relevant tests.
2. Decide whether the rule belongs in a database constraint, a transaction, or
   a service boundary; do not silently reduce its enforcement strength.
3. Add regression coverage for tenant separation, authorization, retry or
   idempotency behavior, and failure rollback where applicable.
4. Update this document when an enforced rule, service-only contract, or known
   discrepancy changes.
