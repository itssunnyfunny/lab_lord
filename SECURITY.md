# Security Review Policy

> Repository policy for Codex Security and other security reviewers.
>
> Last reconciled with `main` commit `07ac439` on 2026-08-17.

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
- imports, parsers, previews, plan confirmation, and commit processing;
- Gemini prompts, outbound data, output validation, persistence, and fallbacks;
- Vercel Cron routes, bearer authentication, retries, and idempotency;
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
- student names, phone numbers, fees, dues, allocations, and import contents;
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
- replayed, duplicated, delayed, or reordered provider and scheduled events;
- compromised dependencies or external providers; and
- operator mistakes involving environments, migrations, scripts, or Production
  data.

External trust boundaries are Clerk, PostgreSQL/Prisma, Razorpay, Gemini, Vercel
and Vercel Cron, browsers, uploaded files, and any operator workstation or CI
runner that can access credentials.

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
- Machine-authenticated cron or maintenance operations may bypass user
  entitlement only when explicitly documented as system-owned behaviour,
  tenant-scoped, idempotent, and incapable of granting SaaS access or initiating
  provider charges.
- Raw analytics and data helpers that do not authorize callers may be used only
  after an authenticated, tenant-scoped authorization boundary.
- Staff invitations remain owner-controlled, time-limited, email-bound,
  unpredictable, single-use, and race-safe.

The two cron routes are machine-authenticated with `CRON_SECRET`. The Razorpay
webhook is authenticated by its raw-body signature. These are deliberate
exceptions to Clerk authentication, not unauthenticated routes.

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
- Import commit requires explicit confirmation, a reviewed plan version, fresh
  deterministic revalidation, and matching plan content.
- Files, parser output, uploaded rows, AI mappings, and model responses are
  untrusted input.
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
  payloads, and unnecessary personal data.
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
- import uploads are buffered and parsed before the 2,000-row check and have no
  repository-defined byte limit;
- multiple API handlers return raw `Error.message`, which can disclose sensitive
  implementation detail;
- whether daily operational-payment generation should respect branch or
  organization writability is an unresolved product decision. Current behaviour
  must not be treated as accepted until documented in an ADR or domain
  invariant;
- the repository defines no centralized security log sink, alert routing,
  health/readiness endpoint, incident contact, or monitoring-retention policy;
- repository configuration does not establish whether CSP, HSTS, WAF, or
  equivalent external platform controls are active; and
- Gemini receives import sample rows and student/debt drafting context, while
  consent, retention, regional processing, and vendor-governance policy remain
  operator-owned and unverifiable from this repository.

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
