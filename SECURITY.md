# Security Review Policy

> Repository policy for Codex Security and other security reviewers.
>
> Last reconciled with the PR4 WhatsApp report-hardening working tree on
> 2026-08-27. The PR4 `SECURITY.md` changes and ADR 0004 were explicitly approved
> by itssunnyfunny, the human repository owner, for PR #266. This remains
> repository policy, not deployment or rollout authorization.

This file defines what to review, the mandatory security invariants, and how to
calibrate findings. It is not a public vulnerability-disclosure channel,
reporting-contact document, response-time commitment, or remediation SLA.

No risks are accepted by default. A known limitation remains unresolved until a
human owner explicitly resolves it or approves a documented decision.

## System and review scope

Lab Lords is an internet-facing, multi-tenant Next.js application designed for
Vercel. It stores organization, branch, staff, student, allocation, payment,
  subscription, invoice, WhatsApp delivery, import, AI-report, and audit data in PostgreSQL through
Prisma.

Production-reachable review scope includes:

- Next.js pages, server components, API routes, middleware, and server actions;
- Clerk identity linking, sessions, invitations, roles, permission overrides,
  organization ownership, and branch access;
- Prisma schema, migrations, services, maintenance scripts, and data-access
  helpers;
- operational student payments and Lab Lords SaaS subscription billing;
- Razorpay Checkout callbacks, REST calls, webhooks, reconciliation, billing
  mutations, feature gates, and Test/Live isolation;
- Meta WhatsApp Cloud API onboarding, delegated system-user access, phone
  registration, managed Utility-template provisioning, recipient mapping,
  durable delivery, signed webhooks, provider modes, release gates, and branch
  sender assignment;
- imports, parsers, previews, immutable evaluations/plans, recipes, durable
  runs, Workflow orchestration, retention, and commit processing;
- Gemini prompts, outbound data, output validation, persistence, and fallbacks;
- Vercel Workflow and Cron routes, provider/bearer authentication, retries,
  leases, cancellation, and idempotency;
- deployment, migration, CI, environment, and incident procedures; and
- production dependencies when the vulnerable behavior is shipped and
  reachable by this application.

Read [`docs/domain-invariants.md`](docs/domain-invariants.md) for required domain
behavior and known implementation discrepancies. Read
[`docs/production-runbook.md`](docs/production-runbook.md) before operational,
migration, environment, or incident work.

## Assets

Protect at least:

- organization ownership, branch membership, staff roles, and overrides;
- tenant isolation and the existence of foreign-tenant records;
- student names, phone numbers, fees, dues, allocations, import contents, staged
  evaluations/execution payloads, and import-run history;
- payment history, audit records, subscription state, invoices, entitlements,
  provider identifiers, WhatsApp sender/template/recipient/consent history,
  outbox, estimated-budget state, signed webhook receipts, and idempotency state;
- staff-invite bearer tokens and cron credentials;
- database, Clerk, Gemini, Razorpay, Meta app/system-user, webhook, deployment,
  and environment credentials; and
- the integrity and availability of Production data and billing operations.

## Threat actors and trust boundaries

Consider:

- unauthenticated internet users;
- authenticated owners, managers, or staff acting outside their tenant or role;
- users presenting guessed, leaked, replayed, or foreign resource identifiers;
- compromised invite links, browser callbacks, webhook requests, or cron
  credentials;
- malicious or malformed imports and untrusted AI/provider responses;
- replayed, duplicated, delayed, or reordered provider, Workflow, and scheduled
  events;
- compromised dependencies or external providers; and
- operator mistakes involving environments, migrations, scripts, or Production
  data.

External trust boundaries are Clerk, PostgreSQL/Prisma, Razorpay, Meta Graph and
WhatsApp Cloud APIs, the Facebook JavaScript SDK and its browser messages,
Gemini, Vercel Workflow and Vercel Cron, browsers, uploaded files, and any
operator workstation or CI runner that can access credentials.

## Mandatory security invariants

### Authentication, authorization, and tenancy

- User-facing API operations must establish the local Clerk-backed user and
  then independently authorize the requested action.
- Authentication proves identity only. Every object operation must re-check
  organization or branch scope, owner/staff role, permission overrides,
  entitlement, and branch writability as applicable.
- UI visibility, client-provided capabilities, globally unique IDs, and foreign
  keys are never authorization.
- Tenant isolation is application-enforced; PostgreSQL row-level security is
  not present. Every query and mutation must scope tenant-owned records through
  the authorized organization or branch.
- Foreign and nonexistent identifiers must produce the same generic,
  tenant-safe response. Responses must not reveal whether a foreign record
  exists, who owns it, or whether an identifier was valid.
- Parent and child identifiers must be resolved together. A child ID must never
  be trusted independently of its authorized branch or organization.
- Permission-shaped responses must not expose unrelated counts, settings,
  students, seats, payments, staff, or other branch data.
- User-initiated mutations must enforce entitlement and writable state.
- Payment-resolution events are append-only domain evidence. They must be
  created only inside the authorized payment transaction, derive `branchId`
  and snapshot fields from the payment being changed, and must not be exposed
  through arbitrary create, update, or delete APIs.
- Machine-authenticated cron or maintenance operations may bypass user
  entitlement only when explicitly documented as system-owned behaviour,
  tenant-scoped, idempotent, and incapable of granting SaaS access or initiating
  provider charges.
- Raw analytics and data helpers that do not authorize callers may be used only
  after an authenticated, tenant-scoped authorization boundary.
- Staff invitations remain owner-controlled, time-limited, email-bound,
  unpredictable, single-use, and race-safe.

Cron routes are machine-authenticated with `CRON_SECRET`. Workflow's
framework-controlled `/.well-known/workflow/` endpoint is deliberately outside
Clerk middleware and must remain restricted to provider-authenticated Workflow
traffic. The Razorpay webhook is authenticated by its raw-body signature.
The public Meta verification and webhook route at `/api/whatsapp/webhook` is
likewise outside Clerk: its GET challenge requires the private verification
token and its POST requires Meta's HMAC over the untouched raw bytes before any
JSON parsing or durable processing. These are deliberate non-user
authentication boundaries, not open application routes.

### Billing and provider trust

- Organization billing APIs are owner-only.
- Browser success, client callbacks, webhook event type, and provider
  subscription status alone must never grant paid access or advance
  `paidThrough`.
- Checkout callbacks must verify their server-side signature, retrieve
  provider-authoritative objects, and match the expected organization intent,
  subscription, payment, plan, quantity, mode, and state.
- Webhook signatures must be verified over the untouched raw body before JSON
  parsing or processing.
- Webhook event IDs and payload hashes must provide durable replay safety.
  Replaying the same event/body is safe; reusing an ID with a different payload
  must fail.
- Failed webhook processing must remain retryable and must not be marked
  complete before reconciliation succeeds.
- Test and Live credentials, rows, provider objects, webhook secrets, and
  environments must remain isolated. Wrong-mode state must fail closed.
- Billing maintenance scripts must load only the selected allowlisted
  environment, reject conflicting ambient database or Razorpay identities, and
  bind every apply run to the expected deployment, provider mode,
  database-resident identity fingerprint, and explicit organization allowlist
  before any scoped query, write, or provider fetch. Connection reports and
  errors must not expose credentials, key identities, or complete database
  URLs.
- `paidThrough` may advance only from mutually matching provider-confirmed paid
  invoice and captured-payment evidence for the current subscription period.
- Billing mutation idempotency keys, payload matching, per-organization FIFO
  ordering, locks, leases, stale-worker protection, and replacement lineage must
  remain durable.
- Authorized replacement access must remain provisional and fail closed when
  lineage, plan, quantity, authorization, or grace-period checks fail.
- Billing feature switches and Live canaries must default to held behavior.
  Disabling billing writes is not assumed to stop signed webhook reconciliation
  or already-running work.
- Ambiguous provider state requires reconciliation and human review. Never
  automatically refund, cancel, recreate, resubmit, or overwrite ambiguous
  billing state. Provider-mutation success and failure finalization must match
  the exact organization lease and attempt identity. Expired in-flight work is
  quarantined, not requeued. Reconciliation is read-first: it may adopt an exact
  provider target without another write, but a second mutation is allowed only
  after a definite rejection or pre-provider failure and a fresh source-state
  match. Manual-review state and its typed adopted/retained resolution are
  owner-readable and append immutable SYSTEM subscription-history evidence.
- General billing undo must reject an in-flight or unresolved provider outcome.
  Branch-removal undo may restore the branch only atomically with durable,
  provider-confirmed cancellation of the scheduled quantity change.

### WhatsApp and Meta Cloud API

- Customer-supplied Meta business, WABA, phone-number, and browser-session
  identifiers are untrusted hints. A sender may be persisted only after the
  server exchanges and validates the one-time authorization, verifies the
  expected app and required scopes, resolves the authorized WABA, and confirms
  provider-authoritatively that the phone belongs to it.
- A WhatsApp sender is organization-owned application state. Every sender read
  or mutation must scope the sender through the authorized organization;
  branch assignment must independently prove that both branch and sender
  belong to that same organization and that the environment/provider mode
  matches. A bare sender, WABA, phone, business, or branch ID is never
  authorization.
- Only the current organization owner may start or complete Embedded Signup,
  register a phone, install or reconcile organization-wide templates, assign or
  unassign a sender, or locally disconnect it. Branch recipient, settings,
  automation, and manual-send operations independently require their documented
  `view_whatsapp`, `manage_whatsapp`, or `send_whatsapp` permission plus any
  underlying payment permission. Every mutation rechecks tenant scope, the
  internal `WHATSAPP_AUTOMATION` entitlement, writable state, provider mode, its
  specific fail-closed feature flag, and any applicable Live canary.
- The Embedded Signup authorization code and temporary access token, the
  server-only system-user access token, app secret, verification token, phone
  registration PIN, raw signup session, and raw webhook body must never be
  persisted or logged. The customer authorization code/token is held only for
  bounded provider verification and then discarded; the long-lived global
  system-user credential remains in server-only configuration.
- One-time connection state contains at least 256 random bits, is stored only
  as a SHA-256 hash, expires, is bound to the owner and organization, and is
  claimed through a database lease before provider calls. Provider calls must
  not run inside a long database transaction. Finalization must recheck owner,
  tenant, entitlement, writable state, mode, gates, and lease ownership.
- Meta webhook POST signatures are verified with HMAC-SHA256 over the exact,
  bounded raw bytes before decoding or schema validation. Verified deliveries
  receive a mode-bound payload hash and durable unique receipt before success;
  exact replay is harmless, and an unknown but correctly signed WABA or phone
  is ignored without revealing tenant existence. Raw bodies, message content,
  and unnecessary phone data are not receipt evidence.
- TEST and LIVE sender assets, credentials, webhooks, database rows, and
  environments remain isolated. Configuration and provider mutations fail
  closed on a mode mismatch. Integration, onboarding, managed-template writes,
  provider-message writes, automation planning, webhook ingestion, onboarding
  Live canaries, delivery Live canaries, reports, report planning, service
  notices, health reconciliation, operations UI, and the separate Live
  automation/health canaries are distinct fail-closed controls.
  Disabling a control must preserve queued work, budget state, provider IDs,
  signed receipts, consent, and history.
- The customer owns its WABA, phone, Meta business assets, payment method, and
  provider charges. Lab Lords must not share or assign its credit line, absorb
  customer Meta usage, store a customer access token, use unofficial WhatsApp
  Web automation, or destructively alter provider assets during a local
  disconnect.
- Provider creation and delivery are restricted to the versioned, code-defined
  Lab Lords catalogue. Creation hardcodes `UTILITY`; delivery requires the
  provider-authoritative template to be `APPROVED` and `UTILITY` and its active
  binding to match the reviewed catalogue version and hash. The browser may not
  choose the final recipient, amount, due date, provider template name,
  category, language, or component array.
- There is no provider capability for free-form text, media, marketing,
  authentication/OTP, arbitrary templates or recipients, AI-generated external
  content, payment links, credit sharing, billing aggregation, automatic replies,
  or arbitrary broadcasts. Existing AI `MessageDraft` rows remain human-reviewed
  copy/open-WhatsApp suggestions and can never feed provider delivery.
- Consent begins `UNKNOWN`; existing students are not opted in or backfilled.
  Send eligibility requires current `OPTED_IN` operational consent for the exact
  sender and normalized phone, a versioned consent statement, and an active
  student-recipient mapping for that same sender, phone, student, branch, and
  organization. Phone changes and student reactivation never transfer or
  silently restore consent. Consent and recipient history are preserved and are
  unavailable through arbitrary mutation APIs.
- Manual reminder inputs are identifiers and an idempotency key only. The server
  resolves current payments, students, mappings, phone, amount, due date,
  template, typed variables, schedule, cost estimate, and tenant ownership.
  Messaging must never change payment truth; inbound `PAID`, natural-language
  claims, or provider events cannot mutate a `Payment`.
- Message queueing, business-event deduplication, frequency reservation, and
  estimated-budget reservation are durable and atomic. Dedupe fingerprints are
  derived from stable business evidence rather than a cron invocation, and the
  narrow `WhatsAppMessagePayment` join records every payment represented by a
  grouped message without replacing `Payment` as financial truth. Budget
  estimates use a configured versioned rate card with strict UTC effective and
  expiry times, are not a Meta invoice, and must not be presented as an exact
  provider charge. Queue, planner, and dispatcher fail closed before the card
  is effective and at or after expiry.
- Resolving a payment may mutate only scheduled or claimed-before-submission
  linked messages under a row lock in the same payment transaction. A grouped
  collection row is refreshed in place only from complete, current DUE facts and
  current recipient/binding truth, retains one reservation, and is otherwise
  cancelled with that reservation released. Submitted rows and unrelated later
  dues remain immutable; this reconciliation has no provider-call capability.
- No Meta call may run inside a Prisma transaction used for student, payment,
  consent, recipient, branch-settings, outbox, frequency, or budget mutation.
  Provider work follows short database claim and validation, local commit,
  bounded Meta request, then lease-fenced database finalization. Send-time
  validation rechecks tenant, sender, mode, flags/canary, entitlement,
  writability, active mapping/consent, managed template, source payment/event,
  schedule/frequency, and reserved budget.
- Meta provides no application idempotency key for message sends. A timeout,
  connection loss, provider `5xx`, or invalid success body that may have been
  accepted must commit the message and reserved budget to `UNKNOWN`, must never
  be retried automatically, and requires operator reconciliation. A stale
  `SUBMITTING` lease likewise becomes `UNKNOWN`; only a stale pre-submission
  claim may be reclaimed safely. Definite retryable throttling is bounded and
  lease-fenced; stale workers cannot finalize newer state.
- Webhook status evidence is append-only, deduplicated, and projected without
  regression by provider timestamp and status precedence. An event may arrive
  before API finalization and remain as a bounded orphan for later attachment.
  Signed status pricing may contain `billable`, category, `pricing_model`, or
  `type`; the implementation stores only bounded authoritative billable/category
  and recipient values. None is an exact charged amount, so
  `actualCostMicros` remains null.
- Only normalized inbound text exactly equal to `STOP`, or a managed quick-reply
  payload exactly equal to `LABLORDS_STOP_UPDATES`, may opt a phone out. The
  transition is replay-safe, applies to all consent types for that sender/phone,
  disables recipient mappings, and cancels or suppresses future unsubmitted
  messages while preserving accepted history. Raw bodies, inbound text, and raw
  provider errors are neither stored nor logged; no automatic reply is sent.
- Automation starts prospectively at `automationEnabledAt`; it may not welcome
  legacy/imported students or blast historical students, dues, or payment
  events. Machine-authenticated planner/dispatcher work remains tenant-scoped,
  bounded, idempotent, and subject to entitlement and every send invariant; cron
  authentication is not authority to bypass customer eligibility or initiate an
  otherwise unauthorized provider charge.
- Branch delivery disable atomically cancels every safely unsubmitted manual and
  automatic message for that branch, releases `RESERVED` estimated budget, and
  preserves rows and accepted/ambiguous history so an old manual batch cannot
  send after re-enable. Automation-only disable is narrower and cancels only
  safely unsubmitted automatic messages.
- Local disconnect updates Lab Lords state, unassigns branches, and preserves
  sender identifiers, templates/bindings, mappings, consents, signed receipts,
  message/event history, and append-only audit evidence. It must not deregister
  the phone,
  unsubscribe other apps, revoke customer ownership, or delete provider assets.

### WhatsApp reports, service notices, and operational hardening

- A report recipient is the current authenticated owner or current authorized
  branch staff member, never an arbitrary contact. Organization reports are
  owner-only. Branch reports require current `view_whatsapp`,
  `receive_whatsapp_reports`, `view_payments`, and `analytics` permissions plus
  branch access, `WHATSAPP_AUTOMATION`, and current writability. Owner authority
  cannot silently subscribe another user's phone.
- Control of a report phone is proven only by an exact confirmation command in
  a valid signed known-sender webhook. The one-time confirmation code has at
  least 50 bits of entropy, uses a bounded unambiguous alphabet, is stored only
  as a SHA-256 hash bound to sender/subscription/phone, expires after 15 minutes,
  stops after five failed attempts, is returned once, and must never enter a
  URL, log, audit detail, provider payload, error, screenshot, or plaintext
  database field. Confirmation rechecks user, tenant, permissions, entitlement,
  writability, sender assignment, and phone before opting in `OWNER_REPORT`.
  Normalized report commands retain the inbound provider message ID: repeated
  copies of one provider identity are deduplicated, but distinct message IDs
  from the same phone are processed in envelope order.
- Daily reports are deterministic aggregate database metrics only. They contain
  no student/staff name, phone, individual due or payment, payment method, seat
  label, or variable branch list; make no attendance/check-in claim; and never
  use AI. Every queued row references an immutable snapshot keyed by scope,
  scope key, local report date, scheduled cutoff, and metrics version, with a
  canonical hash/fingerprint and one UTC `metricsAsOfAt`. Same-cutoff
  subscriptions share that snapshot; different cutoffs do not collide. Every
  temporal metric and the rendered local as-of label use the same transaction-
  snapshot instant.
- Automatic reports are prospective from activation. Catch-up ends exclusively
  at the earlier of one hour after the scheduled cutoff or next local midnight,
  and in Live requires both delivery and separate automation canaries. A missed
  or unprovable report records a bounded safe incident and is skipped/suppressed
  before Meta. Branch reports reserve the branch budget and automatic daily limit.
  Organization reports reserve only their positive owner-controlled
  organization report budget and may not consume an arbitrary branch budget.
- Service notices are limited to server-defined branch closure, changed-hours,
  and maintenance events, fixed reasons, and typed date/time variables. The
  browser cannot supply provider text. Notices are nonpromotional, never fall
  back to Marketing, deduplicate shared phones, derive recipients only from
  current active branch mappings with `OPTED_IN OPERATIONAL` consent, and reject
  an audience above 500 before any message or reservation. Queueing locks and
  atomically reserves the entire estimated branch budget.
- `STOP REPORTS`, the exact managed `Stop reports` signed reply label/text, and
  the exact compatibility payload opt out only `OWNER_REPORT`, pause matching
  report subscriptions, cancel safely unsubmitted reports, and release their
  reservations. Existing exact `STOP`/`LABLORDS_STOP_UPDATES` continues to opt
  out all applicable consent types, pauses reports, disables mappings, and
  cancels affected unsubmitted report/notice/collection messages. Neither path
  retries through another channel or sends an automatic reply.
- Only `DAILY_ORGANIZATION_REPORT` may be branchless. Report and notice source
  validators must not weaken collection source checks: reports cannot carry a
  student/payment source, notices cannot carry a payment source, and every
  purpose rechecks its exact tenant, consent, sender, template, schedule,
  fingerprint, budget, and current authorization immediately before submission.
- A sender is paused locally after three ambiguous outcomes in ten minutes or
  ten reviewed sender/provider failures in ten minutes. Invalid individual
  recipients do not count. Immediately before a provider call, a short
  transaction checks both full and requested pause state and durably stamps the
  exact leased message as provider-call-admitted; the Meta call occurs only
  after that transaction commits. A pause request atomically blocks new
  admissions, remains visibly pending while any earlier admission drains, and
  records `pausedAt` only after no admitted `SUBMITTING` row remains. Owner
  resume requires explicit confirmation, active and unrestricted sender,
  current rate, a recent successful unrestricted read-only reconciliation,
  healthy exact bindings for current queued work, and healthy templates only
  for currently enabled/configured functionality, with no blocking critical
  incident. Unused languages and optional templates do not block resume; every
  individual send still requires its exact binding. Resume preserves all
  incidents and does not retry `UNKNOWN`.
- `UNKNOWN` is terminal, budget-committed, incident-backed, and never retried
  automatically. A later signed status may project it to proven provider truth
  and resolve only the corresponding incident without sending again. Incident
  acknowledgement records human awareness but is not provider resolution.
  Incident details contain no PII, phone, rendered content, template variables,
  arbitrary provider errors, or secrets.
- Provider-health reconciliation is read-only: it may fetch WABA, phone/
  registration/quality, subscribed-app, restriction, and template state, but
  cannot register a phone, subscribe an app, create a template, send a message,
  remove another provider, mutate customer assets, or share credit. Ambiguous
  reads must preserve prior local provider truth. Valid signed known-sender
  webhooks alone update sender webhook health; inactivity without expected
  provider activity is not a stale-webhook incident.
- WhatsApp job evidence contains only bounded operational integers and safe
  codes—never IDs, names, phones, amounts, rendered messages, raw provider data,
  or secrets. Maintenance is authenticated, bounded, idempotent, never calls
  Meta or resolves payments, and never deletes accepted message, consent, or
  audit history.

### Cron, imports, and AI

- Cron routes must fail closed when `CRON_SECRET` is absent or incorrect. The
  bearer value must never appear in a URL, log, screenshot, report, or error.
- Scheduled and retryable operations must tolerate duplicate or overlapping
  invocation without duplicating charges, access, or domain records.
- Imports must authenticate, authorize the branch, enforce writability, scope
  sessions to that branch, and check all additional permissions required by the
  reviewed rows.
- New V2 starts must fail closed unless `IMPORT_V2_ENABLED=true`; plan creation
  must also fail closed without a configured positive
  `IMPORT_MAX_PLANNED_MUTATIONS` and must mark a plan above that cap
  non-runnable. Neither value may be accepted from the browser.
- Complete import requests, source files, rows, columns, cells, and expanded
  workbooks must remain bounded at their repository-defined limits. Parsers
  must validate signature/type/encoding and reject malformed structures before
  persisting rows.
- Import commit requires explicit confirmation, the exact immutable plan hash,
  current draft/evaluation revision, no blocking plan checks, and matching plan
  content. A stale browser or Workflow run must fail instead of overwriting a
  newer revision.
- Idempotency keys bind to a canonical request hash. The same key and content
  may replay; a different payload must conflict. One active run per session,
  deterministic item keys, leases, bounded attempts, and compare-and-set
  completion must remain durable in PostgreSQL.
- Workflow is orchestration only. Workflow inputs and step outputs may contain
  opaque run/session IDs, revisions, hashes, cursors, and counts, never source
  rows, personal values, branch configuration, credentials, authorization
  conclusions, or full mutation payloads. Each bounded execution step must load
  its state from PostgreSQL and recheck tenant scope, permission, entitlement,
  and branch writability before domain mutation.
- Import run-item success results may retain only bounded entity IDs and numeric
  counts. Errors must be redacted and bounded; execution payloads must be
  cleared after terminal handling.
- A mutation step must fail stale if current linked prices, active
  branch-owned shift/bundle structure, or an existing same-period payment no
  longer exactly matches the immutable plan. A same-key payment is not proof
  of idempotent success unless its branch, type, amount, dates, allowed status,
  and already-final method/reference metadata match. Partial terminal replay
  must project the current run's row results even when the session was already
  partial, without rewriting previously successful rows.
- Session staging and its initial analysis ledger are persisted atomically.
  Workflow/provider dispatch is recoverable through an authorized POST that
  rechecks tenant scope, required plan permissions for commits, entitlement,
  writability, and current branch configuration. An attached provider run that
  is terminal or missing while the PostgreSQL ledger remains active is replaced
  only after a database-locked compare-and-set fence; an active provider run is
  never replaced. Tenant-facing polling exposes only `dispatchRequired`; raw
  provider Workflow identifiers remain server-only.
- Import recipes may retain only organization-scoped source type, normalized
  header signature/columns, goal, entity types, and column mappings. Samples,
  row values, branch configuration, payment/default/conflict options, and model
  rationale must never enter recipe storage or responses.
- Expired staging must be purged by the authenticated, idempotent daily job only
  after its explicit `purgeAfter` deadline. One invocation drains at most 20
  batches of 100 sessions, reports the remaining backlog, and fails closed if
  any batch or the final backlog count fails. Each batch must lock the
  staging record and attached ledgers, terminalize any stale active run and
  nonterminal items with consistent counters, and clear their leases before
  removal. Run-item payloads/errors must be scrubbed before staged sessions,
  rows, evaluations, and plans are removed; retained run history must remain
  redacted.
- Files, parser output, uploaded rows, AI mappings, and model responses are
  untrusted input.
- Import mapping must run deterministic mapping first. Gemini may receive only
  sanitized aliases for ambiguous headers plus masked value shapes and
  structural summaries; raw row values and branch configuration must not be
  sent.
- Gemini calls remain server-only. Model output must be parsed, bounded,
  sanitized, and replaced by deterministic fallback behavior when invalid.
- AI is advisory only. It must not decide authorization, tenant scope,
  entitlement, payment truth, provider reconciliation, database mutation, or
  an automatic external action.
- Message drafts require human review and must not become automatic WhatsApp,
  SMS, email, or other delivery without a separately approved design.
- Any new or expanded data sent to an AI provider requires explicit review of
  personal-data scope, purpose, consent, retention, regional processing, and
  operator policy.

### Secrets, personal data, and errors

- Secrets remain server-only and in approved environment or secret-management
  systems. Never commit or print values from environment files.
- `NEXT_PUBLIC_` variables are browser-visible and must never contain a secret.
- Logs, errors, tests, reports, patches, screenshots, and incident evidence must
  omit credentials, bearer tokens, raw webhook bodies, unnecessary provider
  payloads, Workflow step payloads, import rows, and unnecessary personal data.
- API errors must not expose stack traces, query details, provider secrets,
  internal authorization reasoning, or foreign-record existence.
- Production data must not be copied into Local, Test, Preview, AI prompts,
  fixtures, or debugging reports without an explicitly approved data-handling
  procedure.
- Integration tests and destructive scripts must never target shared, Preview,
  or Production databases.

## Finding severity

Calibrate severity by demonstrated product impact:

- **Critical:** unauthenticated or bulk tenant compromise; destructive
  Production database access; compromise of a core credential enabling
  database or provider control; or signature/authentication bypass causing
  charges or paid access at scale.
- **High:** authenticated cross-tenant read or write; a same-tenant bypass
  granting owner, billing, destructive administration, broad PII access,
  material paid-feature or entitlement access, or equivalent control; durable
  idempotency failure causing double charge or incorrect paid access; or a
  usable staff-invite takeover.
- **Medium:** bounded same-tenant access beyond the assigned role without owner,
  billing, destructive, broad-data, material paid-access, or cross-tenant
  impact; meaningful personal-data exposure; bounded denial of service or cost
  amplification; or sensitive information disclosed through errors or logs.
- **Low:** a defense-in-depth weakness without demonstrated asset impact.

Raise or lower severity only with concrete reachability, prerequisites, scale,
data sensitivity, reversibility, and existing-control evidence. Do not lower a
finding merely because tenant isolation or validation is implemented in the
application layer.

## Scan exclusions

Do not use these as primary finding targets:

- generated outputs such as `.next/`, `out/`, `build/`, coverage output,
  `app/generated/prisma/`, and generated test/browser reports;
- vendored or installed source under `node_modules/` and package-manager stores;
- ignored local logs, screenshots, patch backups, caches, editor files, and
  untracked `.agent` artifacts; or
- purely non-security product, style, accessibility, or documentation defects.

These exclusions do not suppress:

- a dependency vulnerability that is present in the shipped dependency graph
  and reachable by Production behavior;
- insecure generation configuration or application code that consumes generated
  output unsafely;
- a test, script, workflow, or runbook that can realistically expose secrets,
  corrupt Production, or weaken a release control; or
- evidence contained in an excluded artifact that validates a reachable
  application vulnerability.

There are no repository-approved accepted risks or blanket finding
suppressions.

## Known unresolved limitations

Treat these as review context and remediation candidates, not accepted risks:

- tenant isolation and several same-branch relationships are application-only,
  without PostgreSQL RLS or complete composite tenant constraints;
- generic foreign/nonexistent responses are not yet consistent across all
  object mutation paths;
- the process-local in-memory rate limiter resets and is not coordinated across
  server instances;
- import request parsing still buffers a bounded request in application memory;
  the 4.25 MiB request and 4 MiB source limits are abuse bounds, not streaming
  upload or malware-scanning controls;
- multiple API handlers return raw `Error.message`, which can disclose sensitive
  implementation detail;
- whether daily operational-payment generation should respect branch or
  organization writability is an unresolved product decision. Current behaviour
  must not be treated as accepted until documented in an ADR or domain
  invariant;
- the repository defines no centralized security log sink, alert routing,
  health/readiness endpoint, incident contact, or monitoring-retention policy;
- repository configuration does not establish whether CSP, HSTS, WAF, or
  equivalent external platform controls are active;
- overdue drafting sends selected student names and debt context to Gemini,
  while consent, retention, regional processing, and vendor-governance policy
  remain operator-owned and unverifiable from this repository; and
- the Workflow execution ADR remains Proposed. Production enablement is not
  approved until a human owner/security review covers provider processing and
  residency, Fluid Compute/runtime configuration, retention and operator
  access, benchmark evidence, SLOs, the mutation cap, and rollback authority;
- the WhatsApp communication-foundation ADR 0002 remains Proposed; ADRs 0003
  and 0004 are Accepted. No repository evidence proves Meta App Review/Advanced
  Access, real Embedded Signup, WABA or phone registration, template approval,
  signed provider delivery, webhook reachability, customer billing ownership,
  legal/privacy approval, or Preview/Production configuration;
- the configured utility rate card is an operator-maintained estimate, not
  provider-authoritative billing truth, and the repository has no automated
  rate refresh or exact-cost reconciliation; and
- WhatsApp rate limits use the same process-local limitation described above;
  the repository's database-backed `UNKNOWN`/incident view is not centralized
  alert routing, and repository evidence still does not establish durable
  external webhook/provider alerts or a stable externally reachable callback
  host.

## Review conduct

- Trace findings from an attacker-controlled source through authorization,
  tenant scoping, data access, mutation, external action, and observable impact.
- Review route and service layers together; a safe UI or route wrapper does not
  make an unsafe exported service or helper harmless.
- Test foreign-tenant and nonexistent identifiers, lower roles, denied
  overrides, read-only branches, wrong provider mode, duplicate/reordered
  events, and retry races.
- Use synthetic or isolated Test data. Do not access Production data, trigger a
  real charge, rotate a credential, send a real message, or mutate an external
  provider while validating a finding.
- Report the affected asset, attacker prerequisites, tenant boundary, source to
  sink, concrete impact, existing controls, and a minimal remediation direction.
- Keep proof material private and redact secrets, raw personal data, and
  provider payloads.
