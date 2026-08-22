# Security Review Policy

> Repository policy for Codex Security and other security reviewers.
>
> Last reconciled with the payment identity and resolution-event working tree
> based on commit `27d417e` on 2026-08-22.

This file defines what to review, the mandatory security invariants, and how to
calibrate findings. It is not a public vulnerability-disclosure channel,
reporting-contact document, response-time commitment, or remediation SLA.

No risks are accepted by default. A known limitation remains unresolved until a
human owner explicitly resolves it or approves a documented decision.

## System and review scope

Lab Lords is an internet-facing, multi-tenant Next.js application designed for
Vercel. It stores organization, branch, staff, student, allocation, payment,
subscription, invoice, import, AI-report, and audit data in PostgreSQL through
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
  provider identifiers, and idempotency state;
- staff-invite bearer tokens and cron credentials;
- database, Clerk, Gemini, Razorpay, webhook, deployment, and environment
  credentials; and
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

External trust boundaries are Clerk, PostgreSQL/Prisma, Razorpay, Gemini,
Vercel Workflow and Vercel Cron, browsers, uploaded files, and any operator
workstation or CI runner that can access credentials.

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

The three cron routes are machine-authenticated with `CRON_SECRET`. Workflow's
framework-controlled `/.well-known/workflow/` endpoint is deliberately outside
Clerk middleware and must remain restricted to provider-authenticated Workflow
traffic. The Razorpay webhook is authenticated by its raw-body signature.
These are deliberate non-user authentication boundaries, not open application
routes.

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
  automatically refund, cancel, recreate, or overwrite ambiguous billing state.

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
  access, benchmark evidence, SLOs, the mutation cap, and rollback authority.

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
