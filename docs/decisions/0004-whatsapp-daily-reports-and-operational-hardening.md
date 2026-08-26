# 0004: WhatsApp daily reports and operational hardening

- Status: Proposed
- Date: 2026-08-24
- Deciders: Pending
- Supersedes: None
- Superseded by: None

## Context

Lab Lords already has the PR3 customer-owned Meta sender, managed Utility
catalogue, explicit consent and recipient mappings, one durable outbox,
estimated budget reservations, a bounded dispatcher, signed webhook projection,
exact STOP handling, and prospective collections automation. The remaining
planned WhatsApp work is deterministic operational reporting, narrowly typed
service notices, and the production controls needed to contain uncertain or
degraded provider state.

Reports and notices may disclose business facts and incur customer-owned Meta
charges. Tenant isolation is application-enforced. A logged-in user entering a
phone does not prove control of that WhatsApp account, an accepted provider
request can have an ambiguous local outcome, and provider template category,
sender restrictions, rate cards, webhooks, and cron execution may change outside
the application. There is no attendance domain, so report wording cannot imply
check-in or presence. ADR 0003 is Accepted; ADR 0002 remains Proposed. This
proposal builds on both and changes neither status.

## Decision

### Aggregate snapshot-first reports

- Add daily branch reports and owner-only consolidated organization reports.
  Every queued report references an immutable, versioned, strictly validated
  aggregate metrics snapshot with an IANA-timezone scheduled cutoff, one
  canonical UTC `metricsAsOfAt`, canonical hash, and source fingerprint. The
  snapshot identity is `(scope, scopeKey, localReportDate, scheduledCutoffAt,
  metricsVersion)`: subscriptions with the same cutoff share one snapshot,
  while different per-subscription cutoffs create distinct snapshots. Delayed
  sends reuse their original snapshot.
- Branch reports require current branch membership plus `view_whatsapp`,
  `receive_whatsapp_reports`, `view_payments`, `analytics`, the
  `WHATSAPP_AUTOMATION` entitlement, and writable scope. Organization reports
  are visible and configurable only by the current organization owner.
- Capture `metricsAsOfAt` at the first database statement of the report
  transaction. Calculate and label payments, canonical open-due/overdue facts,
  student counts, shift-slot usage/capacity, and aggregate WhatsApp outcomes at
  that one transaction-snapshot instant. Payment corrections between the
  scheduled cutoff and `metricsAsOfAt` are therefore reflected consistently.
  Use the existing immutable payment-resolution evidence plus the transaction
  snapshot; do not introduce broad historical event sourcing for other domains.
  Do not include a student, staff member, phone, payment, seat label, or variable
  branch list. Do not call shift-slot use attendance.
- Reports are prospective from activation, default to 21:00 within the reviewed
  18:00–23:30 local window, and have an exclusive catch-up end at the earlier of
  one hour after the scheduled cutoff or the next local midnight. Do not perform
  full historical catch-up. If the window has ended or canonical metrics cannot
  be proven, record a bounded `REPORT_FAILURE` incident and skip/suppress the
  report before any provider call.

### Recipient confirmation and consent

- A user may create only their own subscription. Prove control of its normalized
  phone with exact signed inbound `START REPORTS <code>` to the exact assigned
  sender. Generate a ten-character, unambiguous 50-bit code; store only a SHA-256
  hash bound to sender, subscription, and phone; return plaintext once; expire it
  after 15 minutes; and stop after five failed attempts.
- Recheck ownership or staff membership, all permissions, tenant/sender
  assignment, entitlement, and writability inside the confirmation transaction.
  Only then opt in `OWNER_REPORT`, append real consent-transition evidence,
  activate the subscription, clear the challenge, and audit without the code.
- Preserve the inbound provider message ID on normalized report commands.
  Deduplicate repeated copies of the same provider message identity, while
  preserving distinct confirmation messages from the same phone in envelope
  order so an expired attempt cannot erase a later valid attempt.
- Exact `STOP REPORTS`, the exact managed `Stop reports` reply label, and the
  managed compatibility payload opt out only `OWNER_REPORT`, pause matching
  subscriptions, cancel unsubmitted reports, and release reservations. Existing
  exact `STOP` remains a full applicable-consent opt-out and also pauses reports.
  Neither command sends a reply.

### Typed operational notices

- Support only branch closure, changed operating hours, and maintenance-window
  notices with server-owned reason labels and typed date/time variables. There
  is no arbitrary broadcast text, promotion, marketing-category fallback, AI
  generation, media, OTP, payment link, inbox, or free-form reply.
- Derive the audience from current active branch/student-recipient mappings for
  the assigned sender with opted-in `OPERATIONAL` consent. Deduplicate shared
  phones and never include student names. Reject the entire request before any
  reservation when the unique audience exceeds 500.
- Preview is read-only. Queue requires an idempotency key and explicit estimated-
  charge confirmation, validates a maximum 30-day horizon and send safety
  window, locks the branch budget, reserves the full estimate atomically, and
  creates one outbox row per unique phone. Cancellation affects only safely
  unsubmitted rows and may leave the notice `PARTIAL`.

### One outbox, budgets, and provider boundary

- Extend the existing `WhatsAppMessage` outbox and dispatcher with purpose-
  specific source validators. Only `DAILY_ORGANIZATION_REPORT` may have a null
  branch. Collection validation remains unchanged and strict.
- Branch reports and service notices use the existing branch monthly budget;
  automatic branch reports also consume the daily automatic limit. Organization
  reports use a distinct owner-configured positive organization report budget
  and cannot be charged to an arbitrary branch.
- Require an operator-owned, versioned INR estimate rate card with strict UTC
  effective and expiry timestamps. Queue/planner/dispatcher fail closed before
  effective time and at expiry. Estimates are never represented as Meta's final
  invoice.
- Add no generic provider mutation. Reuse only the existing managed Utility
  template creation and approved Utility delivery. Provider `APPROVED` status is
  insufficient unless category remains exactly `UTILITY` and the binding matches
  the reviewed catalogue snapshot.

### Rollout, circuit breaking, and incidents

- Keep report, report-planner, service-notice, health, and operations-UI flags
  independent and false by default. In Live Production, automatic collection
  and report delivery requires membership in both the manual delivery canary and
  a separate automation canary. Malformed or empty lists enable nothing.
- Store one local sender safety state. Pause after three ambiguous outcomes in
  ten minutes or ten reviewed sender/provider failures in ten minutes. Invalid
  individual destinations do not count. Owner/operator pause is local and makes
  no destructive Meta call. A durable pause request blocks new provider-call
  admissions; any earlier admission drains before `pausedAt` is recorded. The
  bounded Meta call remains outside every domain transaction.
- Resume is owner-only and requires explicit confirmation, current rate card,
  active/unrestricted sender, recent successful unrestricted read-only
  reconciliation, healthy exact bindings for current queued work, and healthy
  templates for currently enabled/configured branch automation and report
  functionality. An unused language or optional rejected template does not
  block resume, but an individual send still fails closed when its exact binding
  is unavailable. Resume preserves incidents and never retries `UNKNOWN`.
- Persist tenant-scoped, deduplicated operational incidents with bounded safe
  codes/details. `UNKNOWN` remains terminal and nonretryable; later signed status
  evidence may project it to proven state and resolve its incident without
  resending. Human acknowledgement records awareness and never invents provider
  resolution.

### Health, jobs, and retention

- Provider-health reconciliation may only read WABA, phone/registration/quality,
  subscribed-app, restriction, and template status/category data through the
  existing client. It must not register a phone, subscribe an app, create a
  template, send, remove a provider, mutate assets, or share credit. Use bounded
  sender batches, database leases, fixed timeouts, mode/health canaries, and
  conservative updates; an ambiguous read must not erase prior provider truth.
- Track valid signed known-sender webhook receipt time, but create webhook-stale
  incidents only when recent provider activity made a webhook reasonably
  expected. Do not alert on inactive senders merely for silence.
- Store bounded cron-run evidence with integer-only counts and no IDs, names,
  phones, amounts, rendered content, or secrets. Cron authentication is a
  machine boundary and never bypasses tenant entitlement/source eligibility.
- Daily maintenance expires challenges and old pending subscriptions, recovers
  stale leases, recalculates notice completion, detects stuck work, deletes job
  evidence after 30 days in bounded batches, and may delete unreferenced report
  snapshots after 400 days. Never delete accepted message, consent, or audit
  history, resolve payments, or call Meta.

### Data and billing boundary

- Customer organizations continue to own WABA, number, payment method, Meta
  charges, and portability. Lab Lords neither funds nor re-bills Meta usage and
  does not share provider credit.
- AI output remains advisory and human-reviewed. It cannot feed a report,
  service notice, authorization decision, billing truth, or provider action.

## Alternatives considered

- **Arbitrary broadcast composer:** rejected because browser-authored provider
  text cannot establish category, necessity, recipient purpose, or bounded cost.
- **AI daily narrative:** rejected because model output is untrusted and would
  make official external content nondeterministic.
- **Owner subscribing managers without confirmation:** rejected because local
  authority does not prove control of another person's phone or consent.
- **Email or SMS fallback:** deferred; it would add a separate provider, consent,
  cost, and delivery system outside this decision.
- **Automatic retry of `UNKNOWN`:** rejected because Meta may already have
  accepted and charged the original request.
- **No circuit breaker:** rejected because a burst of ambiguous acceptances can
  multiply uncertain spend.
- **Charge organization report to one branch:** rejected because the allocation
  is arbitrary and could consume an unrelated branch's budget.
- **Marketing-category fallback:** rejected because this product scope has no
  marketing consent or promotional purpose.
- **Full historical report catch-up:** rejected because old reports are stale,
  costly, and outside the recipient's prospective expectation.
- **One scope-level report time:** rejected because it would discard the
  reviewed per-subscription schedule. Cutoff-aware snapshot identity preserves
  those schedules without sharing metrics across different as-of contracts.

## Consequences

The system gains cutoff-aware deterministic aggregate reports with a single
truthful as-of instant, typed operational notices,
phone-control evidence, distinct budget ownership, conservative sender
containment, an inspectable `UNKNOWN` queue, durable operational incidents,
read-only provider reconciliation, and cron evidence. It also gains additional
schema, leases, migrations, templates, permissions, feature flags, schedules,
rate-card ownership, monitoring, and human incident-response burden.

Meta may approve submitted copy as Marketing, later recategorize a template,
restrict a sender, omit or reorder webhooks, throttle reads/writes, or change its
policy independently of this code. Exact template approval/category, App Review,
Advanced Access, callback reachability, customer billing, legal/privacy review,
and provider rate ownership remain rollout gates.

## Security and data impact

The public webhook remains attacker-controlled until bounded raw-body HMAC
verification and known-sender resolution. Confirmation commands and codes are
never logged or persisted in plaintext. Aggregate snapshots contain no direct
student or staff identity. Incident and job details exclude phones, raw provider
errors, template variables, rendered messages, amounts, and secrets. Every user
mutation and send-time check re-establishes tenant scope and current authority;
bare IDs and foreign keys do not prove ownership.

Provider calls remain outside user/domain transactions. Budget reservations,
source snapshots, messages, status events, consent events, incidents, safety,
and audit evidence remain durable and tenant-scoped. `UNKNOWN` commits the
estimate because duplicate avoidance takes priority over automatic release.

## Rollout and rollback

1. Review the draft PR, obtain explicit human approval for `SECURITY.md`, review
   this Proposed ADR, and keep every PR4 flag false and both new canary lists
   empty.
2. Verify CI and authenticated desktop/mobile browser flows. Confirm the Vercel
   plan supports subdaily cron, function duration, region/Fluid settings,
   Production-only schedules, callback protection, and durable monitoring.
3. Under an approved deployment/migration hold, record read-only counts, apply
   the additive migration before the application, verify unchanged existing
   rows/hashes and empty/disabled new tables, then promote the exact reviewed
   commit and run ordinary plus flag-off smoke checks.
4. A separate Test operation may verify current provider permissions, exact
   Utility categories, callback signatures, one synthetic confirmed recipient,
   report/notice delivery, scoped/full opt-out, fake ambiguous outcome, circuit
   breaker, health, and incident evidence.
5. A separate Live approval starts with manual canaries and one report/notice,
   then enables automation for one organization only after observation.

Containment disables report/planner/notice/health/message-write flags, clears
canaries, and pauses schedules while preserving webhook evidence when safe. Do
not drop report, notice, incident, consent, message, job, or audit history after
use. Prefer compatible forward repair; destructive rollback requires exact
affected-row review and a separate human operation. No automatic down migration
or provider cleanup is approved.

## Evidence

- `prisma/schema.prisma`
- `prisma/migrations/20260824120000_whatsapp_reports_notices_and_hardening/migration.sql`
- `lib/whatsappManagedTemplates.ts`
- `lib/whatsappFeature.ts`
- `lib/whatsappCost.ts`
- `lib/whatsappReportMetrics.ts`
- `services/whatsappReport.service.ts`
- `services/whatsappReportPlanner.service.ts`
- `services/whatsappServiceNotice.service.ts`
- `services/whatsappDispatcher.service.ts`
- `services/whatsappWebhook.service.ts`
- `services/whatsappSenderSafety.service.ts`
- `services/whatsappIncident.service.ts`
- `services/whatsappHealth.service.ts`
- `services/whatsappMaintenance.service.ts`
- `SECURITY.md`
- `docs/domain-invariants.md`
- `docs/production-runbook.md`
- [Meta template categorization](https://developers.facebook.com/docs/whatsapp/updates-to-pricing/new-template-guidelines/)
- [Meta template components](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components/)
- [Meta WhatsApp permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/permissions/)
- [Meta Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/versions/)
- [Vercel Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Vercel Function limits](https://vercel.com/docs/functions/limitations)

Repository evidence does not prove any real credential, permission, customer
asset, provider approval/category, message delivery, provider charge, App Review,
rate-card correctness, callback reachability, Preview/Production migration,
deployment, schedule health, environment setting, or Live canary.

## Approval

Pending explicit human-owner review. This ADR remains Proposed. Drafting it does
not authorize provider operations, environment changes, Preview/Production
migration, deployment, canary enablement, or rollout.
