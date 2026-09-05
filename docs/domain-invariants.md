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
  not a universal current guarantee. Organization owner access and its billing
  APIs are not part of this discrepancy: they use a combined organization/owner
  lookup and the same typed generic not-found result. (Tenant-safe API tests and
  service tests under `tests/integration/`)

## Roles, permissions, and projections

- **Must preserve—enforced:** The organization owner implicitly has every
  application action and is not restricted by branch staff membership.
- **Must preserve—enforced:** The base role matrix is:
  - `MANAGER`: manage branch, students, seat allocation, view/generate/mark
    paid/waive payments, analytics, and view/send/manage WhatsApp actions.
  - `STAFF`: manage students and seat allocation, view/mark paid payments, and
    view/send WhatsApp actions.
  - Organization management and staff management remain owner-only.
  (`types/staff.ts`, `services/staff.service.ts`)
- **Must preserve—enforced:** Per-user grant/deny overrides apply only to the
  supported operational actions. They must not be used to grant owner-only
  organization or staff-management powers. Analytics and staff-management
  access must also satisfy the relevant plan entitlement. WhatsApp actions are
  overridable but additionally require `WHATSAPP_AUTOMATION`; branch
  `manage_whatsapp` does not grant organization-owned sender connection,
  registration, template-sync, assignment, or disconnect authority.
  (`services/staff.service.ts`, staff integration tests)
- **Must preserve—enforced:** Branch detail responses are permission-shaped.
  A caller with only payment access, for example, must not receive unrelated
  student, seat, allocation, or staff data.
  (`services/branch.service.ts`, branch-details-projection unit tests)
- **Service-layer contract—not DB-enforced:** API routes must authenticate,
  authorize the action, and pass tenant-scoped identifiers before calling
  unscoped helpers. UI visibility is not authorization.

## Organizations, branches, trials, and entitlements

- **Must preserve—enforced:** New workspaces use canonical onboarding with an
  explicit V2 commercial state and selected plan. Holding the V2 release flag
  blocks new creation; it must never create new LEGACY writable workspaces.
  Existing legacy compatibility and the once-per-owner trial policy remain intact.

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
  - ordinary paid access requires the subscription mode to match the runtime
    provider mode and a current `paidThrough` returned by the shared exact-
    settlement resolver. A raw date or provider status is insufficient: the
    stored subscription pointers, immutable applied commercial intent, paid
    invoice, captured payment, amount, currency, plan, quantity, offer,
    cadence, and period must form one exact tuple;
  - `PENDING` or `PAUSED` may remain writable through an already-paid period,
    with warning state;
  - `HALTED`, an expired paid period, or an untrusted current subscription is
    read-only unless a separately authorized replacement is inside its trusted
    grace window.
  (`lib/billingState.ts`, `services/entitlement.service.ts`, entitlement tests)
- **Must preserve—enforced:** Legacy billing-model organizations remain writable.
  A legacy organization with no subscription receives the deliberate Basic
  fallback. `AUTHENTICATED` means mandate readiness, and neither
  `AUTHENTICATED`, `ACTIVE`, nor an unbacked future `paidThrough` grants premium
  entitlement. An untrusted legacy subscription is downgraded to Basic
  entitlements but still returns full write access; exact current settlement
  evidence grants the subscribed plan through the same normal paid-period
  boundary as V2. Owner trials and explicitly bounded replacement access remain
  separate grants. Do not apply V2 read-only fallback rules to the legacy
  branch.
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
  Onboarding and branch draft validation use those same full-day semantics.
  (`utils/shiftTime.ts`, `services/shift.service.ts`, shift-time and shift tests)
- **Must preserve—enforced:** A branch retains at least one active shift.
  Removing a shift is a soft inactivation, closes or reallocates its direct
  active allocations, and clears students' direct `feeLinkedShiftId` references
  to that shift.
- **Must preserve—enforced:** Shift deactivation and allocation creation share
  serializable transactions with bounded whole-operation retry. Manual resolution
  requires every current active source allocation exactly once; all targets must
  be active in that branch. Affected bundle siblings are closed together by
  student, seat, and bundle identity. Validation failure rolls back all changes.
- **Service-layer contract—not DB-enforced:** Shift overlap and the minimum-one-
  active-shift rule are service checks, not schema constraints. Writes that
  bypass `ShiftService` can violate them.
- **Must preserve—enforced:** Creating or updating a MultiShift requires at least
  two distinct, active, same-branch shifts. Component order does not define
  identity; another bundle with the same unordered shift set is rejected. Its
  name is unique in the branch by the database's exact-value comparison.
- **Must preserve—enforced:** MultiShift component-set changes are rejected while
  the bundle has active allocations. The check and update share the serializable
  allocation transaction protocol. Name, price and component-order-only edits
  remain supported; linked monthly fees retain their existing update behavior.
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
  bounded retry, not by a partial unique or overlap constraint. All
  competing allocation writes must use this path.
  (`services/seatAllocation.service.ts`, seat-allocation integration tests)
- **Must preserve—enforced:** `SeatAllocation.branchId` participates in composite
  foreign keys to its student, seat, shift, and optional MultiShift. PostgreSQL
  rejects cross-branch links, including historical rows. These constraints do
  not authorize actors or enforce active-state, overlap, or bundle completeness.

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
- **Must preserve—enforced:** A payment is database-unique by
  `(studentId, type, periodStart)`. An admission charge and the first monthly
  charge may therefore coexist at the joined-date period start, while duplicate
  monthly charges for one student and cycle remain forbidden. Monthly
  generation and catch-up remain retry-safe through this typed key plus
  duplicate skipping. (`prisma/schema.prisma`, payment integration tests)
- **Must preserve—enforced:** Payment states are `DUE`, `PAID`, and `WAIVED`.
  Effective transitions are `DUE -> PAID`, `DUE -> WAIVED`, `PAID -> WAIVED`,
  and `WAIVED -> PAID`; repeating a mutation to its current target state is an
  idempotent no-op. A waiver after payment retains the existing `paidAt`,
  method, and reference metadata. Marking paid also removes follow-up message
  drafts. (`services/payment.service.ts`, payment integration tests)
- **Must preserve—enforced:** Every effective transition to `PAID` or `WAIVED`
  through a supported payment, student-inactivation, or import path appends one
  immutable `PaymentResolutionEvent` in the same transaction as the payment
  mutation and existing `AuditLog`. The event derives branch ownership and its
  payment snapshot from trusted before/after payment rows. Corrections append a
  new event without rewriting prior events, while a target-status no-op creates
  neither an audit nor an event. The restrictive payment and branch relations
  prevent deleting domain history through those parents. Historical resolutions
  from before the event-ledger migration are deliberately not backfilled as if
  their original transition facts were known.
  (`services/paymentResolutionEvent.service.ts`, payment, student, and import
  integration tests)
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

- **Must preserve—enforced:** Organization details, settings, branch lists, and
  subscription-billing owner entry points resolve the organization with both
  `id` and `ownerId` before loading billing data or performing provider work.
  Foreign and nonexistent organization IDs return the exact same generic 404
  body. HTTP mappings use typed errors rather than authorization/not-found
  message matching. (`services/organization.service.ts`, `lib/billingHttp.ts`,
  organization access route and integration tests)
- **Must preserve—enforced:** Subscription and billing mutation APIs are
  owner-only. Provider mode is part of the trust boundary: TEST records cannot
  grant or mutate LIVE access, and vice versa.
- **Must preserve—enforced:** Billing preflight and maintenance commands isolate
  the selected allowlisted environment and fail on conflicting ambient
  database or Razorpay identities. Maintenance apply runs are fenced by the
  expected deployment, provider mode, database-resident identity fingerprint,
  and explicit organization allowlist before any scoped query, write, or
  provider fetch.
  (`scripts/billing-operation-target.ts`, billing-operation target tests)
- **Must preserve—enforced:** An organization has one current subscription slot
  and one pending-replacement slot. Previous subscription rows remain as
  history and replacement lineage rather than being rewritten as the current
  row. (`prisma/schema.prisma`, billing integration tests)
- **Must preserve—enforced:** Provider subscription status alone never grants
  paid access. Entitlement and billing-experience reads accept `paidThrough`
  only when the stored current pointers resolve back to an applied immutable
  commercial intent and its exact current-period paid invoice/captured payment
  tuple. Reconciliation advances `paidThrough` only from that same tuple.
  Subscription, invoice, payment, provider mode, plan, quantity, offer, amount,
  currency, cadence, and period must agree; `amount_due` must be zero and the
  invoice must be fully settled. The fetched collection count must be complete,
  every paid item must carry subscription/payment/period identity, and an
  explicit payment ID never bypasses duplicate-current-period detection.
  (`services/billingPaidEvidence.service.ts`,
  `services/billingReconciliation.service.ts`, paid-evidence and billing tests)
- **Must preserve—enforced:** Every new subscription authorization or billing
  change freezes versioned commercial intent before its provider mutation. The
  source subscription, provider mode, operation, plan, quantity, offer-adjusted
  total, currency, period, and interval come from that snapshot; a replacement
  provider subscription ID is bound exactly once after provider creation. Both
  callbacks and reconciliation use the same validator and never reconstruct
  historical intent from the current plan catalog. A mismatch preserves the
  previously confirmed subscription, plan, quantity, and `paidThrough`, revokes
  invalid provisional replacement access, and enters
  `MANUAL_REVIEW_REQUIRED`. (`prisma/schema.prisma`,
  `services/billingCommercialEvidence.service.ts`,
  `services/billingReconciliation.service.ts`, exact-evidence and billing tests)
- **Must preserve—enforced:** Initial Razorpay subscription creation persists an
  immutable organization/mode/change/billing-model/plan/provider-plan/quantity/
  offer/start/expiry/total-count intent and a one-time provider-call admission
  before the create request. The same tuple is sent in provider notes. An
  ambiguous create is never automatically cancelled or repeated; retry performs
  provider reads only. Exactly one matching uncharged `CREATED` object may be
  adopted with the original lease and attempt fence. No match, multiple matches,
  authorized or charged state, wrong tenant or mode, provider-read failure, and
  local-finalization failure remain typed manual review and append immutable
  operation-audit evidence. (`services/billingProvisioning.service.ts`,
  `services/billing.service.ts`, provisioning unit/integration tests)
- **Must preserve—enforced:** Checkout completion verifies the server signature,
  retrieves provider-side objects, and matches expected organization intent,
  subscription, payment, plan, quantity, and payment state before trusting the
  result.
- **Must preserve—enforced:** Replacement creation freezes its provider start,
  expiry and total count and records dispatch before creation. Recovery fetches
  the retained provider ID or discovers one exact uncharged candidate, without
  another create or duplicate cleanup. No match, multiple live matches, and
  authorized/charged matches stay in manual review. Source cancellation uses
  its own processing attempt and immutable admission audit; neither candidate
  evidence nor overwritten lifecycle fields permits replay. A failed source
  action is recovered by source-specific provider reads: terminal source truth
  or the retained confirmed cancellation response and exact scheduled boundary.
  Ambiguous scheduled-change flags remain held. Checkout replacement waits for
  provider-confirmed terminality, and legacy cancellation preserves the supplied
  idempotency key without compensating reversal.
  (`services/billingReplacement.service.ts`, billing-mutation fault tests)
- **Must preserve—enforced:** A webhook is only a signed reconciliation trigger,
  not proof of quantity or entitlement. The public body is bounded to 512 KiB;
  its signature and payload hash are verified over the same untouched bytes
  before JSON parsing. Event IDs are deduplicated with a payload hash; reuse
  with a different payload is rejected. A short token-fenced receipt claim
  commits before provider reconciliation, active nonowners acknowledge without
  reconciling, and expired claims are reclaimable. Provider work remains outside
  the claim transaction, and only the exact token/start/lease/attempt identity
  may finalize success or retryable failure. Deployment must hold webhook
  ingress and prove the prior unfenced worker drained before the token-fenced
  worker is promoted; additive columns do not make those worker protocols safe
  to overlap. (`app/api/razorpay/webhook/route.ts`,
  `services/billing.service.ts`, `docs/production-runbook.md`, billing webhook
  and reconciliation tests)
- **Must preserve—enforced:** Billing-change idempotency keys are globally
  unique and may be replayed only with the same payload. Each organization's
  changes have a monotonic FIFO sequence, use database locking/leases, reject a
  stale worker, and do not allow a later intent to pass an unresolved earlier
  intent. The source subscription is immutable for the mutation.
  (`services/billingMutation.service.ts`, billing-mutation integration tests)
- **Must preserve—enforced:** Every provider subscription mutation, including
  cancellation of a scheduled update or replacement candidate, is finalized
  only by the exact lease and attempt that submitted it. A timeout, network
  failure, provider 5xx, HTTP 408,
  malformed success, expired in-flight lease, or post-provider finalization
  failure is quarantined as `MANUAL_REVIEW_REQUIRED` and is never automatically
  resubmitted. Retry reads provider state first; only a definitely rejected or
  pre-provider failure may issue a second mutation after a read confirms the
  provider object is still nonterminal, while exact target or terminal-
  cancellation evidence may be adopted without another write. Manual-review and
  reconciliation outcomes append deduplicated SYSTEM subscription-history evidence.
  (`services/billingMutation.service.ts`, `services/billingDeadline.service.ts`,
  billing-mutation and billing-deadline integration tests)
- **Must preserve—enforced:** Owner-visible manual-review operations are read
  and reconciled without a provider mutation. Pending, rejected-but-unresolved,
  malformed, or mismatched evidence remains quarantined with a typed error;
  only an exact frozen authorization or settlement may adopt provider state.
  Replacement adoption is explicitly fenced to the same failed row and cannot
  promote, grant access, cancel a source subscription, or issue another charge
  while evidence remains unresolved. (`services/billing.service.ts`,
  `services/billingReplacement.service.ts`, billing reconciliation tests)
- **Must preserve—enforced:** Local billing undo cannot pass an in-flight,
  awaiting-payment, manual-review, or unclassified failed provider mutation.
  A branch scheduled for removal is restored only in the same transaction that
  durably records provider-confirmed scheduled-change undo; unresolved provider
  quantity never restores branch access. Replacement-candidate cancellation uses
  its own durable attempt; ambiguous cleanup is read-only on retry, and branch
  restoration shares the exact transaction that clears the provider-confirmed
  candidate slot. (`services/billing.service.ts`,
  `services/billingReplacement.service.ts`, `services/branch.service.ts`, billing
  and branch lifecycle integration tests)
- **Must preserve—enforced:** Replacement access remains fail-closed until the
  replacement is authenticated or active and its lineage, plan, and quantity
  exactly match the approved intent. A mismatch removes provisional trust and
  requires manual review. (Billing replacement trust/access unit tests)

## WhatsApp managed Utility delivery and collections

- **Must preserve—enforced:** A Meta Cloud sender belongs to one organization,
  and `(provider, providerMode, phoneNumberId)` is database-unique. A connected
  phone cannot be represented as independent same-mode senders for two
  organizations. Sender disconnect is a status transition rather than row
  deletion, and restrictive historical relations preserve provider identifiers,
  templates/bindings, recipient and consent history, messages/events, signed
  receipts, and audit evidence. (`prisma/schema.prisma`,
  `services/whatsappSender.service.ts`)
- **Service-layer contract—not DB-enforced:** Every sender, settings, recipient,
  template, message, payment, and event operation must independently prove the
  authorized organization and branch. Separate foreign keys do not prove that a
  branch, sender, student, payment, mapping, consent, template, or message belongs
  to the same tenant. Foreign and nonexistent identifiers remain generic.
  (`services/whatsappAuthorization.service.ts`, `services/whatsapp*.ts`)
- **Must preserve—enforced:** Customer-supplied business, WABA, and phone IDs are
  hints only. Embedded Signup completion exchanges the one-time code on the
  server, validates the expected app and scopes, resolves the authorized WABA,
  fetches its phone list, and verifies membership before persisting identifiers.
  Connection state is owner/organization/mode-bound, stores only a SHA-256 hash
  of 32 random bytes, expires, and is lease-fenced. TEST and LIVE assets remain
  isolated and wrong-environment configuration fails closed.
  (`services/whatsappConnection.service.ts`, `lib/metaWhatsApp.ts`,
  `lib/whatsappFeature.ts`)
- **Must preserve—enforced:** OAuth codes, customer access tokens, the global
  system-user token, app secret, webhook verification token, registration PIN,
  raw signup session, raw webhook body, inbound text, and raw provider errors are
  neither persisted nor logged. Secrets remain server-only.
- **Service-layer contract—not DB-enforced:** The customer owns its WABA, number,
  business assets, payment method, and Meta charges. Lab Lords uses delegated
  access and estimated usage only. No path may share credit, aggregate billing,
  fund customer usage, retain customer credentials, use WhatsApp Web automation,
  or treat local disconnect as a destructive provider action.
- **Must preserve—enforced:** Provider-written templates come only from the
  versioned deterministic catalogue in `lib/whatsappManagedTemplates.ts`.
  Creation hardcodes `UTILITY`; a send requires an active binding whose catalogue
  key/version/hash matches a provider-authoritative `APPROVED` and `UTILITY`
  template. Installation queries provider truth before create and reconciles an
  ambiguous create by name; unresolved ambiguity remains `UNKNOWN`. Template
  sync stays bounded and provider-authoritative. Reclassification, rejection,
  pause, disablement, staleness, or incompatible content deactivates the binding
  and suppresses safe unsubmitted work without erasing history.
  (`services/whatsappTemplateProvisioning.service.ts`,
  `services/whatsappTemplate.service.ts`)
- **Must preserve—enforced:** `WhatsAppConsent` is unique by
  `(senderId, phoneE164, consentType)`, begins `UNKNOWN`, and changes only through
  append-only trusted snapshots. Send eligibility additionally requires an
  active `WhatsAppStudentRecipient` that joins the same organization, branch,
  student, assigned sender, exact normalized current phone, and current
  `OPTED_IN` operational consent with the reviewed policy version. Existing
  students are not backfilled or opted in, repeated consent is a no-op, several
  students may intentionally share one guardian number, and phone changes or
  reactivation never transfer consent. (`services/whatsappConsent.service.ts`,
  `services/whatsappRecipient.service.ts`)
- **Must preserve—enforced:** Existing students migrate to enrollment source
  `LEGACY`; normal application creation records `MANUAL`, and import creation
  records `IMPORT`. Welcome automation is prospective and can select only a
  manually enrolled active student created after `automationEnabledAt`; it does
  not backfill legacy/imported students. (`services/student.service.ts`,
  `utils/studentBillingCycles.ts`)
- **Must preserve—enforced:** Branch delivery, automation activation, rules,
  local send time, daily/cycle frequency ceilings, configuration revision, and
  monthly estimated budget are separate controls. Delivery and automation begin
  disabled, enabling requires an assigned active same-tenant sender and all
  required approved Utility bindings, and automation begins prospectively. A
  manager cannot raise the owner-controlled budget. Branch delivery disable
  atomically cancels every safely unsubmitted manual and automatic message and
  releases `RESERVED` budget so an old manual batch cannot send after re-enable;
  automation-only disable cancels automatic rows only. Both preserve rows,
  accepted/ambiguous history, events, and committed budget.
  (`services/whatsappAutomation.service.ts`)
- **Must preserve—enforced:** Manual reminder preview is read-only and resolves
  all final phone, payment, amount, due-date, grouping, template, variables,
  schedule, and estimate values from tenant-scoped database state. Commit accepts
  at most 100 payment IDs and 50 final recipient groups, requires
  `send_whatsapp` plus payment visibility and branch writability, binds a bounded
  idempotency key to a canonical request hash, revalidates eligibility, and
  atomically creates one grouped message with payment joins and reservations.
  It makes no Meta call. (`services/whatsappMessage.service.ts`)
- **Must preserve—enforced:** `WhatsAppMessage` is the single durable outbox.
  Its dedupe/frequency keys, non-null provider message IDs, and non-null lease
  tokens are unique; message events are append-only and deduplicated. Provider
  response/webhook events require a provider message ID; pre-provider `SYSTEM`
  suppression events keep that field null rather than fabricating a Meta ID.
  `WhatsAppMessagePayment` is the narrow many-to-many source join for grouped
  reminders and never replaces `Payment` as financial truth. Estimated and
  actual costs use INR micros while branch budget configuration uses paise;
  budget reservation/release/commit and frequency reservation occur atomically.
  A configured, versioned, effective rate card is an estimate, not a Meta invoice.
- **Must preserve—enforced:** The automation planner advances durable circular
  compound-key cursors instead of rescanning fixed head pages. Recipient work
  advances only at a complete shared-phone boundary, and collection candidates
  are built only when every current DUE source row for that phone group fits the
  bounded scan; a truncated source set must fail closed rather than appear
  debt-free. Payment-resolution scans remain bounded and revisit unfinished
  events after reaching the tail. (`services/whatsappPlanner.service.ts`)
- **Must preserve—enforced:** No Meta call runs inside a domain transaction.
  Template provisioning and message delivery follow: short authorization/claim
  transaction, a short final admission transaction, commit, bounded provider
  request, then lease-owned finalization. The final admission atomically checks
  full/requested pause state and stamps `providerCallAdmittedAt`; unadmitted
  stale submissions are safely requeued while admitted stale submissions become
  `UNKNOWN`.
  The dispatcher rechecks provider mode, integration/message flags, Live
  delivery canary, tenant, entitlement, writability, sender assignment, consent
  and mapping, approved managed binding, source payments/events, schedule,
  frequency, and reserved budget immediately before submission.
  (`services/whatsappTemplateProvisioning.service.ts`,
  `services/whatsappDispatcher.service.ts`)
- **Must preserve—enforced:** Meta message submission has no application
  idempotency key. A valid response must contain exactly one bounded provider
  message ID before local `ACCEPTED`. Definite bounded rate-limit failures may be
  retried under a lease; ambiguous timeout/network/`5xx`/invalid-success results
  and stale `SUBMITTING` leases become terminal `UNKNOWN`, keep budget committed,
  and are never automatically retried. Only stale pre-submission claims may be
  requeued, and a stale worker cannot finalize newer state.
  (`lib/metaWhatsApp.ts`, `services/whatsappDispatcher.service.ts`)
- **Must preserve—enforced:** The signed public webhook is bounded to 512 KiB,
  verifies HMAC-SHA256 over exact raw bytes before parsing, durably leases
  replay-safe receipts, and appends deduplicated sent/delivered/read/failed
  events. Status projection uses provider time and precedence without regression;
  events that arrive before API finalization may remain seven-day orphans for
  later attachment. Each successfully claimed signed receipt opportunistically
  purges at most 100 expired unattached events for the exact senders resolved
  from that receipt; the sender/deadline predicates are rechecked when deleting.
  Optional signed pricing/category/billable metadata is not an exact
  charge, so webhook processing never derives `actualCostMicros`. It never
  changes payment truth or sends a reply. (`services/whatsappWebhook.service.ts`,
  `lib/whatsappMessageState.ts`)
- **Must preserve—enforced:** Only normalized inbound text exactly `STOP` or the
  exact managed quick-reply payload `LABLORDS_STOP_UPDATES` opts out. Processing
  is idempotent, changes only effective consent transitions, disables mappings,
  cancels/suppresses future unsubmitted messages for that sender/phone, preserves
  accepted history, stores no raw text, sends no reply, and never interprets
  `START`, `PAID`, or natural language as consent or payment evidence.
- **Must preserve—enforced:** Payment resolution and student mutation paths may
  reconcile local unsubmitted messages/mappings inside their existing domain
  transaction only when delivery state can exist; they never call Meta. A
  payment transition locks each linked message and leaves submitted history
  immutable. A scheduled or pre-submission-claimed grouped manual/automatic
  collection row may remain only when other current DUE payments still derive a
  complete eligible managed message; the same row is requeued with recomputed
  payment/student joins, binding, typed variables, preview, and fingerprint and
  retains exactly one reservation. Otherwise it is cancelled and its reservation
  is released. Payment identity, immutable `PaymentResolutionEvent`, allowed
  payment transitions, anniversary-based generation, and later dues remain
  authoritative and unchanged. Messaging cannot create, resolve, waive, or mark
  a payment paid.
  (`services/payment.service.ts`, `services/student.service.ts`,
  `services/whatsappPaymentReconciliation.service.ts`,
  `services/whatsappRecipient.service.ts`)
- **Must preserve—enforced:** Existing AI `MessageDraft` records remain
  human-reviewed copy suggestions, not managed templates or outbox rows. The
  provider client exposes only controlled managed Utility-template creation and
  one approved individual template send; there is no free-form, media,
  marketing, authentication/OTP, arbitrary-recipient/template, automatic-reply,
  or AI-to-provider capability.

## WhatsApp aggregate reports and operational hardening

- **Must preserve—enforced:** A report subscription is self-service only and
  proves control of the exact normalized WhatsApp phone through a signed inbound
  `START REPORTS <code>` challenge for the exact assigned sender. The ten-
  character challenge is stored only as a sender/subscription/phone-bound hash,
  expires after 15 minutes, and allows at most five failures. Confirmation
  rechecks current owner or staff membership, tenant and branch scope, sender
  assignment, entitlement, writability, and every report permission inside the
  transaction before activating `OWNER_REPORT` consent. No owner or manager may
  confirm another user's phone. (`lib/whatsappReportConfirmation.ts`,
  `services/whatsappReport.service.ts`, `services/whatsappWebhook.service.ts`)
- **Must preserve—enforced:** Normalized report confirmation commands retain the
  inbound provider message ID. Repeated copies of one provider identity are
  deduplicated, while distinct message IDs from the same sender/phone remain in
  provider envelope order.
- **Must preserve—enforced:** Branch reports require the current user to hold
  `view_whatsapp`, `receive_whatsapp_reports`, `view_payments`, and `analytics`
  for that branch, plus `WHATSAPP_AUTOMATION` entitlement and writable scope.
  Organization reports are owner-only. Removal, permission loss, sender
  reassignment/disconnect, owner change, or user-phone change makes affected
  subscriptions stale or paused and cancels only safely unsubmitted report
  rows; it never transfers consent or deletes submitted history.
- **Must preserve—enforced:** Exact signed `STOP REPORTS`, the exact managed
  `Stop reports` quick-reply label, and its compatibility payload opt out only
  `OWNER_REPORT`, pause matching subscriptions, and cancel unsubmitted reports.
  Existing exact full `STOP` also pauses reports while preserving its broader
  operational-consent behavior. Neither command sends a reply, logs raw text,
  or changes payment truth.
- **Must preserve—enforced:** Every daily report message references an immutable,
  versioned, hash-validated snapshot created before its outbox row. Snapshots
  contain aggregates only and bind one canonical UTC `metricsAsOfAt`. Payments,
  active-student state, shift-slot capacity/use, canonical open dues/overdue,
  and aggregate WhatsApp outcomes are calculated and labelled at that one
  transaction-snapshot instant. They contain no student, staff, phone, payment,
  seat, or variable branch list and never describe shift-slot allocation as
  attendance. Delayed sends reuse the original snapshot.
- **Service-layer contract—not DB-enforced:** Report day/cutoff calculations use
  the organization's IANA timezone. Reports are prospective, schedule only in
  the reviewed 18:00–23:30 local window (default 21:00). Catch-up ends
  exclusively at the earlier of one hour after cutoff or next local midnight;
  a planner does not synthesize a full historical backlog. A missed window or
  unprovable canonical metrics set creates bounded safe `REPORT_FAILURE`
  evidence and skips/suppresses before provider submission. Branch report
  metrics and organization totals share the same canonical definitions.
- **Must preserve—enforced:** Snapshot identity is `(scope, scopeKey,
  localReportDate, scheduledCutoffAt, metricsVersion)`. Same-scope subscriptions
  with the same cutoff share one immutable snapshot. Different per-subscription
  cutoffs create distinct snapshots, source fingerprints, and message dedupe
  identities and may both be delivered during their own trust windows.
- **Must preserve—enforced:** Branch daily reports use the existing branch
  estimated monthly budget and automatic daily frequency reservation.
  Organization reports use the distinct owner-configured organization report
  budget and may have a null branch; they must never consume an arbitrary
  branch's budget. Snapshot creation, idempotent outbox creation, frequency
  reservation, and budget reservation are atomic. Cancellation releases only a
  `RESERVED` estimate; accepted or ambiguous work remains committed.
- **Must preserve—enforced:** Operational service notices are limited to the
  server-owned `BRANCH_CLOSED`, `HOURS_CHANGED`, and `MAINTENANCE_WINDOW`
  contracts, reason labels, typed dates/times, and managed Utility templates.
  There is no browser-authored provider text, AI copy, promotion, media, payment
  link, OTP, or generic broadcast. The audience is derived from current active
  branch mappings for the assigned sender with current `OPERATIONAL` opt-in,
  deduplicated by phone, and contains no student name. More than 500 unique
  recipients rejects the whole request before reservation.
- **Must preserve—enforced:** Notice preview is read-only. Queueing requires a
  bounded idempotency key, explicit estimated-charge confirmation, no more than
  30 days of scheduling horizon, a safe local send time, current authorization,
  exact provider-approved Utility binding, and an atomic full-audience branch-
  budget reservation before one outbox row per unique phone. Cancellation and
  completion reconcile only safe local rows; a notice with already submitted
  recipients may be `PARTIAL` and history remains immutable.
- **Must preserve—enforced:** Collections, branch reports, organization reports,
  and service notices share the one `WhatsAppMessage` outbox but have separate
  strict source validators. Only organization reports may omit `branchId`.
  Every dispatcher claim rechecks its purpose-specific immutable source,
  subscription or consent, permissions, sender, managed binding, language,
  schedule, frequency, budget, flags, canaries, rate card, and safety state
  immediately before the provider call. Existing collection validation remains
  unchanged.
- **Must preserve—enforced:** The operator-owned INR rate card has a version,
  strict UTC effective time, and strict UTC expiry. Preview may describe an
  unavailable estimate, but reservation/planner/dispatcher work fails closed
  before effectiveness and at expiry. Estimated cost is never presented as a
  Meta invoice or exact charge.
- **Must preserve—enforced:** Live automatic collection and report work requires
  the organization in both the manual-delivery canary and the separate
  automation canary. Report, report-planner, notice, provider-health, operations-
  UI, and Live automation gates are independent and false/empty by default;
  malformed canary input enables no organization. Machine cron authentication
  does not bypass tenant entitlement, current source eligibility, or sender
  safety.
- **Must preserve—enforced:** Sender safety is local and conservative. Three
  ambiguous outcomes or ten reviewed sender/provider failures in a rolling ten-
  minute window pauses new submissions; an invalid individual destination does
  not count. A pause request blocks every new provider admission, remains
  pending until earlier durable admissions drain, and becomes fully paused only
  when no admitted `SUBMITTING` message remains. Manual pause makes no Meta
  mutation. Owner-only resume requires
  explicit confirmation, a current rate card, active unrestricted sender,
  recent successful unrestricted read-only reconciliation, healthy exact
  bindings for current queued work, and healthy templates for currently enabled
  or configured functionality, with no blocking critical incident. Unused
  languages and optional templates do not block resume, but each send still
  fails closed without its exact binding. Resume never retries an `UNKNOWN` row
  or removes incident history.
- **Must preserve—enforced:** Operational incidents are tenant-scoped,
  deduplicated, and contain only bounded safe codes/details. Every ambiguous
  submission and stale `SUBMITTING` lease has inspectable evidence and is never
  automatically retried. A later valid signed provider status may project the
  original row and resolve its incident without resending. Acknowledgement
  records human awareness only; it cannot invent provider resolution.
- **Must preserve—enforced:** Provider-health reconciliation is read-only and
  bounded to WABA, phone/registration/quality/restriction, subscribed-app, and
  template status/category queries. It uses database leases, mode/health
  canaries, and fixed timeouts; an ambiguous read preserves prior provider truth.
  It may not register a phone, subscribe an app, create a template, send a
  message, remove an asset, or share credit. Webhook-stale incidents require
  recent provider activity that made a callback reasonably expected; idle sender
  silence alone is not an incident.
- **Must preserve—enforced:** Cron run evidence contains integer-only aggregate
  counts and bounded status/error codes—never IDs, names, phones, amounts,
  message content, or secrets—and expires after 30 days. Daily maintenance may
  expire confirmation challenges and old pending subscriptions, recover safe
  stale leases, reconcile notice completion, detect stuck work, and delete
  unreferenced report snapshots older than 400 days in bounded batches. It never
  deletes accepted message, consent, or audit history, resolves a payment, or
  calls Meta.

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

- **Must preserve—enforced:** Report/draft admission is serialized per branch
  and generation kind. Only the current unexpired token publishes; stale cleanup
  cannot clear a successor. Draft admission reserves the five-minute cooldown
  before Gemini, including failed publication, and GET/POST expose that deadline.
  Draft replacement is transactional with one non-null-student logical draft per
  branch/student/action/language. Reports keep existing cache/staleness rules.
- **Must preserve—enforced:** Report confirmation/stop redelivery is deduplicated
  by sender and provider message ID, atomically with challenge mutation, even
  across different webhook batches. Full STOP and outbox delivery rules remain
  unchanged. (`services/whatsappWebhook.service.ts`)
- **Must preserve—enforced:** Import payment aliases are explicit normalized
  values. Unsupported nonempty methods, including cheque, create
  `INVALID_PAYMENT_METHOD` row errors; empty optional methods remain optional.

- **Must preserve—enforced:** Daily trend ranges contain at most 31 points,
  preserve existing month-to-date and 30-day presets, and require real dates in
  ascending order before any per-day snapshot queries. AI report access requires
  `analytics` and `view_payments` for the entire cached/generated response.
- **Must preserve—enforced:** Branch detail and settings response staff
  projections require `manage_branch` and `STAFF_MANAGEMENT`, including counts
  and nested identities. Ownership alone does not bypass this entitlement.

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
