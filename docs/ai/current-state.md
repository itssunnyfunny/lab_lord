# Lab Lords: Current Architecture and Implementation State

> Last verified: 2026-08-17
>
> Repository anchor: `main` at commit `07ac439`
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

### Declared runtime

The versions below come from `package.json` at the repository anchor:

- Next.js 16.2.5 with the App Router
- React 19.2.6 and TypeScript 5
- Tailwind CSS 4 and shared CSS design tokens
- Prisma 7.8 with PostgreSQL
- Clerk through `@clerk/nextjs`
- Google Gemini through `@google/genai`
- Razorpay through the repository's server-side REST client and hosted Checkout script
- Vitest 4.1 and Playwright 1.62
- pnpm as the package manager

Prisma connects with `@prisma/adapter-pg` when `DATABASE_URL` is a normal PostgreSQL URL. It uses Prisma Accelerate when `ACCELERATE_URL` is set or the database URL uses the `prisma://` scheme. Application code must use the shared client in `lib/prisma.ts`.

## Identity, tenancy, and authorization

Clerk is the identity provider. `proxy.ts` protects authenticated page families
such as `/account`, `/app`, `/branch`, `/onboarding`, and `/org`. API routes are
included in the middleware matcher but are not covered by `isProtectedRoute`.
User-facing API handlers call `getSessionUser()` and enforce authorization;
the two cron routes instead verify `CRON_SECRET`, and the Razorpay webhook
verifies its raw-body signature before processing.

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
- Branch fee collection: `Payment` and `AuditLog`.
- AI: `BranchAIReport` and `MessageDraft`.
- Imports: `ImportSession`, `ImportRow`, `ImportQuestion`, and `ImportCommit`.
- SaaS billing: `OwnerTrialGrant`, `SaasRazorpayPlan`, `RazorpayPlanProvisioning`, `BillingOffer`, `OrganizationOfferGrant`, `OrganizationSubscription`, `OrganizationBillingChange`, `OrganizationSubscriptionInvoice`, `OrganizationSubscriptionHistory`, and `RazorpayWebhookEvent`.

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
- Monthly catch-up and replay use the `(studentId, periodStart)` uniqueness
  constraint and duplicate skipping. That key omits payment type: a nonzero
  admission row and the first monthly cycle can share the joined-date
  `periodStart`, causing the first monthly charge to be skipped. Do not treat the
  present key as proof that both charge types coexist safely.
- Paid and waived mutations are server-confirmed and paid/waived status is not inferred by the client.
- Current transitions are not terminal: the service permits `PAID -> WAIVED`
  and `WAIVED -> PAID`, and a waiver can retain earlier payment metadata.
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

Authoritative code: `services/staff.service.ts`, `services/staffInvite.service.ts`, `services/staffInviteSecurity.ts`, `lib/branchCapabilities.ts`, and `app/api/branches/[branchId]/access/route.ts`.

### Deterministic analytics

- Branch and organization snapshots are implemented for student status, seating, shift-slot utilization, collections, outstanding dues, and overdue balances.
- Capacity is measured in shift slots, not only physical seats. Compatibility fields named `totalSeats` or `occupiedSeats` may therefore contain slot counts; use the explicit occupancy snapshot fields when changing analytics.
- Branch and organization trend routes are implemented.
- Advanced branch and organization analytics require the corresponding staff permission/ownership and the `ADVANCED_ANALYTICS` entitlement.

Authoritative code: `analytics/`, `services/seat.service.ts`, and `app/api/analytics/`.

### Import assistant

The persisted import wizard is implemented for CSV, XLS, XLSX, PDF, and pasted tables, with a maximum of 2,000 rows per session.

The flow is:

1. Parse and persist raw rows in chunks.
2. Profile columns and sample values.
3. Ask Gemini for structured column mappings, questions, warnings, and suggestions.
4. Sanitize the response; mappings below the auto-apply confidence threshold or duplicate mappings remain for review.
5. Fall back to deterministic column matching if Gemini is unavailable or unusable.
6. Normalize and validate students, seats, shifts, allocations, duplicates, conflicts, and payment decisions.
7. Preserve manual row corrections across revalidation.
8. Produce an explicit preview and plan version.
9. Require final confirmation and the same plan version before committing through existing domain services.

`SAFE_PARTIAL` imports ready rows and leaves unresolved rows behind. `STRICT_ALL_OR_NOTHING` rejects a plan that still contains blocked or review rows, but the subsequent commit is a per-row service loop rather than one database transaction across the entire file. A runtime failure can therefore still produce a partial result; cleanup is best effort.

Authoritative code: `importing/`, the import-session API routes, and the import wizard under `app/branch/[branchId]/onboarding/import/`.

### Lab Lords subscription billing

The repository contains both legacy billing and Workspace Billing V2.

- `BASIC` is displayed as Basic and costs INR 299 per active branch per month.
- Database plan `PRO` is displayed as Standard and costs INR 499 per active branch per month.
- Standard grants staff management, advanced analytics, and AI access.
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
- The UI supports review and copy only. There is no WhatsApp, SMS, or email sending integration.

### Import mapping

The import assistant uses Gemini for mapping assistance, not mutation. It sends branch seat/shift context, a source profile, source columns, and up to eight sample rows. Those sample rows can contain uploaded personal or financial data, so changes to this flow require security/privacy review. Sanitized AI suggestions still pass through deterministic normalization, validation, user review, preview, and service-layer authorization before any data is committed.

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
| PostgreSQL / Prisma | Required; schema and 31 timestamped migrations exist | Database target, applied migration set, backups, and health are unknown |
| Clerk | Real auth and local-user linking are implemented | Active instance, keys, redirect/origin configuration, and account health are unknown |
| Gemini | Reports, message drafts, and import mapping are wired with fallbacks | API key, selected model availability, quota, and data-processing configuration are unknown |
| Razorpay | Server API client, Checkout, signatures, webhook receipts, reconciliation, and plan catalog are implemented | Test/Live mode, account approvals, webhook configuration, flags, canary, and provider health are unknown |
| Vercel Cron | Daily payment and hourly billing schedules are declared in `vercel.json` | Whether the deployment is Production, schedules are active, and recent runs succeeded is unknown |
| Google Analytics | Consent-aware GA bootstrap and event helpers are implemented | Measurement ID and live collection state are unknown |
| Support email | Public pages and `mailto:` bug reports are implemented | Mailbox monitoring and response operations are unknown |

Never infer a deployed state from local `.env` files, ignored Vercel metadata, seed data, or repository defaults. Use the target environment's approved operational checks without printing secrets.

## Verification and test evidence

At this anchor the repository contains 135 Vitest/Playwright test files, 72 API route files, 27 service files, and 31 migration directories. These counts are orientation data, not invariants.

### Automated coverage by area

- Auth and routing: `tests/unit/lib/auth.test.ts`, `tests/unit/proxy.test.ts`, and workspace-routing tests.
- Core services: integration suites under `tests/integration/services/` for organizations, branches, onboarding, students, seats, shifts, multi-shifts, allocations, payments, staff, invites, trials, billing, and entitlements.
- API authorization and behavior: route suites under `tests/unit/api/`.
- Imports: `tests/unit/importing/`, import route tests, and `tests/integration/importing/import-commit-flow.test.ts`.
- Billing: extensive unit suites for policies, replacement trust/access, reconciliation, payment methods, deadlines, migration contracts, plan catalog, and checkout UI; integration billing lifecycle suites; browser billing specs.
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
- Passing repository tests cannot establish provider configuration, signed webhook delivery, cron execution, deployed migrations, or production data integrity.

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
- Import `STRICT_ALL_OR_NOTHING` is a pre-commit strictness mode, not one database transaction for the whole import.
- File imports are buffered and parsed before the 2,000-row check, and the route has no repository-defined upload-byte limit.
- Trend analytics recompute from mutable current tables rather than immutable historical snapshots; some current status, shift, and archived-branch state affects past-looking results.
- Attendance is absent: there is no attendance model, service, route, or test.
- Soft-deleting a Shift does not repair existing MultiShift components or
  MultiShift-linked student fees, so a bundle can retain an inactive component.
- User and organization timezone fields default to `Asia/Kolkata`, but billing
  cycle and day calculations use runtime-local dates rather than the stored
  organization timezone.
- A failed AI report generation can still advance `aiLastCalledAt` and impose cooldown.
- AI message generation is review/copy only; no delivery provider is wired.
- Import mapping can send uploaded sample rows to Gemini.
- Support forms rely on the user's local email client.
- Several legacy/unwired AI files and one empty analytics hook remain in the tree.

## Documentation status at this anchor

This file supersedes architecture/status claims in older phase-oriented or generated documents when they conflict with current code.

- `product.md` is retained as a historical phase roadmap and now points here for current status.
- The stale generated application knowledge graph and contradictory AI production checklist were removed when this bridge was created.
- The two tracked `.agent` policy files are compatibility adapters only. Other local `.agent` logs, screenshots, generated metadata, and patch backups are ignored and are not repository authority.

When this document and the implementation disagree, inspect the current schema, migrations, services, API routes, and tests, then update this document in the same change.
