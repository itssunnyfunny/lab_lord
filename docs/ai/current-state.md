# Lab Lords: Current Architecture and Implementation State

> Last verified: 2026-08-23
>
> Repository anchor: PR3 WhatsApp template-delivery and collections working tree
>
> Scope: repository implementation only

This document is a durable orientation map for engineers and AI agents. It records what the repository implements at the anchor above, which surfaces are gated or incomplete, and where the authoritative evidence lives.

It is **not** a deployment record. The repository cannot prove which migrations have been applied to Preview or Production, which feature flags are enabled, whether provider accounts are ready, or whether scheduled jobs and webhooks are currently healthy. Verify those facts in the target environment before operational work.

## Refresh contract

Refresh this snapshot whenever a change materially alters architecture, route or
service ownership, schema, external integrations, release gates, implemented
features, or known limitations. Re-inspect the relevant code, schema, migrations,
tests, and workflows; then update both the verification date and repository
anchor. Do not turn an environment or provider assumption into deployment truth.

## Product and architecture

Lab Lords is a multi-tenant SaaS micro-ERP for Indian study halls, reading-room libraries, coaching centres, and tuition centres. It manages organizations and branches, students, seats and shifts, allocations, branch fee collection, staff access, analytics, AI-assisted review, data imports, and Lab Lords subscription billing.

The dominant application flow is:

```text
Browser page or component
  -> Next.js App Router API route
  -> Clerk session resolution
  -> owner/staff authorization
  -> subscription entitlement and writable-state checks
  -> domain service or deterministic analytics
  -> Prisma
  -> PostgreSQL
```

AI extends this flow; it does not replace domain services:

```text
Prisma-backed domain data
  -> deterministic analytics / validation
  -> deterministic risks, actions, and guardrails
  -> Gemini narrative or mapping assistance
  -> sanitization and deterministic fallback
  -> persisted advisory result or reviewed import plan
```

Import Assistance V2 adds a durable execution path without moving business
truth into the orchestrator:

```text
Authenticated import start / confirmed immutable plan
  -> PostgreSQL ImportRun and deterministic ImportRunItem ledger
  -> Workflow 4.6 receives one opaque run ID
  -> bounded Workflow step claims at most 25 persisted items
  -> transaction-aware domain service rechecks authorization and writability
  -> business mutation and item success marker commit together
  -> redacted progress/results remain in PostgreSQL
```

Uploaded bytes, staged rows, branch configuration, complete mutation payloads,
and authorization conclusions do not cross the Workflow input/output boundary.

WhatsApp adds independently gated onboarding, template, outbox, and webhook
paths:

```text
Authenticated organization owner + one-time hashed connection intent
  -> short database claim/lease
  -> server-side Meta code exchange and provider-authoritative WABA/phone checks
  -> idempotent system-user and WABA-subscription reconciliation
  -> short lease-owned sender/audit finalization transaction

Owner-managed catalogue installation
  -> local provisioning claim commits
  -> provider lookup/create outside the transaction
  -> lease-owned provider-authoritative template/binding finalization

Authorized branch manual request or deterministic planner
  -> current student/payment/recipient/consent/template validation
  -> atomic outbox + frequency + estimated-budget reservation
  -> bounded dispatcher claim commits
  -> one approved Utility-template request outside the transaction
  -> lease-owned ACCEPTED/FAILED/UNKNOWN finalization

Signed webhook receipt
  -> durable receipt lease
  -> append-only status event / timestamp-safe projection
  -> exact STOP opt-out and future unsubmitted-message cancellation
```

Meta calls never run inside a domain transaction. Ambiguous message acceptance
becomes `UNKNOWN`, keeps estimated budget committed, and is not retried
automatically. Repository capability is not deployment readiness: all new
provider/planner flags fail closed and no real customer operation is verified.

### Declared runtime

The versions below come from `package.json` at the repository anchor:

- Next.js 16.2.5 with the App Router
- React 19.2.6 and TypeScript 5
- Tailwind CSS 4 and shared CSS design tokens
- Prisma 7.8 with PostgreSQL
- Clerk through `@clerk/nextjs`
- Google Gemini through `@google/genai`
- Razorpay through the repository's server-side REST client and hosted Checkout script
- Vercel Workflow 4.6.0 through `workflow`, with Next.js integration and a
  PostgreSQL business ledger
- Vitest 4.1 and Playwright 1.62
- pnpm as the package manager

Prisma connects with `@prisma/adapter-pg` when `DATABASE_URL` is a normal PostgreSQL URL. It uses Prisma Accelerate when `ACCELERATE_URL` is set or the database URL uses the `prisma://` scheme. Application code must use the shared client in `lib/prisma.ts`.

## Identity, tenancy, and authorization

Clerk is the identity provider. `proxy.ts` protects authenticated page families
such as `/account`, `/app`, `/branch`, `/onboarding`, and `/org`. API routes are
included in the middleware matcher but are not covered by `isProtectedRoute`.
User-facing API handlers call `getSessionUser()` and enforce authorization;
machine-owned cron routes instead verify `CRON_SECRET`, Workflow's internal endpoint
uses the framework-controlled provider boundary, and the Razorpay webhook
verifies its raw-body signature before processing. The public Meta endpoint at
`/api/whatsapp/webhook` is also deliberately outside Clerk: GET uses Meta's
bounded verification challenge, and POST verifies HMAC-SHA256 over untouched
bounded raw bytes before parsing or storing receipt metadata.

`lib/auth.ts` maps a Clerk identity to the local Prisma `User`:

- first by unique `clerkId`;
- then, for legacy/seeded users, by normalized primary email;
- otherwise by creating a new local user;
- with unique-constraint handling for concurrent first requests.

The tenant hierarchy is `User -> Organization -> Branch`:

- an organization has one owner;
- operational records belong to a branch directly or through a branch-owned relation;
- staff membership is branch-specific and has role `MANAGER` or `STAFF`;
- organization owners are implicitly allowed for their own branches;
- staff permissions come from the role matrix plus optional per-action overrides;
- subscription entitlements can further restrict staff management, advanced analytics, and AI;
- mutation routes must also respect organization access mode and branch billing state.

Normal application queries and services enforce tenant isolation, but the schema
does not define PostgreSQL row-level security or composite same-branch foreign
keys for every related record. Some ID-first mutation paths also distinguish an
existing foreign record from a nonexistent record. Every read and mutation must
therefore preserve explicit organization/branch scoping, and uniform generic
tenant-safe not-found behavior remains a required target rather than a universal
current guarantee.

## Domain model

`prisma/schema.prisma` is the database contract. The main model groups are:

- Identity and tenancy: `User`, `Organization`, `Branch`, `Staff`, `StaffPermissionOverride`, `StaffInvite`.
- Operations: `Student`, `Seat`, `Shift`, `MultiShift`, `MultiShiftComponent`, `SeatAllocation`.
- Branch fee collection: `Payment`, immutable `PaymentResolutionEvent`, and
  `AuditLog`.
- AI: `BranchAIReport` and `MessageDraft`.
- Imports: `ImportSession`, `ImportRow`, `ImportQuestion`, `ImportCommit`,
  `ImportRowEvaluation`, `ImportPlan`, `ImportRun`, `ImportRunItem`, and
  `ImportRecipe`.
- SaaS billing: `OwnerTrialGrant`, `SaasRazorpayPlan`, `RazorpayPlanProvisioning`, `BillingOffer`, `OrganizationOfferGrant`, `OrganizationSubscription`, `OrganizationBillingChange`, `OrganizationSubscriptionInvoice`, `OrganizationSubscriptionHistory`, and `RazorpayWebhookEvent`.
- WhatsApp: organization-owned `WhatsAppSender`, leased connection and template
  provisioning state, branch settings/rules, provider-authoritative templates
  and managed bindings, current and append-only consent, explicit student
  recipients, manual-send requests, one durable `WhatsAppMessage` outbox with
  payment-source joins and append-only events, leased webhook receipts, and
  append-only audit evidence.

Two payment domains must not be confused:

1. `Payment` represents fees owed by a student to a branch. It has `DUE`, `PAID`, and `WAIVED` states.
2. `OrganizationSubscription` and its related models represent fees owed by an organization to Lab Lords through Razorpay.

## Implemented product surfaces

### Workspaces and onboarding

- Clerk-backed sign-in and sign-up are wired.
- Workspace routing chooses between onboarding, an organization workspace, or the most relevant staff branch.
- Onboarding creates the owner profile update, organization, first branch, shifts, optional multi-shifts, seats, and owner staff membership in one Prisma transaction.
- When Workspace Billing V2 is enabled, onboarding also starts the single-owner 30-day trial and records the selected post-trial plan.
- The transaction has no request-idempotency guard. Retrying the same completed
  onboarding submission can create another independent organization/network.

Authoritative code: `lib/auth.ts`, `lib/workspaceRouting.ts`, `services/user.service.ts`, `services/onboarding.service.ts`, and `app/api/onboarding/route.ts`.

### Branch operations

- Student create, import, update, status changes, fee-source links, billing start date, and paginated listing are implemented.
- Seats can be created individually or generated from a numbering configuration.
- Branches have primary shifts and composed multi-shifts.
- Shift deletion is soft deletion and requires an explicit resolution for affected allocations.
- Seat allocations preserve history through `startDate` and nullable `endDate`.
- Allocation writes use serializable transactions with retry handling and validate branch ownership, active student/shift state, exact conflicts, and time overlaps for both the seat and student.
- Releasing one allocation belonging to a multi-shift releases the complete related bundle.
- Student creation and its optional admission payment are atomic, but an
  optional initial seat allocation runs afterward. Allocation failure leaves
  the student and admission payment committed.
- Branch search, settings, dashboards, notifications, and workspace switching are wired to real API routes.

Authoritative code: `services/student.service.ts`, `services/seat.service.ts`, `services/shift.service.ts`, `services/multiShift.service.ts`, and `services/seatAllocation.service.ts`.

### Student fee collection

- Monthly and admission payment records are implemented.
- Monthly catch-up and replay use typed
  `(studentId, type, periodStart)` uniqueness plus duplicate skipping. Admission
  and the first monthly cycle can safely coexist at the joined-date
  `periodStart`, while a second monthly row for the same cycle remains blocked.
- Paid and waived mutations are server-confirmed and paid/waived status is not inferred by the client.
- Current transitions are not terminal: the service permits `PAID -> WAIVED`
  and `WAIVED -> PAID`, and a waiver retains earlier payment metadata.
- Each real transition to `PAID` or `WAIVED` appends an immutable payment
  resolution event in the same transaction as the payment mutation and existing
  audit. Events snapshot the trusted payment and actor/source context; repeated
  target-status commands create no event, and later corrections preserve every
  earlier event. The ledger begins with this migration and does not invent
  events for historical resolutions.
- Marking paid records the method/reference, writes an audit entry, and removes obsolete AI message drafts for the student.
- Overdue state is derived centrally using a hard-coded rule of strictly more
  than seven calendar days; the stored `paymentGraceDays` setting is not read.
- `/api/cron/payments/daily` generates due payments for active students and requires `Authorization: Bearer <CRON_SECRET>`.

Authoritative code: `services/payment.service.ts`, `analytics/payment.analytics.ts`, and the payment API routes.

### Staff and access control

- Owners, managers, staff, role defaults, per-user permission overrides, and entitlement-aware access are implemented.
- Staff invitations use unpredictable email-bound tokens containing an email hash and random secret; the email hash is checked at acceptance.
- Invite creation, listing, acceptance, expiry, and revocation are implemented.
- Server-side authorization remains authoritative; client capabilities only control presentation and recovery links.
- `view_whatsapp`, `send_whatsapp`, and `manage_whatsapp` are overridable branch
  actions. WhatsApp actions also require the internal
  `WHATSAPP_AUTOMATION` entitlement, which is present on Standard/`PRO` and
  hidden higher plans but deliberately absent from Basic and public pricing
  capability output. PR2 defines `send_whatsapp` for forward-compatible RBAC;
  it does not expose a send route.

Authoritative code: `services/staff.service.ts`, `services/staffInvite.service.ts`, `services/staffInviteSecurity.ts`, `lib/branchCapabilities.ts`, and `app/api/branches/[branchId]/access/route.ts`.

### WhatsApp managed Utility delivery and collections

The working tree extends the PR2 sender foundation with a deliberately narrow
official Meta Cloud API delivery capability. It is repository implementation,
not evidence that any environment or provider account is ready.

- `lib/metaWhatsApp.ts` pins Graph API `v25.0`. The two PR3 provider writes are
  controlled creation at `POST /{WABA_ID}/message_templates` and one individual
  approved template at `POST /{PHONE_NUMBER_ID}/messages`. The client has no
  free-form, media, marketing, authentication/OTP, arbitrary-template,
  arbitrary-recipient, reply, credit-sharing, or provider-billing method.
- `lib/whatsappManagedTemplates.ts` defines a versioned deterministic catalogue
  for `en_IN` and `hi` only. Template creation hardcodes `UTILITY`, uses typed
  components and synthetic samples, and requires owner authorization plus the
  integration/template-write/mode/canary gates. Provisioning leases local work,
  queries before create, and reconciles ambiguous creation before deciding
  `UNKNOWN`; only an exact `APPROVED`/`UTILITY` provider template activates a
  binding.
- `WhatsAppStudentRecipient` proves which exact current normalized phone may be
  used for a student through an assigned sender. Individual and bounded bulk
  routes record versioned operational consent and mapping atomically. Existing
  consent starts `UNKNOWN`; phone change, inactivation, disable, and exact STOP
  update local mapping/future-message state without deleting history or calling
  Meta.
- Branch settings separate delivery, automation activation, deterministic stage
  rules, language/tone, local send time, frequency ceilings, configuration
  revision, and a monthly estimated budget. Existing branches remain disabled.
  Existing students are `LEGACY`; only prospective `MANUAL` enrollment is
  welcome-eligible, while imports are `IMPORT`. Disabling branch delivery
  atomically cancels safe unsubmitted manual and automatic rows and releases
  reserved budget; disabling automation cancels automatic rows only. Both
  preserve accepted/ambiguous history.
- Manual payment-reminder preview and commit accept payment identifiers rather
  than final delivery values. The server resolves tenant-owned payments,
  students, recipients, consent, approved binding, current amount/due date,
  grouping, typed variables, schedule, and configured estimate. Commit binds an
  idempotency key to the request hash and atomically creates the manual request,
  grouped outbox messages, `WhatsAppMessagePayment` links, frequency keys, and
  budget reservations; it makes no provider call.
- The bounded planner persists circular recipient and payment-event keyset
  cursors with the same transaction as its outbox reservations. Shared-phone
  recipient groups are never split across candidate construction; DUE counts
  select only whole groups whose complete source rows fit the per-run ceiling,
  and event cursors wrap so an ineligible fixed head cannot starve later work.
  Send-time source verification also fails closed if an exact source group
  exceeds either scan ceiling.
- The bounded dispatcher leases due outbox rows and revalidates current tenant,
  entitlement, writability, sender, mapping/consent, template, source,
  schedule/frequency, mode/gates, and reserved budget before setting
  `SUBMITTING`. It commits before calling Meta. A valid response requires one
  `wamid`; definite rate limits are bounded, definite rejection fails safely,
  and ambiguous timeout/network/`5xx`/invalid-success state becomes terminal
  `UNKNOWN` with no blind retry.
- Signed webhooks lease durable receipts, append deduplicated status evidence,
  retain seven-day orphan events that precede API finalization, opportunistically
  purge at most 100 expired orphans for the receipt's resolved senders, and project
  sent/delivered/read/failed without timestamp regression. Only bounded
  authoritative billable/category and recipient values are stored; provider
  pricing metadata is not an exact charge, so `actualCostMicros` remains null.
  Only normalized text exactly `STOP` or exact
  payload `LABLORDS_STOP_UPDATES` opts out; no raw body/text/error is stored, no
  payment is mutated, and no automatic reply is sent.
- Student phone/inactivation and payment-resolution services reconcile only
  local unsubmitted delivery state inside their existing transaction when the
  delivery schema can exist. Payment transitions lock linked outbox rows,
  re-derive a still-justified grouped manual/automatic collection row around
  its remaining DUE sources while retaining one reservation, and cancel/release
  it when no complete valid candidate remains. Submitted history and unrelated
  later dues are untouched. These paths do not call Meta and do not alter payment
  identity, immutable resolution evidence, or allowed transitions.

The mutation paths are intentionally closed:

| Entry point | Local effect | External effect and authority |
| --- | --- | --- |
| Owner sender connection, registration, assignment, sync, disconnect | PR2 sender/template/audit state | Existing bounded onboarding mutations or provider reads; owner, entitlement, writability, onboarding flag, mode, and onboarding Live canary |
| `POST .../managed-templates/install` | Lease/provisioning/template/binding/audit state | The only new template mutation; owner plus template-write flag and delivery Live canary; query/reconcile before create |
| Recipient, settings, delivery, automation, and manual-reminder branch routes | Consent/mapping/settings/rules/manual request/outbox/budget only | No provider call; branch permission, payment permission where applicable, entitlement, writability, and tenant checks |
| Payment/student domain mutations | Refresh, cancel/suppress, or stale only eligible local unsubmitted recipient/message state | No provider call; existing payment/student transaction remains authoritative |
| Authenticated WhatsApp planner cron | Deterministic leases and automatic outbox/budget reservations | No provider call; planner flag plus tenant/entitlement/configuration eligibility |
| Authenticated WhatsApp send cron | Lease and final message/budget/event state | The only new message mutation; message-write flag, mode, delivery canary, and full send-time revalidation |
| Signed public webhook | Receipt/event/status/template/opt-out projection | No outbound provider or payment action; raw-byte HMAC, replay lease, bounded parsing |

Local Development and Vercel Preview accept `TEST`; Vercel Production accepts
`LIVE`; tests inject a fake provider. `WHATSAPP_INTEGRATION_ENABLED`, onboarding,
managed-template, message-write, planner, and webhook flags all fail closed.
`WHATSAPP_LIVE_CANARY_ORG_IDS` gates Live onboarding, while the separate
`WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS` gates Live template and message writes.
The utility rate, rate-card version, and UTC effective time are required for
estimation and are never inferred from Meta status metadata.

The organization WhatsApp panel adds managed-template installation state; branch
settings expose delivery/budget/rules/prospective-automation controls and message
history; student management exposes explicit recipient/consent controls; and the
overdue workspace adds deterministic official-reminder preview/queueing alongside
the separate AI review/copy workflow. Server-side services remain authoritative;
UI visibility or a successful preview is never send authorization. Existing AI
overdue drafts never enter the official outbox.

No real Meta App Review/Advanced Access, app, Embedded Signup, WABA, template
creation/approval, phone registration, message send, webhook delivery, customer
asset, legal/privacy approval, effective rate-card signoff, Preview/Production
configuration, deployment, migration, or Live canary has been verified from
repository evidence. ADRs 0002 and 0003 remain Proposed and require explicit
human-owner approval.

Authoritative code: `lib/metaWhatsApp.ts`, `lib/whatsappFeature.ts`,
`lib/whatsappManagedTemplates.ts`, `lib/whatsappCost.ts`,
`lib/whatsappMessageState.ts`, `services/whatsapp*.ts`, WhatsApp API/cron routes,
the two WhatsApp migrations, focused tests, and the Proposed ADRs.

### Deterministic analytics

- Branch and organization snapshots are implemented for student status, seating, shift-slot utilization, collections, outstanding dues, and overdue balances.
- Capacity is measured in shift slots, not only physical seats. Compatibility fields named `totalSeats` or `occupiedSeats` may therefore contain slot counts; use the explicit occupancy snapshot fields when changing analytics.
- Branch and organization trend routes are implemented.
- Advanced branch and organization analytics require the corresponding staff permission/ownership and the `ADVANCED_ANALYTICS` entitlement.

Authoritative code: `analytics/`, `services/seat.service.ts`, and `app/api/analytics/`.

### Import assistant

The persisted import wizard accepts CSV, XLS, XLSX, PDF, and pasted tables. A
complete request is capped at 4.25 MiB; the source is capped at 4 MiB, 2,000
rows, 64 columns, and 8 KiB per cell. XLS/XLSX inspection also caps declared or
measured expanded content at 32 MiB, exposes sheets and header candidates, and
requires a sheet choice for multi-sheet workbooks. PDF remains text-extraction
beta without OCR or visual-table guarantees. Parsers stop accumulating at the
row ceiling plus one rather than materializing an arbitrarily large valid
source before rejecting it.

The flow is:

1. Validate request size, file signature/type, encoding, parser structure, and
   positional headers before persisting raw rows in chunks.
2. Profile the source, run deterministic mapping first, and send Gemini only
   sanitized aliases for ambiguous headers plus masked value shapes and
   structural source/branch summaries.
3. Sanitize the model response and use deterministic fallback when it is
   absent, invalid, low-confidence, or duplicates a target.
4. Normalize and validate students, seats, shifts, allocations, duplicates,
   conflicts, and payment decisions; student/configuration labels and planned
   shift overlaps and multi-shift component cardinality/combination uniqueness
   follow the same deterministic domain rules used at mutation time, and
   Indian 10/11/12-digit phone forms share the student service's canonical
   duplicate identity. Preserve manual corrections by advancing the draft
   revision.
5. Publish a complete immutable evaluation set for the current revision.
6. Compile an immutable, canonical-hash plan with
   `READY_ROWS_ONLY` or `REQUIRE_ALL_ROWS_READY`. A plan whose deterministic
   item count exceeds `IMPORT_MAX_PLANNED_MUTATIONS` is non-runnable; expansion
   stops at cap plus one so historical payment fan-out cannot allocate the
   entire over-limit plan first.
7. Bind the confirmed plan/revision to an idempotent PostgreSQL run and start
   Workflow using only the run ID.
8. Apply deterministic configuration, student, allocation, and payment-cycle
   items in short transactions. Each transaction rechecks the requesting
   user's current permission, entitlement, branch writability, object scope,
   plan revision, linked prices/bundle structure, exact existing payment-cycle
   facts, and lease, then commits the mutation with its success marker.
9. Preserve redacted entity-ID/count results, progress, retry/cancellation
   state, and partial outcomes. Ready-only plans remain partial while reviewed
   rows are unresolved, and every terminal repair run idempotently projects its
   row results even when the session was already partial. Repair publishes a
   new revision and plan.

There is no whole-file transaction. `REQUIRE_ALL_ROWS_READY` is a pre-run gate;
already successful items remain committed if a later runtime item fails.
Deterministic keys, request hashes, one-active-run enforcement, leases, bounded
attempts, and compare-and-set completion make retries replay-safe rather than a
rollback mechanism. Repair reuses prior successful row mutations only when
their canonical semantic hashes still match the reviewed data. Configuration
claiming also holds dependent multi-shifts until their seat/shift prerequisites
have settled. A run that succeeds for every scheduled item but deliberately
leaves blocked, skipped, or otherwise unscheduled rows is completed with issues,
so the session remains partial and those rows can be repaired through a newer
revision.

The initial analysis run is created in the same transaction as its session and
rows. If Workflow dispatch fails, create/analyze/commit/retry still return the
durable run ID with `dispatchRequired`; an authorized resume POST rechecks the
same commit-start trust boundary before re-dispatch. Stale attached runs are
reconciled with provider state: an active provider owner is retained, while a
terminal or missing owner is database-fenced by its exact ID before a
replacement Workflow can attach. Provider lookup failures retain the existing
owner for a later retry. Provider Workflow IDs are not returned by polling or
session detail.

Organization-scoped recipes are available through branch-authorized routes.
They retain only source type, a server-computed normalized-header signature,
normalized column mappings, goal, and entity types—never samples, row values,
branch configuration, or import/payment/default/conflict options.

Exact remaining payment-cycle review is exposed from immutable plan items by a
tenant-authorized, required-permission-checked API page of at most 100 cycles;
the plan response retains only bounded per-student aggregates. Terminal or
inactive-draft staging receives a 30-day `purgeAfter`. The daily
`/api/cron/imports/daily` job drains at most 20 batches of 100 sessions, rechecks
deadlines under lock, terminalizes stale active runs and nonterminal items,
scrubs run-item execution payloads/errors, and reports any remaining backlog
while retaining redacted run history. V2 start routes fail closed unless
`IMPORT_V2_ENABLED=true`; repository code cannot prove the flag or retention
schedule is active in a deployment.

Production enablement remains blocked pending the human decisions listed in
the Proposed Workflow ADR: provider/security and data-residency approval,
Fluid Compute/runtime confirmation, measured 100/500/2,000-row benchmarks, a
benchmark-derived mutation cap with two-times passing headroom, recorded
analysis/completion SLOs, monitoring, and rollback authority. Installed code is
not evidence of that approval.

Authoritative code: `importing/`, `lib/importFeature.ts`, the import-session and
recipe API routes, `app/api/cron/imports/daily/route.ts`, the import wizard under
`app/branch/[branchId]/onboarding/import/`, the V2 migration, and
`docs/decisions/0001-managed-workflow-for-import-execution.md` (Proposed, not
Accepted).

### Lab Lords subscription billing

The repository contains both legacy billing and Workspace Billing V2.

- `BASIC` is displayed as Basic and costs INR 299 per active branch per month.
- Database plan `PRO` is displayed as Standard and costs INR 499 per active branch per month.
- Standard grants staff management, advanced analytics, AI access, and the
  internal `WHATSAPP_AUTOMATION` entitlement. WhatsApp remains absent from
  public pricing output; held repository delivery capability is not a launch or
  customer promise.
- Workspace Billing V2 derives subscription quantity from billable branch
  lifecycle state. Pending activation and scheduled removal affect quantity
  sequencing, so it is not simply a count of rows currently marked `ACTIVE`.
- Owner trial state, branch activation/removal, plan changes, quantity changes, cancellation, recovery, payment-method replacement, invoices, subscription history, and provider reconciliation are modeled.
- Card changes can use provider subscription updates; supported non-card changes use separately authorized replacement subscriptions and controlled cutover logic.
- Razorpay plan provisioning uses database leases and provider-mode-aware catalog records.
- Webhook processing verifies the raw-body HMAC, persists unique event receipts, detects event-ID collisions, and reconciles provider state.
- `/api/cron/billing/hourly` processes billing deadlines and requires `Authorization: Bearer <CRON_SECRET>`.

This subsystem is implemented but deliberately release-gated:

- `WORKSPACE_BRANCH_BILLING_V2_ENABLED` gates V2 onboarding/runtime behavior.
- `RAZORPAY_BILLING_WRITES_ENABLED` gates provider mutations, with an optional controlled Live canary allow-list.
- `RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED` switches from card-only Checkout configuration to provider-managed eligible recurring methods.
- each organization retains `billingModelVersion`, so enabling the environment flag does not by itself migrate legacy organizations.

Repository code and tests do not prove that these flags are enabled in any deployment or that the target Razorpay account is approved and configured.

Authoritative code: `services/billing*.ts`, `services/ownerTrial.service.ts`, `services/razorpayPlanCatalog.service.ts`, `lib/billing*.ts`, `lib/razorpay.ts`, the organization billing API routes, and `app/api/razorpay/webhook/route.ts`.

### Public website and telemetry

- Landing, product-specific SEO pages, contact, support, privacy, terms, refund, shipping/delivery, and cookie pages are implemented.
- Google Analytics loads only when a measurement ID is configured and begins with denied consent. Events require explicit accepted consent.
- The support/bug-report form opens a pre-filled email through `mailto:`; there is no server-side support-ticket or email-delivery integration.

Authoritative code: `app/layout.tsx`, public pages under `app/`, `components/analytics/AnalyticsProvider.tsx`, `lib/tracking.ts`, and `components/feedback/BugReportForm.tsx`.

## AI behavior

All Gemini calls originate on the server through `ai/llm/gemini.client.ts`. The client reads `GEMINI_API_KEY`, supports JSON response schemas, normalizes configured model aliases, and tries configured/default fallback models only for transient-unavailable failures. Missing credentials and unusable responses return typed/null failures so callers can fall back.

### Branch health reports

`GET /api/ai/branch/[branchId]` requires:

- an authenticated local user;
- branch `analytics` authorization;
- the `AI_ACCESS` entitlement;
- a writable branch/workspace;
- the route's process-local request limit.

`runBranchAI()` then:

1. Reads branch AI state and the newest persisted report.
2. Applies a five-minute cache, same-day/current-rule checks, and a branch-level `IDLE -> RUNNING` optimistic lock.
3. Reads a deterministic branch snapshot.
4. Calculates risks, health score, and suggested actions in code.
5. Sends aggregate branch metrics and deterministic risk descriptions to Gemini for owner-facing narrative only.
6. Validates the parsed narrative and substitutes deterministic text for absent/invalid fields.
7. Persists the full response in `BranchAIReport` and releases the lock.

The reports page calls this GET route automatically when mounted. A page view can therefore cause a Gemini call when the cache/staleness rules permit it; refresh is not the only trigger.

Known failure semantic: the orchestrator writes `aiLastCalledAt` while acquiring the lock, before Gemini completes. The `finally` block returns `aiStatus` to `IDLE` but does not restore `aiLastCalledAt` after failure. A failed run can therefore impose the normal cooldown even though older documentation says otherwise.

### Overdue message drafts

Message generation is human-triggered and does not send messages.

- GET reads current overdue students and returns matching cached drafts with `allowGeneration: false`.
- POST regenerates only explicitly selected student IDs and requires analytics plus payment-view permission, AI entitlement, writability, and a process-local route limit.
- Overdue payments are grouped into one target per student.
- A single Gemini request covers the selected targets.
- The prompt includes student name, oldest due date, total due, payment count, and days overdue; it does not include the stored phone number.
- Invalid/missing Gemini output is replaced with deterministic English or Hinglish text.
- Drafts are persisted by branch, student, language, and action configuration.
- This AI draft UI remains review/copy only and has no provider integration. The
  separate PR3 official reminder flow rebuilds content from trusted typed values
  and managed Utility templates; it never reads `MessageDraft.message`.

### Import mapping

The import assistant uses Gemini for mapping assistance, not mutation.
Deterministic mapping handles known headers before any call. For only the
ambiguous columns, Gemini receives sanitized positional/header aliases, masked
value shapes, fill/uniqueness counts, and a branch summary of counts and
booleans. It does not receive raw row values, complete branch configuration,
seat/shift names, or fees. Sanitized AI suggestions still pass through
deterministic normalization, validation, user review, immutable planning, and
service-layer authorization before any data is committed.

### Legacy or currently unwired AI files

The following modules exist but are not referenced by current application routes or pages:

- `ai/reports/branchFullReport.generator.ts`
- `ai/readers/org.reader.ts`
- `ai/readers/payment.reader.ts`
- `ai/contracts/branchHealthReport.contract.ts`
- `components/ai/MessageDraft.tsx`

`hooks/useAnalytics.ts` is an empty file; current Google Analytics behavior is implemented through `AnalyticsProvider` and `lib/tracking.ts`.

## External integrations and deployment truth

| Integration | Repository truth | Deployment state |
| --- | --- | --- |
| PostgreSQL / Prisma | Required; schema and 35 timestamped migrations exist, including additive PR2 and PR3 WhatsApp expansions | Database target, applied migration set, backups, and health are unknown |
| Clerk | Real auth and local-user linking are implemented | Active instance, keys, redirect/origin configuration, and account health are unknown |
| Gemini | Reports, message drafts, and import mapping are wired with fallbacks | API key, selected model availability, quota, and data-processing configuration are unknown |
| Razorpay | Server API client, Checkout, signatures, webhook receipts, reconciliation, and plan catalog are implemented | Test/Live mode, account approvals, webhook configuration, flags, canary, and provider health are unknown |
| Meta WhatsApp Cloud API | Direct bounded `v25.0` provider client, owner-bound Embedded Signup, sender/branch state, phone registration, template reads/managed Utility creation, individual approved Utility-template delivery, durable outbox, signed status/STOP processing, and estimated-cost controls exist; arbitrary delivery and credit sharing do not | App Review/Advanced Access, app/config/system-user credentials, Test/Live assets, callback reachability, flags/canaries, template approval/category, effective rate-card signoff, customer billing/legal ownership, `UNKNOWN` review operations, and provider health are unknown |
| Vercel Workflow | Workflow 4.6 integration, opaque-ID orchestration, and a PostgreSQL import ledger/runner are implemented | Production approval, Fluid Compute/runtime setup, provider retention/residency review, feature flag, mutation cap, benchmarks, SLOs, and active-run health are unknown |
| Vercel Cron | Daily payment, hourly billing, daily import retention, WhatsApp planning every 15 minutes, and WhatsApp dispatch every 5 minutes are declared in `vercel.json`; both WhatsApp services return held before new-table/provider work when their controlling flags are false | Whether the deployment plan accepts these frequencies, the deployment is Production, schedules are active, and recent runs succeeded is unknown |
| Google Analytics | Consent-aware GA bootstrap and event helpers are implemented | Measurement ID and live collection state are unknown |
| Support email | Public pages and `mailto:` bug reports are implemented | Mailbox monitoring and response operations are unknown |

Never infer a deployed state from local `.env` files, ignored Vercel metadata, seed data, or repository defaults. Use the target environment's approved operational checks without printing secrets.

## Verification and test evidence

At this anchor the repository contains focused WhatsApp unit, component,
provider-contract, service, route, webhook, and migration-contract coverage in
addition to the existing Vitest/Playwright suites, plus 35 timestamped migration directories. These
counts are orientation data, not invariants.

### Automated coverage by area

- Auth and routing: `tests/unit/lib/auth.test.ts`, `tests/unit/proxy.test.ts`, and workspace-routing tests.
- Core services: integration suites under `tests/integration/services/` for organizations, branches, onboarding, students, seats, shifts, multi-shifts, allocations, payments, staff, invites, trials, billing, and entitlements.
- API authorization and behavior: route suites under `tests/unit/api/`.
- Imports: `tests/unit/importing/`, import route tests, and `tests/integration/importing/import-commit-flow.test.ts`.
- Import Workflow uses the separate `pnpm test:workflow` configuration in
  `vitest.workflow.config.ts`; normal import ledger/runner behavior also has
  focused unit coverage.
- Billing: extensive unit suites for policies, replacement trust/access, reconciliation, payment methods, deadlines, migration contracts, plan catalog, and checkout UI; integration billing lifecycle suites; browser billing specs.
- WhatsApp: feature/mode/canary and rate-card failures, the intentionally narrow
  provider contract, managed catalogue/provisioning, recipient/consent mapping,
  manual reminder queueing, settings/schedule/state reducers, dispatcher,
  webhook status/STOP behavior, student/payment reconciliation, migration SQL,
  route security boundaries, and staff permission/entitlement behavior.
  Automated tests inject or mock provider/browser behavior and must not contact
  Meta.
- Analytics: payment analytics integration coverage, analytics component tests, and audit scripts.
- UI: selected component/page unit tests and Playwright specs under `tests/browser/`.

`vitest.config.ts` runs tests sequentially to reduce test-database collisions. Coverage targets only `services/**/*.ts` and `utils/**/*.ts`, with 70% line and function thresholds; it is not whole-repository coverage.

`.github/workflows/ci.yml` provisions PostgreSQL, applies migrations, and runs lint, Vitest, build, and coverage on pushes and pull requests to `main`. It does **not** run `pnpm test:browser`, so the Playwright suite is not currently a CI gate in that workflow.

Production migrations have a separate manually dispatched workflow requiring the exact confirmation string and the protected `PRODUCTION_DIRECT_DATABASE_URL` secret.

### Known verification gaps

- No direct Vitest suite exercises the complete `runBranchAI()` cache/lock/failure lifecycle.
- No direct Vitest suite exercises the complete `draftOverdueMessages()` persistence/cooldown lifecycle; route tests mock it.
- AI verification scripts exist, but scripts are not equivalent to repeatable CI coverage.
- Browser tests exist but are not run by the main CI workflow.
- Repository tests do not prove deployment-pinned Workflow resume behavior,
  provider-region/retention settings, Fluid Compute configuration, benchmark
  headroom, or Production SLOs.
- The V2 domain mutation-plus-marker boundary has been exercised against an
  independently isolated local PostgreSQL container. The integration test
  injects a database failure before the success marker, proves the domain write
  rolls back, then replays the same lease and idempotent commit request without
  duplication. This does not prove Vercel deployment-pinned resume behavior or
  staging-equivalent provider/database performance.
- `pnpm benchmark:import-v2` records a synthetic local 100/500/2,000-row parser
  and immutable-plan expansion matrix, including configuration, allocation,
  current-payment, and 12-/24-month historical-payment fan-out. The dated local
  evidence is under `docs/evidence/`; it is compile-only and therefore does not
  establish the Production mutation cap or owner-approved SLOs.
- Passing repository tests cannot establish provider configuration, signed webhook delivery, cron execution, deployed migrations, or production data integrity.
- WhatsApp tests cannot establish Meta App Review/Advanced Access, current
  account permissions, a real Embedded Signup exchange, WABA/system-user state,
  template creation/approval/category, phone registration, a real message
  submission or status/STOP delivery, callback reachability, customer billing
  ownership, rate-card accuracy, legal/privacy approval, operator handling of
  `UNKNOWN`, or Test/Live deployment configuration.

## Known limitations and cautions

- `lib/rateLimit.ts` stores buckets in an in-memory `Map`. Limits are process-local, reset on restart, and are not coordinated across server instances.
- Tenant isolation is application-enforced rather than backed by database RLS.
- Foreign-existing and nonexistent resource IDs do not yet receive uniform
  tenant-safe responses across all mutation paths.
- The daily payment cron does not consult branch or organization writability;
  active students in a read-only branch can still receive generated dues.
  Whether that system-owned behavior should respect writability is unresolved
  and must not be treated as accepted without an ADR or updated domain invariant.
- Workspace Billing V2 and Razorpay writes are release-gated; implementation presence is not evidence of activation.
- Import V2 is durable and replay-safe but is not one database transaction for
  the whole file; no mode reverses already committed items.
- Import requests are still buffered in application memory. The 4.25 MiB
  request and 4 MiB source caps bound that exposure but do not provide streaming
  upload or malware scanning.
- PDF import is text-only beta and cannot reconstruct scanned or visually
  positioned tables without upstream OCR/reformatting.
- Workflow-backed Production execution is not approved merely because the
  dependency and code exist. The feature flag must remain held until the
  Proposed ADR's approval, benchmark, cap, SLO, monitoring, and rollback gates
  are satisfied.
- Trend analytics recompute from mutable current tables rather than immutable historical snapshots; some current status, shift, and archived-branch state affects past-looking results.
- Attendance is absent: there is no attendance model, service, route, or test.
- Soft-deleting a Shift does not repair existing MultiShift components or
  MultiShift-linked student fees, so a bundle can retain an inactive component.
- User and organization timezone fields default to `Asia/Kolkata`, but billing
  cycle and day calculations use runtime-local dates rather than the stored
  organization timezone.
- A failed AI report generation can still advance `aiLastCalledAt` and impose cooldown.
- AI message generation is review/copy only and is structurally excluded from
  the official provider-delivery path.
- WhatsApp managed Utility-template delivery exists in the repository but every
  provider/planner flag defaults held. New tables, provider credentials,
  schedules, callback, App Review/Advanced Access, approved Utility templates,
  customer-owned billing, rate card, legal/privacy gate, Test/Live assets, and
  external behavior have not been verified in Preview or Production.
- WhatsApp ADRs 0002 and 0003 remain Proposed. Implementation does not approve
  onboarding or delivery activation. The repository has no centralized Meta
  webhook/provider alerting, stable callback hostname, automatic rate-card
  refresh, exact provider-cost reconciliation, or operator queue/process for
  `UNKNOWN` message outcomes.
- Import staging retention depends on deployed `purgeAfter` transitions and a
  healthy authenticated daily cron; repository code cannot prove either is
  operating in Production.
- Support forms rely on the user's local email client.
- Several legacy/unwired AI files and one empty analytics hook remain in the tree.

## Documentation status at this anchor

This file supersedes architecture/status claims in older phase-oriented or generated documents when they conflict with current code.

- `product.md` is retained as a historical phase roadmap and now points here for current status.
- The stale generated application knowledge graph and contradictory AI production checklist were removed when this bridge was created.
- The two tracked `.agent` policy files are compatibility adapters only. Other local `.agent` logs, screenshots, generated metadata, and patch backups are ignored and are not repository authority.
- `docs/decisions/0001-managed-workflow-for-import-execution.md` remains
  **Proposed**. This snapshot records implemented code and explicit rollout
  blockers; it does not convert the proposal into an Accepted decision.
- `docs/decisions/0002-whatsapp-communication-foundation.md` also remains
  **Proposed**. Customer/provider setup and Production activation are not
  approved by the presence of foundation code.
- `docs/decisions/0003-whatsapp-template-delivery-and-collections.md` remains
  **Proposed**. Managed Utility delivery, estimated provider usage, automation,
  and Live rollout require human-owner/security/legal/operations approval; the
  implementation does not permit credit sharing or arbitrary/AI delivery.

When this document and the implementation disagree, inspect the current schema, migrations, services, API routes, and tests, then update this document in the same change.
