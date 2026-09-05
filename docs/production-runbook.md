# Production runbook

This runbook covers the repository-owned procedures for operating Lab Lords. It
does not grant access to Production and does not replace provider dashboards,
database recovery documentation, or an approved incident-response policy.

Last reconciled with the repository: 2026-09-05 (hardening additions; older operational evidence remains dated).

## AI ownership and inbound identity migration handoff

### Subsequent operational tenant migration

`20260905170000_scope_operational_relationships` adds scoped payment/student,
resolution/payment, audit/payment, draft/student and fee-source keys, plus
MultiShiftComponent.branchId and scoped bundle/shift keys. Before approved
deployment, stop/drain affected writers and execute the seven count predicates
from the migration's preflight as read-only SELECTs. Record counts separately
for Payment, PaymentResolutionEvent, AuditLog, MessageDraft, each Student fee
source and MultiShiftComponent. Every inconsistent-reference count must be zero;
otherwise hold for reviewed repair. No row is deleted or guessed.

Record each table's total row count, nullable draft-student count and component
count before and after. The migration locks all affected tables, verifies both
component parents agree, derives only component branch IDs, installs its keys
and commits atomically. All row totals and historical values must remain equal;
component branch/null/mismatch counts must be zero. Verify all seven scoped
relationship families through pg_constraint.convalidated and direct synthetic
mixed-parent rejection in an isolated target before promotion.

New nested component writers inherit branchId via Prisma's composite relation;
old writers do not provide it. No old/new writer overlap is supported. Apply the
migration and matching generated client before resuming traffic. Preserve the
previous MultiShift active-component edit guard and fee-update behavior.

The draft FK uses PostgreSQL's `ON DELETE SET NULL (studentId)` column subset to
preserve branchId. Prisma represents SetNull but cannot express the column list;
its validation warning is expected. Never replace the maintained SQL with a
generated all-column SET NULL constraint. See the official
[PostgreSQL foreign-key documentation](https://www.postgresql.org/docs/17/ddl-constraints.html).
Bootstrap must use migrations, not db push. Rollback requires holding affected
writers and forward repair; retain history and keys. Reverting to an old binary
without an explicit compatibility patch is unsupported. No Production operation
is authorized or performed by this note.

`20260905143000_fence_ai_and_inbound_messages` follows the allocation migration.
It adds `BranchGenerationLease` (branch FK, unique branch/kind),
`WhatsAppInboundMessageReceipt` (sender FK, unique sender/providerMessageId), and
the unique `MessageDraft(branchId,studentId,action,language)` index. Null student
drafts retain PostgreSQL's nullable uniqueness semantics. There is no guessed
backfill, history deletion, new environment variable, or provider operation.

Before an explicitly approved deployment, verify the target, backup/restore
evidence and current migrations. Record aggregate preflight results privately:

```sql
SELECT COUNT(*) AS drafts, COUNT(*) FILTER (WHERE "studentId" IS NULL) AS null_student_drafts FROM "MessageDraft";
SELECT COUNT(*) AS duplicate_groups, COALESCE(SUM(n - 1), 0) AS duplicate_excess
FROM (SELECT COUNT(*) AS n FROM "MessageDraft" WHERE "studentId" IS NOT NULL
  GROUP BY "branchId", "studentId", "action", "language" HAVING COUNT(*) > 1) d;
SELECT COUNT(*) AS running_reports FROM "Branch" WHERE "aiStatus" = 'RUNNING';
```

Any duplicate group blocks migration pending an owner-reviewed preservation or
resolution plan. Do not choose the newest draft, delete older drafts, or reset
the database automatically. The migration holds an exclusive MessageDraft lock,
rechecks duplicates, creates the index then both tables in one transaction; a
blocker rolls everything back. Resolve Prisma's failed-migration record only
through the established approved repair procedure after proving rollback.

Stop admissions and drain all old report/draft generation and inbound webhook
workers before applying the migration and promoting the matching application.
Hold inbound delivery with retryable responses at the approved ingress boundary;
do not acknowledge and discard messages. Empty RUNNING status is insufficient
proof of drain: verify in-flight function execution has ended. Old code does not
honor tokens and can overwrite a new draft/report or spend confirmation attempts,
so rolling old/new worker overlap is unsupported. Keep old deployments from
receiving direct traffic. Existing envelope receipts cannot reconstruct every
historical message identity; let outstanding confirmation challenges expire
during the approved hold before re-enabling confirmation admission. Retain
sender identities and existing webhook history. Rebatched old report-stop events
remain monotonic stop operations; no new confirmation may reuse an old challenge.

After migration, compare MessageDraft totals and null-student totals to preflight
while writers remain held; duplicate groups must be zero. Both new tables should
be empty before new traffic. Verify installed keys without exposing row contents:

```sql
SELECT indexname FROM pg_indexes WHERE tablename IN
  ('MessageDraft', 'BranchGenerationLease', 'WhatsAppInboundMessageReceipt');
SELECT conname, convalidated FROM pg_constraint WHERE conrelid IN
  ('"BranchGenerationLease"'::regclass, '"WhatsAppInboundMessageReceipt"'::regclass);
SELECT COUNT(*) AS leases FROM "BranchGenerationLease";
SELECT COUNT(*) AS inbound_identities FROM "WhatsAppInboundMessageReceipt";
```

Resume only the new writers and verify one accepted generation per branch/kind,
stale-token rejection, atomic batch publication and same-ID webhook replay using
approved synthetic Test traffic. Observe aggregate failures/lease expiry without
logging prompts, message text, codes or tokens. The local integration suite
proves those properties with fake providers and PostgreSQL, including migration
blocker rollback and preserved pre-change drafts.

Rollback is an admission hold and forward repair preserving the additive tables,
unique index, receipts and current tokens. Do not drop the fence or resume an old
unfenced binary over active work. If an older application must be restored, drain
new workers first and keep affected generation/confirmation paths held until a
compatible patch is deployed. No Production preflight, migration, drain,
challenge expiry operation, provider call or deployment was performed in this
sprint; each dependent Production action still requires explicit approval.

## Stop conditions and operator-owned preconditions

Do not migrate, deploy, enable billing, rotate a secret, restore data, or invoke
a protected Production job until the operator has supplied and verified the
items that are not encoded in this repository:

- the Vercel team, project, Production branch, Production domains, deployment
  path, deployment approvers, and rollback authority;
- the Vercel plan and function limits. The billing and five-/fifteen-/thirty-
  minute WhatsApp schedules require a plan that accepts those cron expressions;
  verify the eight-project-cron total, Production-only GET behavior, duplicate/
  overlap handling, callback protection, function duration/region/Fluid Compute,
  and monitoring. Import Assistance V2 additionally requires the approved
  Workflow 4.6/Fluid Compute configuration and limits;
- the exact Production database identity and a direct migration endpoint that
  has been checked independently of its URL text;
- the database backup owner, backup command, retention, most recent successful
  restore test, recovery point objective, and recovery time objective;
- the incident commander, on-call contact, escalation path, customer and
  regulatory notification owner, and approved private evidence location;
- the monitoring provider, alert thresholds, runtime-log retention, and the
  procedure for confirming that a deployment is healthy;
- the Import Assistance V2 owner/security approval, provider processing and
  data-residency review, benchmark evidence, analysis/completion SLOs,
  mutation-cap owner, Workflow/ledger monitoring, and active-run rollback or
  cancellation authority;
- the authority and dashboard procedure for disabling Vercel Cron Jobs or
  stopping Production traffic;
- the allowed overlap period for old and new Razorpay webhook secrets;
- the stable Preview and Production webhook hostnames and any Deployment
  Protection exception needed for Razorpay or Meta delivery;
- the Meta developer-app owner, Business verification and App Review/Advanced
  Access state for both WhatsApp permissions, token/app-secret rotation owners,
  dedicated Test WABA/phone, customer asset/billing ownership evidence, approved
  Utility templates, effective and unexpired estimated rate card, stable HTTPS
  callbacks, alerting and human `UNKNOWN`/sender-safety review, health-read
  permissions and calibration, legal/privacy/consent approval, incident owner,
  and approval authorities for onboarding, template writes, manual delivery,
  reports, service notices, health reconciliation, automation, and canary
  expansion; and
- the canonical Node.js and pnpm versions. CI currently uses Node.js 20 and
  pnpm 9, while the Production migration workflow uses Node.js 24 and pnpm 9;
  `package.json` does not pin either runtime.

If any applicable item is unknown, stop and obtain an operator decision. Do not
infer it from a hostname, environment-variable name, successful connection, or
previous deployment.

## Non-negotiable safety rules

- Never expose, commit, paste into an issue, or print secret values, connection
  strings, bearer tokens, webhook signatures, raw webhook bodies, or customer
  data.
- Never give Local, Test, or Preview a Production database, Clerk instance,
  Razorpay credential, webhook secret, or cron secret.
- Never run `prisma migrate dev`, `prisma db push`, or the seed command against
  Production. Never edit an applied migration.
- Never use browser success, a callback alone, or a locally inferred provider
  state as proof of payment. Signed webhooks and provider reconciliation remain
  authoritative.
- Never use browser-supplied Meta business, WABA, or phone identifiers as
  sender truth. Do not persist or print an Embedded Signup code/token, system
  token, app secret, registration PIN, verification token, raw signup session,
  or raw Meta webhook body.
- WhatsApp delivery is restricted to approved, code-managed Utility templates
  for exact confirmed/mapped/consented recipients through the durable dispatcher.
  Never invoke a provider write, test send, schedule, customer connection, or
  canary as an operational shortcut; never use arbitrary/free-form/media/
  marketing/OTP/AI content, credit sharing, or Lab Lords-funded/rebilled usage.
- Never improvise cleanup SQL, reverse an applied migration by hand, or
  automatically refund an ambiguous charge.
- Record the commit, deployment ID, migration workflow run, UTC start/end time,
  operator, checks, and outcome for every Production change.

## Environments

Vercel distinguishes Development, Preview, and Production deployments and lets
variables be scoped to each environment. See Vercel's official
[Environments](https://vercel.com/docs/deployments/environments) and
[Environment variables](https://vercel.com/docs/environment-variables)
documentation.

| Environment | Data and identity | Razorpay | Meta WhatsApp | Scheduled jobs | Data policy |
| --- | --- | --- | --- | --- | --- |
| Local Development | Dedicated local/development database and Clerk development instance | Test Mode only when billing is exercised | `TEST` only; synthetic/injected fake provider unless an explicitly approved isolated Test-app exercise is being performed | No automatic Vercel schedule; invoke protected routes manually | Synthetic or approved development data only |
| Automated Test | Dedicated disposable PostgreSQL test database; Clerk is mocked where needed | Test/fake configuration supplied by the test harness | Injected fake client and mocked Facebook SDK only; never contact Meta | None | Disposable fixtures only |
| Preview | Database and Clerk development instance isolated from Production | Test Mode with a Preview-only webhook secret | `TEST` only, dedicated Test app/config/WABA/phone and Preview-only secret/callback if separately configured | Vercel does not schedule Preview cron jobs; invoke the protected Preview route manually | Demo or approved sanitized data only |
| Production | Production database and Clerk production instance | Live Mode with Production-only credentials and webhook secret | `LIVE` only, Production-only configuration, and all WhatsApp flags held until the separately approved rollout | `vercel.json` declares schedules for the active Production deployment; verify that they are deployed and enabled | Customer data under the approved access and retention policy |

Preview and Production must have different database fingerprints, Clerk
instances, Razorpay modes and credentials, webhook secrets, and cron secrets.
They must also use isolated Meta Test/Live assets, credentials, system users,
Embedded Signup configurations, verification tokens, and callback hosts.
The detailed proof and release gates are in the
[Workspace billing V2 rollout](./workspace-billing-rollout.md).

### Configuration inventory

This is a name-only inventory. Obtain values from the approved secret manager or
provider dashboard; do not copy values into this document or command output.
The tracked [`.env.example`](../.env.example) shows the WhatsApp names with all
capabilities held and contains no usable credential or approved rate.

| Area | Configuration names |
| --- | --- |
| Application database | `DATABASE_URL`, `ACCELERATE_URL` |
| Direct migration connection | `DIRECT_URL`; GitHub Environment secret `PRODUCTION_DIRECT_DATABASE_URL` is mapped to it by the migration workflow |
| Clerk | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`; sign-in, sign-up, and fallback paths are code-defined rather than environment-defined |
| Razorpay credentials and mode | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_MODE`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_OLD_SECRETS`, `RAZORPAY_DEFAULT_SUBSCRIPTION_CYCLES` |
| Billing release controls | `RAZORPAY_BILLING_WRITES_ENABLED`, `RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED`, `RAZORPAY_LIVE_CANARY_ORG_IDS`, `WORKSPACE_BRANCH_BILLING_V2_ENABLED` |
| Meta WhatsApp credentials and mode | `META_WHATSAPP_MODE`, `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`, `META_BUSINESS_ID`, `META_SYSTEM_USER_ID`, `META_SYSTEM_USER_ACCESS_TOKEN`, `META_GRAPH_API_VERSION` (exactly `v25.0`), `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN` |
| WhatsApp release controls | `WHATSAPP_INTEGRATION_ENABLED`, `WHATSAPP_META_ONBOARDING_WRITES_ENABLED`, `WHATSAPP_META_TEMPLATE_WRITES_ENABLED`, `WHATSAPP_META_MESSAGE_WRITES_ENABLED`, `WHATSAPP_AUTOMATION_PLANNER_ENABLED`, `WHATSAPP_REPORTS_ENABLED`, `WHATSAPP_REPORT_PLANNER_ENABLED`, `WHATSAPP_SERVICE_NOTICES_ENABLED`, `WHATSAPP_HEALTH_RECONCILIATION_ENABLED`, `WHATSAPP_OPERATIONS_UI_ENABLED`, `WHATSAPP_WEBHOOK_INGEST_ENABLED`, `WHATSAPP_LIVE_CANARY_ORG_IDS`, `WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS`, `WHATSAPP_LIVE_AUTOMATION_CANARY_ORG_IDS`, `WHATSAPP_HEALTH_CANARY_ORG_IDS` |
| WhatsApp estimated rate card | `WHATSAPP_UTILITY_RATE_MICROS_INR`, `WHATSAPP_RATE_CARD_VERSION`, `WHATSAPP_RATE_CARD_EFFECTIVE_AT`, `WHATSAPP_RATE_CARD_EXPIRES_AT`; this is an operator-approved estimate, not a Meta invoice |
| Import V2 release controls | `IMPORT_V2_ENABLED`, `IMPORT_MAX_PLANNED_MUTATIONS` |
| Scheduled jobs | `CRON_SECRET` |
| Gemini | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FLASH_MODEL`, `GEMINI_PRO_MODEL`, `GEMINI_IMPORT_MODEL`, `GEMINI_FALLBACK_MODELS` |
| Public application configuration | `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `NEXT_PUBLIC_BUSINESS_ADDRESS`, `NEXT_PUBLIC_GA_MEASUREMENT_ID` |
| Script/deployment context | `BILLING_ENV_FILE`, `VERCEL_ENV`, `NODE_ENV` |

Every `NEXT_PUBLIC_` variable is browser-visible and must contain no secret.
`RAZORPAY_KEY_ID` remains server-only; do not introduce
`NEXT_PUBLIC_RAZORPAY_KEY_ID`.
No Meta secret is public. Only the app ID, server-selected Embedded Signup
configuration ID, pinned Graph version, mode, and sanitized availability may be
returned by the authenticated owner-only configuration endpoint. Do not add a
`NEXT_PUBLIC_META_*` or `NEXT_PUBLIC_WHATSAPP_*` secret.

Environment-variable changes apply only to new Vercel deployments. After any
addition, removal, flag change, or secret rotation, create a new deployment and
verify that deployment before invalidating an old credential. A running local
Next.js process must likewise be restarted. Old deployments can continue using
their original configuration; account for that during rotation and rollback.

## Validation and destructive test-database warning

Use pnpm and retain exact command results:

```text
pnpm install --frozen-lockfile
pnpm prisma generate
pnpm lint
pnpm test
pnpm test:workflow
pnpm build
```

Run more targeted tests while developing, then the broader affected suite. CI
also runs coverage. Browser tests are available through `pnpm test:browser` when
the change affects an end-to-end flow.

> **Destructive database warning:** Vitest loads `.env.test`, checks only that
> `DATABASE_URL` contains the text `test`, and integration-test setup can execute
> `TRUNCATE ... CASCADE` across all application tables. That substring check does
> not prove isolation. Before any integration test, independently verify the
> database host, database name, account, and environment. Never point `.env.test`
> at a shared Development, Preview, staging, or Production database.

CI provisions its own PostgreSQL service, applies migrations with
`pnpm prisma migrate deploy`, and then runs lint, tests, build, and coverage. A
green CI run is required evidence, but it does not prove that external Clerk,
Razorpay, Gemini, Vercel, DNS, backup, or alerting configuration is correct.

## Database migrations

Prisma reads migrations from `prisma/migrations`. Application traffic normally
uses `DATABASE_URL` or `ACCELERATE_URL`; `prisma.config.ts` uses `DIRECT_URL` when
present and otherwise falls back to `DATABASE_URL`.

### Creating and validating a migration

1. Create a migration only against an isolated development database with
   `pnpm prisma migrate dev --name <descriptive-name>`.
2. Inspect the generated SQL, schema diff, indexes, constraints, backfill,
   locking behavior, and compatibility with both the old and new application.
3. Do not rewrite prior migration history. Commit the schema and new migration
   together.
4. Apply from a clean checkout to a disposable Test database with
   `pnpm prisma migrate deploy`.
5. Apply to the isolated Preview database and run the affected tests and smoke
   checks.
6. For destructive, long-running, or contract migrations, use an approved
   expand/backfill/compatible-code/contract sequence. Do not assume an
   application rollback will make an incompatible database schema safe.

The workspace-billing migrations have a specific expansion, backfill, cutover,
and release sequence. Follow the
[Workspace billing V2 rollout](./workspace-billing-rollout.md) rather than
reconstructing that order here.

### Allocation tenant relationship migration (2026-09-05)

`20260905090000_scope_allocation_relationships` adds required
`SeatAllocation.branchId`, composite unique keys on `(id, branchId)` for
`Student`, `Seat`, `Shift`, and `MultiShift`, four composite allocation foreign
keys, and the `(branchId, shiftId, endDate)` allocation index. No owner,
subscription, payment, or provider record is changed.

Before separately approving Production application, retain read-only counts:

```sql
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE a."endDate" IS NULL) AS active,
       COUNT(*) FILTER (WHERE a."multiShiftId" IS NOT NULL) AS bundled,
       COUNT(*) FILTER (WHERE se.id IS NULL OR st.id IS NULL OR sh.id IS NULL
         OR se."branchId" IS DISTINCT FROM st."branchId"
         OR se."branchId" IS DISTINCT FROM sh."branchId"
         OR (a."multiShiftId" IS NOT NULL AND
           (ms.id IS NULL OR se."branchId" IS DISTINCT FROM ms."branchId"))) AS inconsistent
FROM "SeatAllocation" a
LEFT JOIN "Seat" se ON se.id = a."seatId"
LEFT JOIN "Student" st ON st.id = a."studentId"
LEFT JOIN "Shift" sh ON sh.id = a."shiftId"
LEFT JOIN "MultiShift" ms ON ms.id = a."multiShiftId";
```

Require `inconsistent = 0`; privately review any offending rows with the owner.
Do not guess a branch or delete data to pass. The migration repeats this check
under write-excluding table locks, adds the nullable column, backfills only
confirmed same-branch relationships, makes it required, and installs validated
constraints in one transaction. Failure rolls back all schema/data changes.

This is a coordinated release, not compatible with rolling old/new writers:
old inserts omit `branchId`, while new code requires the migrated schema. Under
separate approval, take the verified backup, drain interactive/import allocation
writers, apply the migration, deploy matching code, verify, then resume writers.
No environment variable, provider mutation, or commercial-policy change is
required. The onboarding flag requirement in Normal release also applies.

After migration, rerun the preflight and require unchanged total/active/bundled
counts and zero inconsistent rows. Additionally verify:

```sql
SELECT COUNT(*) AS invalid_branch FROM "SeatAllocation" a
JOIN "Seat" s ON s.id = a."seatId"
WHERE a."branchId" IS DISTINCT FROM s."branchId";
SELECT conname, convalidated FROM pg_constraint
WHERE conrelid = '"SeatAllocation"'::regclass AND contype = 'f';
```

Require zero invalid branches and all four new `*_branchId_fkey` constraints
validated. Smoke-test same-branch allocation/reallocation, foreign-reference
rejection, historical release, and concurrent allocation/deactivation. The
new-code application must not start before the migration. An old-code rollback
cannot resume allocation writes against this schema; keep writers held and
forward-repair or deploy a compatible application. Do not drop the new tenant
constraints as an automatic rollback, rewrite applied migration history, or
discard allocation history.

### Exact commercial-evidence migration

Migration `20260829120000_add_exact_commercial_evidence` is an additive billing
expansion. It adds:

- the `COMMERCIAL_RECONCILIATION` billing-change type;
- immutable commercial-intent fields on `OrganizationBillingChange` for the
  source and target provider identities, mode, plan, quantity, offer-adjusted
  amounts, currency, and cadence;
- the confirmed-intent pointer on `OrganizationSubscription`;
- exact provider, invoice, payment, amount, currency, and settlement evidence
  on `OrganizationSubscriptionInvoice`;
- supporting foreign keys, indexes, and all-null-or-complete check constraints.

The migration does not update, delete, or infer any existing commercial row.
In particular, it does not backfill historical intent from the current plan
catalog. Existing rows remain valid with the new evidence tuple entirely null.

Before an operator-approved application, verify the target through the normal
protected migration preflight, take the approved backup, record the application
commit, and capture these counts privately:

```sql
SELECT
  (SELECT COUNT(*) FROM "OrganizationBillingChange") AS billing_change_count,
  (SELECT COUNT(*) FROM "OrganizationSubscription") AS subscription_count,
  (SELECT COUNT(*) FROM "OrganizationSubscriptionInvoice") AS invoice_count;

SELECT "migration_name", "finished_at", "rolled_back_at"
FROM "_prisma_migrations"
WHERE "migration_name" = '20260829120000_add_exact_commercial_evidence';
```

The migration-history query must return no row before the first application. If
it reports an applied or rolled-back record, stop and reconcile migration
history; never edit or reapply an already applied migration. For strict
pre/post count comparison, pause the hourly billing processor and signed billing
event processing through the approved operational controls and drain active
leases. Holding `RAZORPAY_BILLING_WRITES_ENABLED` alone is insufficient because
it does not stop signed reconciliation.

Deploy database-first. The previous application is compatible with the added
nullable columns, enum value, indexes, foreign keys, and permissive all-null
branch of the checks. Apply and verify the migration before deploying code that
writes or reads exact commercial evidence. Do not enable a billing flag or Live
canary between those steps.

Immediately after migration and before the new application processes billing,
repeat the three row counts and run:

```sql
SELECT
  COUNT(*) FILTER (WHERE "commercialIntentVersion" IS NOT NULL)
    AS versioned_change_count,
  COUNT(*) FILTER (WHERE "authorizedRazorpaySubscriptionId" IS NOT NULL)
    AS bound_target_count
FROM "OrganizationBillingChange";

SELECT
  COUNT(*) FILTER (WHERE "confirmedCommercialIntentChangeId" IS NOT NULL)
    AS confirmed_intent_pointer_count
FROM "OrganizationSubscription";

SELECT
  COUNT(*) FILTER (WHERE "commercialEvidenceVersion" IS NOT NULL)
    AS versioned_invoice_count
FROM "OrganizationSubscriptionInvoice";

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname IN (
  'OrganizationBillingChange_commercial_intent_complete_check',
  'OrganizationSubscriptionInvoice_commercial_evidence_check',
  'OrganizationSubscription_confirmedCommercialIntentChangeId_fkey',
  'OrganizationSubscriptionInvoice_commercialIntentChangeId_fkey'
)
ORDER BY conname;

SELECT indexname, indexdef
FROM pg_indexes
WHERE indexname IN (
  'OrganizationSubscription_confirmedCommercialIntentChangeId_key',
  'BillingChange_commercial_intent_idx',
  'BillingChange_authorized_subscription_idx',
  'BillingChange_authorized_source_subscription_idx',
  'SubscriptionInvoice_provider_period_idx',
  'SubscriptionInvoice_commercial_intent_idx'
)
ORDER BY indexname;
```

With billing processing held, all three versioned-evidence counts are expected
to be zero and the table row counts must equal the recorded pre-migration
counts. The constraint query must return four rows and the index query six.
Then run `pnpm prisma migrate status`, Prisma validation/generation, the focused
billing unit and integration suites, lint, and the Production build before
resuming billing processing or enabling a canary.

There is no automatic down migration. An application rollback may leave this
additive schema in place; the previous application ignores it. Prefer a
compatible forward repair. Once the new application has written a commercial
intent, confirmed-intent pointer, invoice evidence, or manual-review history,
dropping these fields or links would destroy billing lineage and is prohibited.
The migration itself performs no Razorpay operation, refund, cancellation, or
charge; an application rollback likewise does not reverse provider state.

### Payment identity and resolution-event migration

Migration `20260822090000_payment_type_identity_and_resolution_events` changes
payment identity from `(studentId, periodStart)` to
`(studentId, type, periodStart)` and creates an initially empty immutable
resolution-event ledger. It does not rewrite or delete any `Payment` row and it
does not fabricate events for resolutions that occurred before deployment.

Before applying it to any operator-approved target, record the payment count
and run these read-only checks:

```sql
SELECT COUNT(*) AS payment_count
FROM "Payment";

SELECT
  "studentId",
  "type",
  "periodStart",
  COUNT(*) AS row_count
FROM "Payment"
GROUP BY "studentId", "type", "periodStart"
HAVING COUNT(*) > 1;

SELECT
  "studentId",
  "periodStart",
  COUNT(*) AS row_count,
  COUNT(DISTINCT "type") AS type_count
FROM "Payment"
GROUP BY "studentId", "periodStart"
HAVING COUNT(*) > 1;
```

Both duplicate queries are expected to return zero groups while the old unique
index is still enforced. If either returns rows, stop. Record the exact
conflicting identifiers privately and obtain a separately reviewed data plan;
do not delete, merge, or rewrite payments automatically.

Inspect the actual PostgreSQL objects rather than inferring them from migration
filenames:

```sql
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('Payment', 'PaymentResolutionEvent')
ORDER BY tablename, indexname;

SELECT
  conrelid::regclass::text AS table_name,
  conname,
  contype,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = '"Payment"'::regclass
   OR conrelid = to_regclass('"PaymentResolutionEvent"')
ORDER BY table_name, conname;
```

The migration creates `Payment_studentId_type_periodStart_key` before dropping
`Payment_studentId_periodStart_key`. Immediately afterward, verify all of the
following before allowing payment writes:

- the `Payment` row count exactly equals the recorded pre-migration count;
- the same-type duplicate query still returns zero rows;
- `Payment_studentId_type_periodStart_key` exists and is unique;
- `Payment_studentId_periodStart_key` no longer exists;
- `PaymentResolutionEvent` exists with restrictive payment and branch foreign
  keys, a nullable actor foreign key using `ON DELETE SET NULL`, and indexes on
  `(paymentId, occurredAt, id)` and `(branchId, occurredAt, id)`;
- `SELECT COUNT(*) FROM "PaymentResolutionEvent";` returns zero immediately
  after migration, before the new application accepts resolution writes; and
- `pnpm prisma migrate status` reports a clean migration state.

Rollback has a data-dependent boundary. Before the new application writes an
admission and monthly payment sharing the same student and period start, it may
be possible to restore the old untyped unique constraint. After legitimate
typed-coexistence rows exist, that constraint cannot be restored without a
conflict. Disable payment writes before any rollback attempt, inspect exact
conflicting rows, never delete a legitimate payment merely to make rollback
easier, and prefer rolling the application forward. Any post-write schema
rollback is a controlled data-reconciliation operation requiring separate
operator approval; this repository does not provide an automatic down
migration.

### WhatsApp communication-foundation migration

Migration `20260822120000_whatsapp_communication_foundation` is an additive
expansion. It adds the three WhatsApp staff-permission enum values, the
WhatsApp enums, and ten initially empty foundation tables with their indexes
and foreign keys. It does not update or delete an existing organization,
branch, permission override, student, payment, payment-resolution event,
subscription, sender, consent, or message row, and it performs no backfill.
`BranchWhatsAppSettings.enabled` defaults to false, but the migration creates no
settings rows. Do not run this migration against Preview or Production merely
because the code has been merged.

Before an operator-approved application, identify and record the target and
run the payment preflight above. Record these existing-table counts with a UTC
timestamp in the private release record:

```sql
SELECT COUNT(*) AS organization_count FROM "Organization";
SELECT COUNT(*) AS branch_count FROM "Branch";
SELECT COUNT(*) AS staff_permission_override_count
FROM "StaffPermissionOverride";
SELECT COUNT(*) AS payment_count FROM "Payment";
SELECT COUNT(*) AS payment_resolution_event_count
FROM "PaymentResolutionEvent";
```

Inspect the actual pre-migration permission values and relevant indexes and
constraints rather than trusting generated code or a migration filename:

```sql
SELECT e.enumsortorder, e.enumlabel
FROM pg_type AS t
JOIN pg_enum AS e ON e.enumtypid = t.oid
WHERE t.typname = 'StaffPermissionAction'
ORDER BY e.enumsortorder;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename IN (
  'Organization',
  'Branch',
  'StaffPermissionOverride',
  'Payment',
  'PaymentResolutionEvent'
)
ORDER BY tablename, indexname;

SELECT
  conrelid::regclass::text AS table_name,
  conname,
  contype,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN (
  '"Organization"'::regclass,
  '"Branch"'::regclass,
  '"StaffPermissionOverride"'::regclass,
  '"Payment"'::regclass,
  '"PaymentResolutionEvent"'::regclass
)
ORDER BY table_name, conname;
```

Before this migration, every value in the following query must be null. If any
foundation table or same-named enum already exists unexpectedly, stop and
reconcile the target's migration history; do not improvise around it.

```sql
SELECT
  to_regclass('"WhatsAppSender"') AS whatsapp_sender,
  to_regclass('"WhatsAppConnectionIntent"') AS whatsapp_connection_intent,
  to_regclass('"BranchWhatsAppSettings"') AS branch_whatsapp_settings,
  to_regclass('"WhatsAppTemplate"') AS whatsapp_template,
  to_regclass('"WhatsAppConsent"') AS whatsapp_consent,
  to_regclass('"WhatsAppConsentEvent"') AS whatsapp_consent_event,
  to_regclass('"WhatsAppMessage"') AS whatsapp_message,
  to_regclass('"WhatsAppMessageEvent"') AS whatsapp_message_event,
  to_regclass('"WhatsAppWebhookReceipt"') AS whatsapp_webhook_receipt,
  to_regclass('"WhatsAppAuditEvent"') AS whatsapp_audit_event;

SELECT typname
FROM pg_type
WHERE typname LIKE 'WhatsApp%'
ORDER BY typname;
```

Expected precondition: the payment identity/resolution-event migration is
already applied and clean, `Payment_studentId_type_periodStart_key` remains the
typed unique key, the recorded baseline queries complete, the three new
permission values are absent, and no WhatsApp object exists. No existing
permission override needs rewriting.

Immediately after the migration and before enabling any WhatsApp flag, repeat
the five baseline counts and require exact equality. Then verify the additive
objects through `pg_type`, `pg_enum`, `pg_indexes`, and `pg_constraint`. At
minimum, confirm:

- `VIEW_WHATSAPP`, `SEND_WHATSAPP`, and `MANAGE_WHATSAPP` appear exactly once in
  `StaffPermissionAction`, and all new WhatsApp enums contain the reviewed
  values;
- all ten tables exist with the reviewed unique/index and history-preserving
  `RESTRICT`/`SET NULL` policies;
- `WhatsAppSender` has unique provider/mode/phone identity;
- branch assignment has one row per branch and does not structurally assert
  cross-organization trust;
- consent is unique by sender/phone/type, message and webhook dedupe keys are
  unique, and append-only event indexes exist;
- `Payment_studentId_type_periodStart_key` and
  `PaymentResolutionEvent` remain intact; and
- `pnpm prisma migrate status` is clean against the independently verified
  direct target.

Every new table must be empty immediately after the expansion, and no branch
may be enabled:

```sql
SELECT COUNT(*) AS sender_count FROM "WhatsAppSender";
SELECT COUNT(*) AS connection_intent_count FROM "WhatsAppConnectionIntent";
SELECT COUNT(*) AS branch_settings_count FROM "BranchWhatsAppSettings";
SELECT COUNT(*) AS enabled_branch_settings_count
FROM "BranchWhatsAppSettings"
WHERE "enabled" = true;
SELECT COUNT(*) AS template_count FROM "WhatsAppTemplate";
SELECT COUNT(*) AS consent_count FROM "WhatsAppConsent";
SELECT COUNT(*) AS consent_event_count FROM "WhatsAppConsentEvent";
SELECT COUNT(*) AS message_count FROM "WhatsAppMessage";
SELECT COUNT(*) AS message_event_count FROM "WhatsAppMessageEvent";
SELECT COUNT(*) AS webhook_receipt_count FROM "WhatsAppWebhookReceipt";
SELECT COUNT(*) AS whatsapp_audit_count FROM "WhatsAppAuditEvent";
```

Every result above must be zero. A nonzero result means provider/application
work has already occurred or the target was not the expected pre-migration
state; stop and investigate without deleting evidence.

The application/migration compatibility boundary is flag-controlled. It is
safe for the reviewed application to deploy briefly before this expansion only
while all WhatsApp flags are absent/false, because ordinary flag-off paths do
not query the new tables or initialize provider work eagerly. Apply the
migration before any flag or customer onboarding is enabled.

There is no automatic down migration. Before any WhatsApp row exists, an
operator may separately review a schema-only rollback, but PostgreSQL enum and
dependency handling still requires an exact plan. After a sender, intent,
template, consent, receipt, or audit row exists, first disable all WhatsApp
flags and stop webhook ingestion, preserve the rows and signed/audit evidence,
and prefer a compatible forward correction. Dropping any WhatsApp table or
enum after data exists is destructive and requires separate human approval,
exact affected-row counts, export/retention decisions, and a tested recovery
plan. Local disconnect is not schema rollback.

### WhatsApp template-delivery and collections migration

Migration `20260823120000_whatsapp_template_delivery_and_collections` is a
second additive expansion after the PR2 foundation. It adds enrollment-source,
catalogue/provisioning, recipient, automation, manual-request, trigger, budget,
  event-source, and receipt-processing types; adds five new domain tables plus the
  narrow `WhatsAppMessagePayment` join; extends the existing settings, consent,
  message, event, webhook-receipt, and audit schemas; and converts message cost
  columns to `BIGINT`. The nullable planner recipient/correction/paid cursor
  fields begin empty and are advanced only by a lease-owned planner transaction.
  It creates no student, recipient, consent, template,
binding, automation rule, message, payment join, or provider action. Existing
students receive only the safe `LEGACY` source default. Existing branch settings
retain delivery disabled state and receive no `automationEnabledAt`.

The migration intentionally aborts before alteration if any
`WhatsAppMessage` row exists. That is a hard compatibility precondition because
PR3 adds required trusted snapshots that must not be fabricated for historical
outbox rows. Do not delete or rewrite a row to satisfy it; stop and inspect exact
statuses, provider IDs, event history, budget state, and ownership privately.

Before an operator-approved application, require the PR1 and PR2 migrations to
be applied and clean, record the direct target identity independently, and save
the following read-only output with a UTC timestamp in the private release
record. Every count is a comparison baseline, not permission to expose row data.

```sql
SELECT "migration_name", "finished_at", "rolled_back_at"
FROM "_prisma_migrations"
WHERE "migration_name" IN (
  '20260822090000_payment_type_identity_and_resolution_events',
  '20260822120000_whatsapp_communication_foundation',
  '20260823120000_whatsapp_template_delivery_and_collections'
)
ORDER BY "migration_name";

SELECT 'Organization' AS relation, COUNT(*) AS row_count FROM "Organization"
UNION ALL SELECT 'Branch', COUNT(*) FROM "Branch"
UNION ALL SELECT 'Student', COUNT(*) FROM "Student"
UNION ALL SELECT 'Payment', COUNT(*) FROM "Payment"
UNION ALL SELECT 'PaymentResolutionEvent', COUNT(*) FROM "PaymentResolutionEvent"
UNION ALL SELECT 'WhatsAppSender', COUNT(*) FROM "WhatsAppSender"
UNION ALL SELECT 'WhatsAppConnectionIntent', COUNT(*) FROM "WhatsAppConnectionIntent"
UNION ALL SELECT 'BranchWhatsAppSettings', COUNT(*) FROM "BranchWhatsAppSettings"
UNION ALL SELECT 'WhatsAppTemplate', COUNT(*) FROM "WhatsAppTemplate"
UNION ALL SELECT 'WhatsAppConsent', COUNT(*) FROM "WhatsAppConsent"
UNION ALL SELECT 'WhatsAppConsentEvent', COUNT(*) FROM "WhatsAppConsentEvent"
UNION ALL SELECT 'WhatsAppMessage', COUNT(*) FROM "WhatsAppMessage"
UNION ALL SELECT 'WhatsAppMessageEvent', COUNT(*) FROM "WhatsAppMessageEvent"
UNION ALL SELECT 'WhatsAppWebhookReceipt', COUNT(*) FROM "WhatsAppWebhookReceipt"
UNION ALL SELECT 'WhatsAppAuditEvent', COUNT(*) FROM "WhatsAppAuditEvent"
ORDER BY relation;

SELECT COUNT(*) AS whatsapp_message_precondition_must_be_zero
FROM "WhatsAppMessage";

SELECT
  COUNT(*) AS settings_rows,
  COUNT(*) FILTER (WHERE "enabled" = true) AS enabled_delivery_rows_must_be_zero
FROM "BranchWhatsAppSettings";

SELECT
  to_regclass('"WhatsAppStudentRecipient"') AS recipient,
  to_regclass('"WhatsAppManagedTemplateProvisioning"') AS provisioning,
  to_regclass('"WhatsAppTemplateBinding"') AS binding,
  to_regclass('"WhatsAppAutomationRule"') AS automation_rule,
  to_regclass('"WhatsAppManualSendRequest"') AS manual_request,
  to_regclass('"WhatsAppMessagePayment"') AS message_payment;

SELECT typname
FROM pg_type
WHERE typname IN (
  'StudentEnrollmentSource',
  'WhatsAppManagedTemplateKey',
  'WhatsAppManagedTemplateProvisioningStatus',
  'WhatsAppAutomationStage',
  'WhatsAppMessageTrigger',
  'WhatsAppBudgetState',
  'WhatsAppMessageEventSource',
  'WhatsAppRecipientRelationship',
  'WhatsAppStudentRecipientStatus',
  'WhatsAppManualSendRequestStatus'
)
ORDER BY typname;
```

Preconditions are: the two earlier migrations have one successful non-rolled-
back record, the PR3 migration has none, `WhatsAppMessage` is exactly empty,
all six PR3 tables resolve null, and all ten new types are absent. Separately
inspect `pg_indexes`, `pg_constraint`, and `information_schema.columns` for the
current payment identity, immutable resolution events, and PR2 WhatsApp objects;
do not trust generated client code as database evidence.

Immediately after migration, before deploying any flag-enabled artifact or
enabling any WhatsApp flag, repeat the entire baseline query and require exact
equality for every pre-existing table. `WhatsAppMessage` and
`WhatsAppMessageEvent` remain zero.
Then run these safe-default checks:

```sql
SELECT
  COUNT(*) AS all_students,
  COUNT(*) FILTER (WHERE "enrollmentSource" = 'LEGACY') AS legacy_students,
  COUNT(*) FILTER (WHERE "enrollmentSource" <> 'LEGACY') AS unexpected_nonlegacy
FROM "Student";

SELECT
  COUNT(*) AS settings_rows,
  COUNT(*) FILTER (WHERE "enabled" = true) AS enabled_delivery_rows,
  COUNT(*) FILTER (WHERE "automationEnabledAt" IS NOT NULL) AS automation_enabled_rows,
  COUNT(*) FILTER (WHERE "configurationRevision" <> 1) AS unexpected_revision_rows
FROM "BranchWhatsAppSettings";

SELECT 'WhatsAppStudentRecipient' AS relation, COUNT(*) AS row_count
FROM "WhatsAppStudentRecipient"
UNION ALL SELECT 'WhatsAppManagedTemplateProvisioning', COUNT(*)
FROM "WhatsAppManagedTemplateProvisioning"
UNION ALL SELECT 'WhatsAppTemplateBinding', COUNT(*)
FROM "WhatsAppTemplateBinding"
UNION ALL SELECT 'WhatsAppAutomationRule', COUNT(*)
FROM "WhatsAppAutomationRule"
UNION ALL SELECT 'WhatsAppManualSendRequest', COUNT(*)
FROM "WhatsAppManualSendRequest"
UNION ALL SELECT 'WhatsAppMessagePayment', COUNT(*)
FROM "WhatsAppMessagePayment"
ORDER BY relation;

SELECT column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN (
    'Student', 'BranchWhatsAppSettings', 'WhatsAppConsent',
    'WhatsAppConsentEvent', 'WhatsAppMessage', 'WhatsAppMessageEvent',
    'WhatsAppWebhookReceipt'
  )
ORDER BY table_name, ordinal_position;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename LIKE 'WhatsApp%'
   OR tablename = 'BranchWhatsAppSettings'
ORDER BY tablename, indexname;

SELECT conrelid::regclass::text AS table_name,
       conname,
       contype,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid::regclass::text LIKE '%WhatsApp%'
   OR conrelid = '"BranchWhatsAppSettings"'::regclass
ORDER BY table_name, conname;

SELECT t.typname, e.enumsortorder, e.enumlabel
FROM pg_type AS t
JOIN pg_enum AS e ON e.enumtypid = t.oid
WHERE t.typname IN (
  'StudentEnrollmentSource',
  'WhatsAppManagedTemplateKey',
  'WhatsAppManagedTemplateProvisioningStatus',
  'WhatsAppAutomationStage',
  'WhatsAppMessageTrigger',
  'WhatsAppBudgetState',
  'WhatsAppMessageEventSource',
  'WhatsAppRecipientRelationship',
  'WhatsAppStudentRecipientStatus',
  'WhatsAppManualSendRequestStatus',
  'WhatsAppMessagePurpose',
  'WhatsAppWebhookReceiptStatus',
  'WhatsAppAuditAction'
)
ORDER BY t.typname, e.enumsortorder;
```

The `all_students` and `legacy_students` counts must match and
`unexpected_nonlegacy` must be zero. Every new-table count must be zero; no
automation timestamp or rule, recipient mapping, consent, template/provider
action, outbox row, or payment join may appear. Require the pre/post total
consent count to match exactly. Confirm the payment typed unique key
and all resolution-event rows remain intact, the new enum values/indexes/FKs
match the reviewed SQL, and `pnpm prisma migrate status` is clean against the
independently verified direct target.

This release is **not application-first compatible with the PR2 schema**.
`Student.enrollmentSource` is an ordinary Prisma scalar used by student reads,
manual creation, and imports, independent of the WhatsApp flags. Use the
database-first sequence below under the approved deployment/traffic hold: run
the preflight while the old application is serving, hold deployments and
student/import mutations, apply and verify the additive migration, and only
then promote the new application. The new WhatsApp flags and every canary list
must still remain false/empty throughout. A separately reviewed compatibility
release would be required to use any app-first sequence.

There is no down migration. Before any PR3 row or provider action exists,
schema-only rollback is still a separately reviewed PostgreSQL operation. After
any recipient, provisioning, binding, rule, request, message/payment join,
provider ID, status event, or consent evidence exists, disable integration,
template writes, message writes, planning, onboarding writes, and webhook
ingestion; clear every Live/health canary; stop all WhatsApp schedules; preserve
`UNKNOWN`, budget, provider IDs, receipts, and all history; and prefer a
compatible forward repair. Never edit prior migration history or drop evidence
to make rollback appear clean.

### WhatsApp reports, notices, and hardening migration

`20260824120000_whatsapp_reports_notices_and_hardening` is additive. It adds the
report, notice, sender-safety, incident, and job models; message/source links;
sender webhook/health evidence; the report permission; managed catalogue keys;
and audit actions. It contains no row-creating DML and enables no capability.
Its only row mutation is a conservative evidence backfill: every pre-existing
`SUBMITTING` message receives `providerCallAdmittedAt` from
`submissionStartedAt`, then `claimedAt`, then `updatedAt`. This ensures new code
can classify a stale legacy submission as `UNKNOWN` but can never retry it as an
unadmitted request. The migration must preserve all PR1 payment truth plus all
PR2/PR3 WhatsApp rows, provider IDs, template hashes/bindings, consent, events,
and reservations.

Before migration, hold all WhatsApp message/planner flags false, keep all PR4
flags false and every canary list empty, and pause the dispatcher schedule
through the approved Vercel control. Verify the schedule is paused and let the
last active dispatcher worker and lease drain. Then run this read-only gate on
the independently verified target:

```sql
SELECT COUNT(*) AS in_flight_messages
FROM "WhatsAppMessage"
WHERE "status" = 'SUBMITTING'::"WhatsAppMessageStatus"
   OR (
     "status" = 'CLAIMED'::"WhatsAppMessageStatus"
     AND "leaseUntil" >= CURRENT_TIMESTAMP
   );
```

`in_flight_messages` must be exactly zero immediately before migration. A
nonzero result blocks migration: continue the approved drain or investigate the
stuck worker without resetting, retrying, or deleting its message. This gate and
the migration perform no Meta operation. The backfill is defense in depth for a
legacy `SUBMITTING` row that survives despite the gate; it is not permission to
skip the zero-in-flight requirement.

Run the following read-only inventory on the independently verified target and
keep the exact results in the approved private release record:

```sql
SELECT 'Organization' AS relation, COUNT(*) FROM "Organization"
UNION ALL SELECT 'Branch', COUNT(*) FROM "Branch"
UNION ALL SELECT 'User', COUNT(*) FROM "User"
UNION ALL SELECT 'Staff', COUNT(*) FROM "Staff"
UNION ALL SELECT 'Student', COUNT(*) FROM "Student"
UNION ALL SELECT 'Payment', COUNT(*) FROM "Payment"
UNION ALL SELECT 'PaymentResolutionEvent', COUNT(*) FROM "PaymentResolutionEvent"
UNION ALL SELECT 'WhatsAppSender', COUNT(*) FROM "WhatsAppSender"
UNION ALL SELECT 'BranchWhatsAppSettings', COUNT(*) FROM "BranchWhatsAppSettings"
UNION ALL SELECT 'WhatsAppTemplate', COUNT(*) FROM "WhatsAppTemplate"
UNION ALL SELECT 'WhatsAppTemplateBinding', COUNT(*) FROM "WhatsAppTemplateBinding"
UNION ALL SELECT 'WhatsAppConsent', COUNT(*) FROM "WhatsAppConsent"
UNION ALL SELECT 'WhatsAppConsentEvent', COUNT(*) FROM "WhatsAppConsentEvent"
UNION ALL SELECT 'WhatsAppStudentRecipient', COUNT(*) FROM "WhatsAppStudentRecipient"
UNION ALL SELECT 'WhatsAppAutomationRule', COUNT(*) FROM "WhatsAppAutomationRule"
UNION ALL SELECT 'WhatsAppManualSendRequest', COUNT(*) FROM "WhatsAppManualSendRequest"
UNION ALL SELECT 'WhatsAppMessage', COUNT(*) FROM "WhatsAppMessage"
UNION ALL SELECT 'WhatsAppMessageEvent', COUNT(*) FROM "WhatsAppMessageEvent"
UNION ALL SELECT 'WhatsAppWebhookReceipt', COUNT(*) FROM "WhatsAppWebhookReceipt"
UNION ALL SELECT 'WhatsAppAuditEvent', COUNT(*) FROM "WhatsAppAuditEvent"
ORDER BY relation;

SELECT typname, enumlabel, enumsortorder
FROM pg_type
JOIN pg_enum ON pg_enum.enumtypid = pg_type.oid
WHERE typname LIKE 'WhatsApp%' OR typname = 'StaffPermissionAction'
ORDER BY typname, enumsortorder;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename LIKE 'WhatsApp%' OR tablename = 'BranchWhatsAppSettings'
ORDER BY tablename, indexname;

SELECT conrelid::regclass::text AS relation, conname,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid::regclass::text LIKE '%WhatsApp%'
ORDER BY relation, conname;
```

Privately fingerprint the existing non-secret template catalogue hashes,
bindings, message/provider IDs, consent/event rows, and payment/event rows so
post-migration equality can be established without publishing customer data.
If an existing WhatsApp relation is nonempty, a clean empty-database migration
test is insufficient: exact preservation is a release gate.

After migration and before promoting PR4 code, repeat the complete inventory and
fingerprints. Existing counts and fingerprints must match exactly. Then require:

```sql
SELECT 'WhatsAppReportSubscription' AS relation, COUNT(*) FROM "WhatsAppReportSubscription"
UNION ALL SELECT 'OrganizationWhatsAppReportSettings', COUNT(*) FROM "OrganizationWhatsAppReportSettings"
UNION ALL SELECT 'WhatsAppDailyReportSnapshot', COUNT(*) FROM "WhatsAppDailyReportSnapshot"
UNION ALL SELECT 'WhatsAppServiceNotice', COUNT(*) FROM "WhatsAppServiceNotice"
UNION ALL SELECT 'WhatsAppSenderSafetyState', COUNT(*) FROM "WhatsAppSenderSafetyState"
UNION ALL SELECT 'WhatsAppOperationalIncident', COUNT(*) FROM "WhatsAppOperationalIncident"
UNION ALL SELECT 'WhatsAppJobRun', COUNT(*) FROM "WhatsAppJobRun"
ORDER BY relation;

SELECT COUNT(*) AS unexpectedly_paused
FROM "WhatsAppSenderSafetyState"
WHERE "pausedAt" IS NOT NULL OR "pauseRequestedAt" IS NOT NULL;

SELECT COUNT(*) AS submitting_without_admission
FROM "WhatsAppMessage"
WHERE "status" = 'SUBMITTING'::"WhatsAppMessageStatus"
  AND "providerCallAdmittedAt" IS NULL;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'WhatsAppDailyReportSnapshot'
  AND column_name IN ('scheduledCutoffAt', 'metricsAsOfAt', 'metricsVersion')
ORDER BY column_name;

SELECT indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'WhatsAppDailyReportSnapshot'
  AND indexname = 'WhatsAppReportSnapshot_scope_date_cutoff_version_key';
```

Every new-table count, `unexpectedly_paused`, and
`submitting_without_admission` must be zero. Confirm
`RECEIVE_WHATSAPP_REPORTS` and every reviewed enum/audit/catalogue value exists,
`metricsAsOfAt` is non-nullable, and the report snapshot unique index covers
exactly scope, scope key, local report date, scheduled cutoff, and metrics
version. Confirm no subscription/report/notice/message/consent was created, all
flags remain false, all canaries remain empty, and `pnpm prisma migrate status`
is clean.

PR4 code is safe with all PR4 flags off, but it requires the additive schema;
therefore use database-first promotion under the approved traffic/mutation hold.
Ordinary non-WhatsApp pages and PR3 flag-off behavior must remain healthy before
any Test exercise. There is no down migration. Once report, notice, incident,
job, consent, or message history exists, hold the narrow flags, pause schedules,
preserve evidence, and prefer a compatible forward repair. Dropping or rewriting
history requires a separately approved exact affected-row review.

Before any destructive database test, parse the exact connection target and
require a loopback host, a database name containing `test`, and a non-Preview/
non-Production context. Do not fall back to the developer database. Print only
sanitized host/database identity and abort on any uncertainty.

### Production migration procedure

The protected
[`Production Prisma Migration`](../.github/workflows/production-migrate.yml)
GitHub Actions workflow is the repository's supported Production migration
path.

1. Confirm the selected Git ref contains exactly the reviewed migration set.
2. Confirm the GitHub `production` Environment approvals and the
   `PRODUCTION_DIRECT_DATABASE_URL` secret are controlled by the Production
   operators.
3. Verify the target database identity independently. The workflow rejects an
   empty URL and some obvious local/test URL strings, but that is not proof that
   the target is the intended Production database.
4. Take or verify a current recoverable backup according to the operator-owned
   backup procedure. Record its identifier without exposing credentials.
5. Independently review `pnpm prisma migrate status` against the approved direct
   target. The workflow's status step is `continue-on-error`, so it is diagnostic
   output, not a blocking safety gate.
6. Review migration/application compatibility and the required database-first,
   application-first, or staged order for this change.
7. Manually dispatch the workflow and enter its required confirmation phrase.
8. Watch the install, URL guard, status, and `pnpm prisma migrate deploy` steps.
   Stop the release if any output is unexpected.
9. Recheck migration status, database invariants, and application compatibility
   before enabling traffic or release flags.

Do not seed Production. Do not run the workflow merely to discover which
database its secret targets.

## Application deployment

The repository contains CI and a manual database-migration workflow, but it does
not encode the Vercel project, Production branch, domain-promotion policy, or a
complete Production deployment workflow. The operator must confirm the approved
Vercel Git or CLI path before release. See Vercel's official
[Git deployment](https://vercel.com/docs/git) and
[deployment overview](https://vercel.com/docs/deployments/overview).

### Normal release

The 2026-09-05 onboarding hardening retires organization-only POST creation and
requires `WORKSPACE_BRANCH_BILLING_V2_ENABLED` for new onboarding. With the flag
held, new creation is unavailable; existing legacy access remains supported.
Before releasing, verify the intended flag state through the approved operator
process. No flag or deployment change was performed by the local sprint.

1. Identify the approved commit and classify schema, environment, cron,
   webhook, billing, and external-provider impact.
2. Require green targeted validation and CI for that commit.
3. Validate the Preview deployment with isolated Preview services. For a schema
   change, confirm the Preview migration from a clean state.
4. Confirm the operator-owned backup, monitoring, incident, and rollback
   preconditions that apply.
5. Execute the reviewed application-and-migration sequence. Depending on
   compatibility, that may be database-first, application-first, or a staged
   expand/backfill/compatible-code/contract rollout; do not substitute this
   numbered list for the change-specific order.
6. Deploy or promote only the exact approved artifacts using the
   operator-approved Vercel path.
7. Verify the deployment ID, commit, domains, environment scope, migration
   state, authenticated owner and restricted-staff flows, tenant isolation, and
   affected business behavior.
8. Check runtime logs and operator-owned alerts for the observation window.
9. Enable billing or other release flags only in separately observed
   deployments when the change-specific runbook requires staged gates.

Do not treat a successful build or domain assignment as a successful release.

## WhatsApp managed Utility-delivery, reports, and operations rollout

> **Held capability, not live readiness:** the repository can create Lab
> Lords-managed Utility templates and submit one approved Utility template to an
> explicitly authorized recipient. It can also create deterministic aggregate
> reports and typed operational notices through that same outbox. All provider,
> planner, report, notice, health, and operations controls default
> false, and no real provider, Preview, Production, migration, legal, rate-card,
> or canary evidence was produced by implementation. Do not describe repository
> capability or sender readiness as a launched customer service.

The foundation architecture proposal is
[`0002-whatsapp-communication-foundation.md`](./decisions/0002-whatsapp-communication-foundation.md),
the Accepted delivery decision is
[`0003-whatsapp-template-delivery-and-collections.md`](./decisions/0003-whatsapp-template-delivery-and-collections.md).
The foundation remains **Proposed** and ADRs 0003 and 0004 are **Accepted** by
the recorded human owner. The PR4 reports/operations decision is
[`0004-whatsapp-daily-reports-and-operational-hardening.md`](./decisions/0004-whatsapp-daily-reports-and-operational-hardening.md)
and was accepted on 2026-08-27 together with the `SECURITY.md` policy changes.
That approval, repository code, tests, or a successful migration approve neither
a Meta connection nor billable delivery, deployment, or rollout.

No real Meta App Review, Embedded Signup, WABA, template creation/approval,
phone registration, message send, signed webhook delivery, report confirmation,
STOP, customer asset, health read, rate-card approval, Preview/Production setup,
deployment, or Production migration was performed. Obtain external evidence in
the approved private operations record; never infer it from local environment
files or provider IDs in fixtures.

### External prerequisites and ownership

Before configuring even a Test deployment, record and verify all of the
following without copying secret values:

1. The customer owns the WABA, phone, Meta business identity, provider payment
   method, and message charges. Lab Lords receives delegated access only; no Lab
   Lords credit line or extended credit may be shared or assigned.
2. An accountable owner controls the Meta developer app and Business Portfolio,
   Business verification is complete where required, and the WhatsApp product
   is added to the app.
3. One server-controlled Embedded Signup configuration ID is approved. The
   fixed browser contract passes that ID with `sessionInfoVersion: "3"`; there
   is no customer selector. The browser may not choose app ID, Graph version,
   configuration ID, session-info version, feature type, coexistence, calling,
   Marketing Messages Lite, credit sharing, or any other provider mode.
   WhatsApp Business App coexistence is not supported or promised by this
   release. Reverify that exact configuration and session-info version against
   current official Meta requirements before external setup.
4. Reverify current official Meta documentation on the rollout date. The
   2026-08-24 implementation review pins `META_GRAPH_API_VERSION=v25.0`; `latest`
   and every other version fail closed. Controlled template creation is exactly
   `POST /{WABA_ID}/message_templates` with
   `whatsapp_business_management`. Individual template delivery is exactly
   `POST /{PHONE_NUMBER_ID}/messages` with
   `whatsapp_business_messaging`, `messaging_product=whatsapp`,
   `recipient_type=individual`, and `type=template`; a local acceptance requires
   exactly one bounded `wamid`. See Meta's official
   [message API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api),
   [template API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api), and
   [permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/permissions).
5. App Review and Advanced Access for both WhatsApp permissions are approved for
   multi-tenant customer use. `business_management` is optional and must be
   requested only if separately approved portfolio operations actually require
   it. The configured Lab Lords system user must be the reviewed identity and
   receive only the minimum WABA task required by the code (`MANAGE`).
6. Dedicated Test app/configuration, Test WABA, and Test phone exist for Preview
   validation. Production must use isolated Live assets and credentials and
   must never receive a Test or customer token from another environment.
7. Stable HTTPS Preview and Production callback hosts, allowed OAuth/JavaScript
   SDK domains, and any narrowly scoped Vercel Deployment Protection exception
   are approved. Do not weaken authentication for unrelated routes.
8. The Meta callback is exactly the reviewed public route
   `/api/whatsapp/webhook`; the private verification token and app secret are
   configured server-side. Do not configure an arbitrary customer-specific
   callback override.
9. Only official language codes `en_IN` and `hi` are configured. There is no
   `hi_IN` or Hinglish provider language. Creation hardcodes category `UTILITY`;
   approval and category remain provider-authoritative. Reverify the official
   [supported languages](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages)
   and template policy before any catalogue change.
10. Signed status handling is limited to bounded current `sent`, `delivered`,
    `read`, and `failed` events, inbound text/button events needed for exact
    STOP, and template status/category events. Meta pricing status metadata may
    include `billable`, `category`, `pricing_model`, or `type`, but supplies no
    exact charged amount; `actualCostMicros` must remain null. Do not claim the
    configured estimate is a provider invoice. Reverify Meta's official
    [pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing),
    [status webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status), and
    [error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes).
    Graph codes `4`, `80007`, `80008`, `130429`, and `131056` are rate-limit
    signals; any
    retry remains bounded and lease-fenced. Because Meta supplies no send
    idempotency key, timeout/network/`5xx`/invalid-success ambiguity becomes
    `UNKNOWN` and is never retried automatically.
    A successfully claimed signed receipt also deletes at most 100 unattached
    message events whose seven-day deadline has passed, scoped to the exact
    senders resolved from that receipt. Monitor overdue orphan counts by sender;
    cleanup is intentionally opportunistic and a sender with no later valid
    webhook traffic can retain an overdue row until the next signed receipt.
11. Incident ownership, token-rotation and app-secret-rotation ownership,
   webhook/provider health monitoring, log retention, outage handling, and
    customer support/escalation include a human queue for `UNKNOWN` messages and
    are documented outside the repository gaps noted in `SECURITY.md`.
12. A named owner signs off the versioned effective and expiring rate card, its
    update cadence, and alert threshold. V1 estimates only `+91` India
    recipients; an unsupported destination must fail closed rather than use a
    guessed rate. Queueing, planning, and dispatch fail closed at expiry.
13. Separate human legal/privacy review approves the exact versioned operational
    consent wording, privacy-policy disclosure, Meta data processing/retention,
    opt-out behavior, customer-owned billing explanation, Utility template
    wording/category, support process, and incident notice obligations. Codex and
    repository tests do not establish legal compliance. Existing consent remains
    unknown and no customer/student is opted in by either migration.

### Mode and release controls

`META_WHATSAPP_MODE` is mandatory and may be only `TEST` or `LIVE`. Local
Development and Vercel Preview fail closed unless it is `TEST`; Vercel
Production fails closed unless it is `LIVE`. Tests must inject the fake client.
Provider mode is stored with sender and receipt identity; never infer it from
an ID or copy a row between modes.

All controls are false when absent and require a redeployment to change:

```text
WHATSAPP_INTEGRATION_ENABLED=false
  hides/blocks the integration and prevents ordinary WhatsApp table/provider use

WHATSAPP_META_ONBOARDING_WRITES_ENABLED=false
  blocks new provider onboarding, registration, and other onboarding mutations

WHATSAPP_META_TEMPLATE_WRITES_ENABLED=false
  blocks controlled creation of managed Utility templates; does not block reads

WHATSAPP_META_MESSAGE_WRITES_ENABLED=false
  prevents every new provider message request while preserving queue/budget/history

WHATSAPP_AUTOMATION_PLANNER_ENABLED=false
  prevents automatic collection queue planning; does not authorize provider delivery

WHATSAPP_REPORTS_ENABLED=false
  blocks report subscription, preview, snapshot, queue, and report dispatch paths

WHATSAPP_REPORT_PLANNER_ENABLED=false
  prevents automatic report queue planning; does not authorize provider delivery

WHATSAPP_SERVICE_NOTICES_ENABLED=false
  blocks service-notice preview, queue, and dispatch paths

WHATSAPP_HEALTH_RECONCILIATION_ENABLED=false
  blocks read-only provider-health cron work; it does not authorize writes

WHATSAPP_OPERATIONS_UI_ENABLED=false
  hides the server-projected incident/safety/job operations surfaces only

WHATSAPP_WEBHOOK_INGEST_ENABLED=false
  independently blocks verification/receipt ingestion and WABA subscription work

WHATSAPP_LIVE_CANARY_ORG_IDS=<exact reviewed IDs only>
  additionally restricts enabled onboarding writes to exact valid IDs in LIVE
  Vercel Production; an empty or malformed list permits nobody

WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS=<exact reviewed IDs only>
  separately restricts template and message writes in LIVE; empty/malformed permits nobody

WHATSAPP_LIVE_AUTOMATION_CANARY_ORG_IDS=<exact reviewed IDs only>
  combines with the delivery canary for automatic collection/report work in LIVE;
  empty/malformed permits nobody

WHATSAPP_HEALTH_CANARY_ORG_IDS=<exact reviewed IDs only>
  separately restricts read-only provider health work in LIVE; empty/malformed permits nobody
```

The integration flag is a prerequisite for every WhatsApp path. Onboarding,
template creation, message delivery, collection/report planning, reports,
service notices, provider-health reconciliation, operations UI, and webhook
ingestion are independent gates. LIVE onboarding uses only the onboarding
canary; template/manual message writes use the delivery canary; automatic
collection/report work requires the exact organization in both delivery and
automation canaries; health reads use the health canary. Template creation does
not authorize a message; planning does not authorize dispatch; disabling a
planner does not disable already queued manual work; disabling message writes
must make no new provider message call while leaving queue, status/history,
reserved budget, students, payments, snapshots, notices, incidents, and jobs
unchanged.

Changing a flag requires a new deployment and does not cancel an in-flight
provider request. Disabling any flag must not delete sender, mapping, consent,
template/binding, message/event, receipt, audit, budget, or provider-ID evidence.
To contain the whole integration, deploy the integration flag false, clear every
canary list, and separately pause the WhatsApp cron schedules; do not use a
credential rotation as a routine kill switch.

The branch-local controls have different scopes. Delivery disable atomically
cancels every safely unsubmitted manual and automatic branch message, releases
`RESERVED` budget, and preserves rows plus accepted/ambiguous history; therefore
an old manual batch cannot resume after re-enable. Automation-only disable
cancels safely unsubmitted automatic rows only and leaves manual rows governed by
the delivery/message-write controls.

Every provider mutation uses a short local claim/validation transaction, commits
it, uses a final short admission transaction to check both full/requested pause
state and stamp the exact leased message, performs the bounded Meta request only
after that commit, and then finalizes under the same lease in a new short
transaction. A local pause request blocks new admissions immediately, reports a
draining state while an earlier admitted request settles, and records full pause
only after no admitted `SUBMITTING` row remains. Never call Meta while a student, payment, consent,
recipient, settings, outbox, frequency, or budget transaction is open. On an
ambiguous message response, do not repeat the request: preserve `UNKNOWN`, the
provider correlation evidence already stored, and committed estimated budget for
operator review.

### Database-first hold, migration, and safe enable order

Use this order for the reviewed expansion. Do not collapse separately observed
steps or turn the later operations into an automatic pipeline.

1. Complete draft review and require green CI for the exact commit.
2. Confirm the recorded human-owner approval of the `SECURITY.md` policy diff.
3. Confirm ADRs 0003 and 0004 are recorded as Accepted and ADR 0002 remains
   Proposed; none of those statuses authorizes deployment or rollout.
4. Confirm no real provider credentials, WABA, template, message, report,
   notice, or health operation was used by development or automated tests.
5. While the previously compatible application is still serving, ensure
   integration, onboarding, template writes, message writes, both planners,
   reports, notices, health, operations UI, and webhook ingestion are false and
   every Live/health canary is empty. Pause the dispatcher schedule through the
   approved Vercel control, verify the schedule state, and allow the last worker
   and lease to drain. If PR2
   integration is enabled, first deploy/configure the complete hold without the
   PR3 application artifact.
6. Run the read-only Production migration preflight above and record exact
   counts/metadata privately.
7. Enter the approved deployment/traffic hold. Stop new deployments and hold
   student creation/update, imports, and other schema-dependent mutations until
   migration verification completes; follow the repository incident procedure
   if the hold cannot be established. Re-run the read-only WhatsApp in-flight
   query immediately before migration and require exactly zero; do not continue
   while any active `CLAIMED` lease or `SUBMITTING` row remains.
8. Apply the protected pending additive PR3 and PR4 Prisma migrations through
   the approved Production workflow before promoting the new application.
9. Repeat both migration baselines while traffic remains held; verify all
   existing students are `LEGACY`, every new PR3/PR4 table is empty, automation
   timestamps/rules are absent, no report is enabled, no subscription is active,
   no sender is unexpectedly paused, delivery stays disabled, existing template
   hashes/bindings and provider IDs are unchanged, payment constraints/history
   remain intact, and migration status is clean.
10. Promote the exact reviewed application commit only after step 9 passes,
    release the traffic hold, then verify ordinary Production sign-in,
    owner/staff, branch, student, payment, billing, import, and AI review flows;
    also verify flag-off routes do not claim work, create a message, or call
    Meta.
11. Keep every template/message/planner/report/notice/health/operations control
    false and every Live/health canary empty.
12. Configure an isolated Meta Test environment only after callback, monitoring,
    `UNKNOWN` review, rate-card, security, and legal/privacy prerequisites exist.
13. Validate managed-template installation in TEST, wait for provider approval,
    sync provider truth, and require every used binding to be `APPROVED` and
    `UTILITY` with the exact catalogue hash.
14. Create one founder-controlled synthetic student/guardian mapping with
    explicit versioned operational consent. Do not bulk-opt-in or use customer
    data for the first exercise.
15. With planning still false, enable delivery for that Test branch and validate
    one reviewed manual preview/queue/dispatch. Confirm one `wamid`, one committed
    estimate, and no duplicate on request replay.
16. Validate provider-signed sent, delivered, read, and definite-failed events,
    out-of-order non-regression, exact STOP/button opt-out, and future
    unsubmitted-message cancellation without retaining raw body/text.
17. In isolated Test data, confirm one self-subscription with the signed exact
    challenge, one aggregate report, scoped `STOP REPORTS`, one typed notice,
    notice cancellation, and full `STOP`; prove no names/phones/raw commands or
    attendance claims enter snapshots, incidents, jobs, or logs.
18. Exercise fake ambiguous outcomes and a stale submitting lease; require
    terminal `UNKNOWN`, committed budget, sender threshold containment, a
    deduplicated incident, no automatic retry, and later signed-status
    reconciliation without resend.
19. Exercise read-only health and maintenance with an injected provider. Prove
    no provider mutation occurs, unhealthy reads preserve prior truth, job
    evidence is integer-only, and retention never deletes submitted/consent/
    audit history.
20. Hold message/template writes again and review costs, rate limits, failures,
    opt-outs, receipts, queue depth, privacy, and operational evidence.
21. Request separate Live authorization only after App Review/Advanced Access,
    customer-owned billing, stable callback, monitoring, support, legal/privacy,
    and rate-card signoff are proven.
22. Add exactly one approved organization to the delivery Live canary; keep
    onboarding, automation, and health canaries separate and empty. Start with
    managed-template install/sync and manual sending only.
23. Observe the approved canary window for cost estimates, provider Dashboard
    state, `UNKNOWN`, failures, throttling, opt-outs, duplicate protection, and
    tenant-safe history.
24. Add that organization to the automation canary and enable one planner only
    after the manual Live canary passes. Confirm automation is prospective and
    no historical welcome, due, confirmation, or report blast occurs. Enable
    reports/notices/health one at a time in separately observed deployments.
25. Expand organizations/branches gradually through explicit approvals. Never
    enable by wildcard, public pricing launch, or broad historical catch-up.

Do not allow Vercel to promote this commit before the protected migration has
completed and been verified. WhatsApp kill switches prevent provider and PR3
workflow writes; they do not make ordinary Prisma student queries compatible
with a schema that lacks `Student.enrollmentSource`.

### Separately approved Test onboarding procedure

This is a future procedure, not evidence that setup has occurred:

1. Prove Preview uses an isolated database, Clerk development instance, stable
   HTTPS host, and only dedicated Meta Test assets. Verify all nine Meta
   configuration names are present by name without printing their values, that
   mode is `TEST`, and that Graph version/configuration match the reviewed app.
2. Deploy with integration enabled but onboarding writes and webhook ingest
   held. Confirm ordinary settings render, Basic/nonowner/read-only users remain
   denied safely, browser JSON contains no secret/system token, and no provider
   call occurs.
3. Configure and verify the public callback as described below. Enable webhook
   ingestion in a new observed deployment only after signature/receipt
   monitoring is ready.
4. In a separate observed deployment enable onboarding writes for the Test
   exercise. Use an entitled, writable organization owner. The intent must be
   one-time, approximately ten minutes, and only its hash may appear in the
   database.
5. Complete one mocked-first and then separately approved real Test Embedded
   Signup. Confirm the server verifies app/scopes, authorized WABA, phone
   membership, Test mode, system-user task, and subscribed app before sender
   finalization. Browser IDs alone are not evidence.
6. If provider truth says registration is required, use the owner-only six-ASCII-
   digit action. Never capture the PIN in logs, screenshots, tickets, browser
   persistence, or the database. Confirm a provider refetch proves registration.
7. With template writes still held, run provider-authoritative synchronization
   and confirm only bounded normalized metadata is stored. In a separate approved
   Test deployment enable template writes, install only the code-defined `en_IN`
   and/or `hi` Utility catalogue, then hold writes. Query provider truth until the
   exact catalogue bindings are `APPROVED` and `UTILITY`; rejected, pending,
   marketing, paused, disabled, stale, hash-mismatched, or `UNKNOWN` templates
   are not sendable.
8. Verify branch assignment is same-organization and leaves delivery/automation
   disabled. Record one synthetic explicit operational consent and mapping, set
   an owner-approved estimate budget, enable delivery only, and keep planning
   false. Preview and queue one manual request; confirm queueing creates no Meta
   request and the dispatcher is the only message caller.
9. Enable message writes in a separate observed Test deployment, invoke the
   protected dispatcher manually once, and verify exactly one provider `wamid`,
   committed budget, status webhooks, duplicate safety, and exact STOP. Exercise
   ambiguity only with a fake provider and require `UNKNOWN`/no retry.
10. Hold onboarding/template/message/planner writes again and redeploy after the
    exercise. Retain safe audit/receipt/message evidence; do not delete outbox,
    consent, `UNKNOWN`, or customer/provider assets to simulate rollback.

### Meta webhook setup and health

1. Confirm the stable HTTPS host reaches GET and POST
   `/api/whatsapp/webhook` without Clerk or broad Deployment Protection while
   all unrelated routes retain their normal protection.
2. Configure the private verification token in Meta and the deployment. The GET
   challenge returns plain text only for exact mode/token/challenge input;
   never log the token or include it in retained evidence.
3. Configure the reviewed WhatsApp event subscriptions on the Meta app. Let the
   connection flow query the WABA subscribed-app state and add this app only
   when missing; do not remove other apps or replace a customer callback.
4. With the ingest flag enabled, deliver a provider-signed Test envelope. POST
   accepts at most 512 KiB, verifies `x-hub-signature-256` over exact raw bytes
   before JSON parsing, and persists bounded mode/hash/asset/event metadata
   before `2xx`. It stores neither raw body nor message text.
5. Replay the exact signed bytes and require harmless duplicate success with no
   duplicate side effect. Deliver a correctly signed unknown WABA/phone and
   require a generic ignored receipt without tenant disclosure.
6. Deliver bounded signed `sent`, `delivered`, `read`, and `failed` examples,
   including duplicate, out-of-order, and status-before-API-finalization cases.
   Require one deduplicated append-only event per provider identity and a
   non-regressing projection. Optional `billable`/category/pricing metadata may
   be recorded when authoritative, but `actualCostMicros` stays null.
7. Deliver normalized text exactly `STOP`, exact `STOP REPORTS`, an exact valid
   `START REPORTS <code>`, the managed `Stop reports` label/payload, the existing
   `LABLORDS_STOP_UPDATES` payload, near misses, duplicate commands, bare `START`,
   and `PAID`. Full STOP keeps broad operational opt-out behavior; report STOP
   affects only report consent/subscriptions; only a live unexpired challenge
   for that sender and phone may confirm. In one envelope, deliver an expired
   confirmation followed by a valid confirmation from the same phone with
   distinct provider message IDs; require both to be processed in order. Replay
   one provider message ID and require only that identity to deduplicate. No raw
   body/text/code/error is stored, no reply is sent, and no payment changes.
8. Alert on verification/signature failures, receipt persistence/lease failures,
   backlog, provider outage/rate limiting, template reclassification, failed and
   `UNKNOWN` messages, loss of callback reachability, budget threshold, and
   opt-out anomalies. The repository defines tenant-scoped incidents and a
   human `UNKNOWN` queue, but no central alert-delivery sink or proven response
   process; those remain blockers before Live enablement.

Do not enable a real customer Production webhook or delivery canary as part of
repository implementation. Both require the separate approvals above.

### PR4 report, notice, safety, and health operations

- Confirm every report recipient through signed inbound proof before activation.
  Use synthetic Test recipients first. Plaintext challenge codes are one-time
  display data: do not screenshot, log, ticket, or persist them. Verify expiry,
  five-attempt lockout, reissue invalidation, scoped opt-out, full opt-out, staff
  removal/permission-loss, owner/phone change, sender reassignment, and sender
  disconnect reconciliation.
- Review report preview/snapshot JSON for aggregate-only content, the exact
  local scheduled cutoff, and canonical UTC `metricsAsOfAt`. Prove payments,
  active students, dues/overdue, capacity/allocation, and WhatsApp outcomes use
  that one transaction-snapshot instant and the rendered local as-of label
  matches it. Capacity is shift-slot usage, not attendance. Inspect one branch
  and one consolidated owner report, then prove the latter uses only its
  separate organization report budget.
- Create two synthetic subscriptions in one scope at the same cutoff and one at
  a different cutoff. Require the first pair to share one immutable snapshot and
  the third to create a distinct snapshot. Verify the unique identity, source
  fingerprint, and message dedupe all include `scheduledCutoffAt`; never edit or
  repurpose an earlier snapshot to satisfy a later schedule.
- Exercise the exclusive trust-window boundaries. The end is the earlier of one
  hour after cutoff or next local midnight. At/after that instant, or whenever
  canonical metrics cannot be proven, require a safe `REPORT_FAILURE` incident,
  no new reservation/provider call, and planner skip or dispatcher suppression.
- Service notices may be only closure, hours-changed, or maintenance contracts.
  Verify the fixed reason, typed time/date, managed template hash/category,
  unique consented audience, 500-recipient rejection, explicit estimate
  confirmation, 30-day horizon, full reservation, idempotent replay, partial
  cancellation, STOP reconciliation, and completion state before rollout.
- Review the rate-card state before queueing and again before dispatch. `VALID`
  and `EXPIRING` are estimates only; `NOT_YET_EFFECTIVE` and `EXPIRED` hold new
  reservations/submissions. Rotate to a reviewed new version before expiry in a
  new deployment; never edit historical message estimate snapshots.
- Inspect sender safety and active incidents before each canary expansion. Three
  ambiguous outcomes or ten reviewed sender/provider failures within ten minutes
  closes the local admission gate. Invalid individual destinations are excluded.
  A pending pause means new calls are blocked while an earlier durable admission
  drains; full pause is recorded after the drain. Pause makes no provider
  mutation. Resume is owner-only, explicitly confirmed, and requires a
  current rate card, active unrestricted sender, recent successful unrestricted
  health read, exact healthy bindings for current queued work, healthy templates
  for enabled automation/report configuration, and no critical blocker. Prove
  an unused rejected optional template and an unused language do not block
  resume, while a queued message with that exact rejected binding remains
  blocked. Resume never retries `UNKNOWN`.
- Acknowledge only to record awareness. Resolve only through verified local/
  signed/provider evidence. Do not edit an incident or message to make a queue
  look healthy. Later signed delivery/failure for `UNKNOWN` may project and
  resolve without resending the original request.
- Health reconciliation is a read-only provider boundary. Review traces/tests
  to prove it only reads WABA, phone/registration/quality/restriction,
  subscribed-app, and template status/category. It must never register,
  subscribe, create, send, remove, share credit, or erase prior truth after an
  ambiguous read. Start with one Test health canary.
- Webhook-stale alerting needs recent provider activity; sender silence by itself
  is not degradation. Compare last accepted/provider activity, valid signed
  known-sender receipt time, and the approved threshold before declaring an
  incident.
- Each report, health, and maintenance cron run persists bounded integer-only
  evidence. Inspect status/counts/errors and absence of IDs, phones, names,
  amounts, rendered content, and secrets. Maintenance may expire/recover/delete
  only the reviewed safe classes and limits; accepted messages plus consent and
  audit history are permanent operational evidence.
- Keep operations UI disabled until its server projections and authorization are
  approved. UI hiding is not a security control; inspect the corresponding API
  denial for foreign, unentitled, read-only, and insufficient-permission users.

### Credential rotation, provider outage, and disconnect

- Environment changes require a new deployment. Rotate the system-user token
  at Meta/secret manager, deploy the replacement, prove bounded provider reads
  and assignment/subscription state, then revoke the old token. Never store a
  customer token to bridge a rotation.
- App-secret rotation changes both server API authentication and webhook HMAC.
  The current WhatsApp handler has no old-secret overlap list, so plan a
  provider-coordinated cutover and observation window; do not invalidate the
  old secret until the new deployment and Meta configuration are ready. Verify
  a signed Test delivery after cutover without retaining raw bytes.
- Rotating the webhook verification token requires updating the server secret,
  redeploying, and completing Meta's callback verification in an approved
  sequence. It does not authenticate POST deliveries; the app-secret HMAC does.
- During a Meta outage, hold onboarding, template, and message writes and the
  planner in a new deployment; separately pause the WhatsApp schedules and
  preserve sender/intents/provisioning/outbox/budget/audit state. Keep signed
  webhook ingestion active unless it is itself harmful; if disabled, track
  provider retries/backlog. Never blindly retry an ambiguous system-user
  assignment, WABA subscription, phone registration, template creation, or
  message send. Refetch provider truth where a read can prove it; message
  acceptance that cannot be proven remains `UNKNOWN` for human review.
- A local Lab Lords disconnect is not a provider disconnect. It marks the
  sender `DISCONNECTED`, unassigns branches, and preserves history. It does not
  deregister the phone, unsubscribe the WABA, remove a system user, delete a
  WABA/template, revoke the customer's number, or alter Meta billing. Any
  destructive provider action needs a separate operator/customer decision.

## Import Assistance V2 rollout

The repository pins `workflow` 4.6.0 and implements opaque-ID Workflow
orchestration over an application-visible PostgreSQL ledger. The architecture
proposal is
[`0001-managed-workflow-for-import-execution.md`](./decisions/0001-managed-workflow-for-import-execution.md),
whose status remains **Proposed**. Code presence, a green build, or a deployed
migration does not approve Production execution. A human owner must explicitly
approve the decision and the security/data-residency review before enabling the
feature.

The PostgreSQL ledger—not Workflow state—is business truth for branch scope,
requesting user, target revision, immutable plan hash, deterministic item keys,
leases, retries, cancellation, progress, and redacted outcomes. Workflow inputs
and step outputs contain opaque run IDs and bounded counters only. A step may
claim at most 25 items; each item rechecks current authorization, entitlement,
branch writability, object scope, plan revision, and lease inside the same short
transaction as the domain mutation and completion marker. No import mode is a
whole-file transaction, and cleanup is not rollback.

### Required evidence before enabling

1. Keep `IMPORT_V2_ENABLED=false` or absent. Apply the additive V2 migration
   through the normal reviewed migration path and confirm old application code
   remains compatible. Verify unfinished V1 sessions are archived and receive
   the migration's 30-day purge deadline; do not rewrite terminal V1 history.
2. In an isolated Preview environment, verify `workflow` 4.6.0, the Next.js
   Workflow build integration, provider-authenticated internal endpoint, Fluid
   Compute/runtime configuration, deployment pinning, retry/resume behavior,
   provider operator access, and actual orchestration-data retention/region.
   The Proposed ADR records `iad1` for stable Workflow v4, but the operator must
   verify current provider truth instead of relying on that statement.
3. Complete and approve the personal-data review. Prove Workflow receives only
   opaque IDs/revisions/hashes/cursors/counts while source rows, personal
   values, branch configuration, and complete mutation payloads remain in the
   authorized PostgreSQL ledger. Use synthetic data for all acceptance and
   benchmark work.
4. Benchmark representative 100-, 500-, and 2,000-row imports, including the
   highest-fan-out approved goal and configuration/allocation/payment cases.
   Record row count, deterministic mutation-item count, analysis duration,
   completion duration, retries, database/runtime usage, and observed
   percentiles. Derive separate owner-approved analysis and completion SLOs;
   do not invent thresholds in configuration or this runbook.
   `pnpm benchmark:import-v2` provides a reproducible synthetic parser and
   immutable-plan expansion baseline. Its output is explicitly compile-only;
   it cannot substitute for staging-equivalent durable execution evidence.
5. Derive `IMPORT_MAX_PLANNED_MUTATIONS` from measured item counts, not the row
   cap. Demonstrate the approved largest workload with at least a further
   two-times passing headroom, record the evidence and owner, then set the
   positive integer cap. A missing/invalid cap or a plan above it must fail
   closed before a run is created.
6. Exercise authentication revocation, tenant/branch mismatch, permission and
   writability changes between items, stale revisions, duplicate idempotency
   keys with same and different request hashes, duplicate Workflow delivery,
   lease expiry, transient retry, permanent failure, cancellation, browser
   resume, provider-terminal attached-run replacement, repair through a new
   revision, and both readiness policies. Use an independently verified
   disposable PostgreSQL target for real V2 mutation-plus-marker and replay
   tests. Confirm already completed items are not duplicated or described as
   rolled back.
   For a deliberately isolated local database, the integration bootstrap may
   use `TEST_DATABASE_URL` only when `TEST_DATABASE_RESET_CONFIRM` exactly
   matches the URL's database name. This opt-in does not remove the operator's
   responsibility to prove the target is disposable before the truncating test
   starts.
7. Exercise the 4.25 MiB request, 4 MiB source, 2,000-row, 64-column, 8 KiB-cell,
   and 32 MiB expanded-workbook limits; signature/encoding failures; malformed
   CSV quotes; duplicate/blank headers; multi-sheet/header selection; PDF beta
   warnings; AI prompt redaction; and recipe write/read redaction.
8. Verify terminal and inactive-draft transitions set `purgeAfter` 30 days out.
   Invoke `/api/cron/imports/daily` with the Preview-only secret; verify bounded
   counts, duplicate delivery, expired waiting/queued/retryable-run
   terminalization, running-lease concurrency, consistent final counters,
   payload/error scrubbing, staging deletion, and retained redacted run history.
   Establish monitoring for overdue staging rather than assuming the declared
   schedule executed.
9. Require green targeted tests, `pnpm test:workflow`, the broader affected
   suite, lint, build, and Preview smoke evidence. Record the approved rollback
   authority, observation window, alerts, and how active runs will be drained
   or cancelled.
10. Deploy the reviewed mutation cap while the flag is still held. Only after
    the evidence and human approvals above, create a separate observed
    deployment with `IMPORT_V2_ENABLED=true`. Verify one synthetic/restricted
    run and its ledger/Workflow/retention telemetry before wider use.

### Disable, rollback, and recovery

- To stop new V2 starts, set `IMPORT_V2_ENABLED=false` and create a new
  deployment. Changing the variable without redeployment does nothing, and the
  flag does not cancel an already-started Workflow run.
- Inspect durable PostgreSQL run/item state before choosing to drain or request
  cancellation. Do not delete Workflow state, run items, plans, idempotency
  keys, or success markers to simulate rollback.
- Workflow runs are deployment-pinned. Application Instant Rollback does not
  stop them, reverse committed domain mutations, reverse the additive schema,
  restore archived V1 drafts, or change the active retention schedule.
- Keep the additive migration in place and prefer a compatible forward fix.
  Before repointing traffic to older code, prove it tolerates the current schema
  and nullable retained run references.
- Disable the import-retention cron separately only when retention itself is
  harmful, then verify the Cron dashboard and track the staging backlog. A
  disabled purge is not a substitute for stopping Workflow execution.
- Recovery means reconciling plan/run/item counts and created entity IDs,
  repairing through a new revision/plan when appropriate, and preserving a
  truthful partial-result history. It does not mean file-wide rollback.

## Vercel Cron Jobs

[`vercel.json`](../vercel.json) defines eight HTTP `GET` schedules:

| Path | Schedule | UTC interpretation | Repository behavior |
| --- | --- | --- | --- |
| `/api/cron/payments/daily` | `0 0 * * *` | Daily at 00:00 UTC | Generates due payments for active students using duplicate-safe database writes |
| `/api/cron/billing/hourly` | `0 * * * *` | At minute 0 of every UTC hour | Processes billing deadlines, retries, cancellations/replacements, expired leases, and reconciliation |
| `/api/cron/imports/daily` | `30 0 * * *` | Daily at 00:30 UTC | Drains at most 20 batches of 100 expired staging sessions, terminalizing stale active ledger work before scrubbing retained run-item payloads/errors |
| `/api/cron/whatsapp/plan` | `*/15 * * * *` | Every 15 minutes | When enabled, claims at most 25 eligible branch leases and creates bounded deterministic automatic outbox/budget reservations only; when planner/integration is held, returns before collection-table or provider work |
| `/api/cron/whatsapp/send` | `*/5 * * * *` | Every 5 minutes | When message writes are enabled, leases a bounded fair outbox batch, performs full send-time revalidation, and is the only automatic Meta message caller; when held, returns before table/provider work |
| `/api/cron/whatsapp/reports` | `*/15 * * * *` | Every 15 minutes | When independently enabled, creates bounded snapshot-first branch/organization report reservations with tenant/source/canary checks; never calls Meta |
| `/api/cron/whatsapp/health` | `*/30 * * * *` | Every 30 minutes | When independently enabled/canaried, reconciles a bounded sender batch using provider reads only and records safety/incident/job evidence |
| `/api/cron/whatsapp/maintenance` | `0 2 * * *` | Daily at 02:00 UTC | Performs bounded local challenge/subscription/lease/notice/stuck-work/job/snapshot maintenance; never calls Meta or deletes submitted/consent/audit history |

Vercel cron expressions always use UTC and scheduled invocations run only for
Production deployments. Vercel does not automatically retry a failed cron and
may duplicate, miss, or overlap an invocation, so database idempotency/leases
remain authoritative. Updating, deleting, or adding a schedule requires a
redeployment. Confirm the selected plan supports the frequencies: current
official limits allow only daily cron on Hobby and down to once per minute on
Pro/Enterprise, with at most 100 jobs per project. See the official
[Cron Jobs](https://vercel.com/docs/cron-jobs),
[Cron quickstart](https://vercel.com/docs/cron-jobs/quickstart), and
[Cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
documentation.

All eight routes fail closed unless the request carries the exact `CRON_SECRET`
as a Bearer authorization header. Never place the secret in a URL, screenshot,
ticket, shell history, or report. Use an approved client that can set a private
header when manually testing a protected route.

Operational expectations:

- Vercel may deliver a scheduled event more than once or overlap executions.
  The application has duplicate-safe payment creation, durable billing
  idempotency/leases, locked import retention, one-branch planner leases with
  stable business-event dedupe, report/health leases, job-run evidence, and
  message dispatcher leases with stale-worker fencing. Operators must still
  inspect errors, runtimes, queue depth, overdue staging, rate limits, failed
  messages, incidents, safety state, webhook health, and every `UNKNOWN` outcome.
- Preview schedules do not run automatically. First invoke each protected
  WhatsApp Preview endpoint manually with its controlling flag false and require
  an authenticated `2xx` held/zero result with no PR4 table/provider work. Later
  Test-only invocations follow the approved rollout: planner remains false for
  the first manual send; when separately enabled, invoke plan once, inspect the
  isolated outbox/budget, then invoke send once. Never point Preview at
  Production data or Live Meta assets.
- The payment and import daily responses report processing counts. Import
  retention reports batches, selected sessions, scrubbed run items, purged
  sessions, the exact remaining backlog, and whether the 20-batch ceiling was
  reached. The hourly response reports deadline, retry,
  replacement, and reconciliation counts plus errors. WhatsApp planner reports
  held/claimed/completed/failed branches, planned/skipped/cancelled messages, and
  its limit; dispatcher reports held/claimed/accepted/retried/failed/unknown/
  suppressed messages and remaining backlog. Report/health/maintenance responses
  and durable job evidence contain only bounded integer counts plus safe status/
  error codes. Retain only non-sensitive aggregate summaries for the release
  record.
- A `401` indicates missing or mismatched `CRON_SECRET`. A `404` indicates a
  route/deployment mismatch. A `5xx` requires log and state inspection before a
  retry.
- Rerunning either daily job is designed to be idempotent. Import retention
  automatically drains its bounded 20-by-100 window; if `limitReached` is true,
  inspect runtime/database health and the reported `remainingBacklog` before an
  approved manual rerun. A `5xx` means the invocation failed closed and must be
  investigated before retry. For hourly billing,
  retry only after checking durable operation state; ambiguous/manual-review
  billing cases must not be forced through automatically. A
  `retriedReplacementCancellations` count represents provider reads that reconcile
  candidate cleanup; it must never represent another cancellation submission.
- A planner rerun reclaims only an expired branch lease and uses stable business-
  event dedupe; a branch failure must not block later branches. Inspect
  `lastPlannerErrorCode`, queue/budget counts, and configuration revision before
  a manual rerun. A dispatcher rerun may reclaim a stale claim or a stale
  unadmitted `SUBMITTING` row. Only a stale row with durable
  `providerCallAdmittedAt` evidence becomes `UNKNOWN`; never force or reset an
  admitted row to retry.
- To pause schedules, use the operator-approved Vercel Cron Jobs control and
  verify the dashboard state. Changing `CRON_SECRET` alone is not a clean pause.
- After an Instant Rollback, inspect the Cron Jobs dashboard explicitly. Do not
  assume application rollback, environment rollback, and active schedule state
  changed together.

## Razorpay webhook and billing rollout

The webhook endpoint is `POST /api/razorpay/webhook`. It requires a valid
Razorpay signature over the exact bounded raw bytes before parsing. A numeric
`Content-Length` above 512 KiB is rejected before body access; streamed bodies
are cancelled at the first byte above the same limit and receive `413`. The
event ID and raw-byte payload hash provide durable duplicate detection: retrying
the same event and body is safe; reusing an event ID with a different body is a
`400` collision. A receipt claim commits before provider reconciliation. An
unexpired nonowner duplicate receives `2xx` with `processing: true` and performs
no provider work; expired claims are reclaimable. Only the exact claim token,
start time, lease deadline, and attempt number can finalize success or failure.
Failed owner processing remains retryable.

### Webhook receipt-claim migration

Migration `20260831120000_add_razorpay_webhook_claim` adds nullable
`processingToken`, `processingStartedAt`, and `processingLeaseUntil`, plus
`attemptCount` defaulting to zero and supporting indexes. It changes no receipt,
subscription, billing-change, invoice, student-payment, or provider state.

This is a database-first expansion, but the old and new webhook worker protocols
must not overlap. The old application ignores the new token fields and can
finalize by event ID/hash alone; schema compatibility is therefore not worker-
protocol compatibility. Before the migration/application cutover, establish an
operator-owned webhook-ingress hold that prevents new requests from reaching the
old deployment, record the hold time in UTC, and retain provider deliveries for
later replay/reconciliation. Do not use a client-side flag or a secret change as
the hold.

Back up the selected database, confirm the exact deployment target, and record
these pre-operation counts without printing payloads or connection values:

```sql
SELECT
  COUNT(*) AS receipt_count,
  COUNT(*) FILTER (WHERE "processedAt" IS NOT NULL) AS processed_count,
  COUNT(*) FILTER (WHERE "processedAt" IS NULL) AS unprocessed_count
FROM "RazorpayWebhookEvent";
```

Apply through the protected migration workflow, or use the approved target-bound
shell with `pnpm prisma migrate status`, `pnpm prisma migrate deploy`, and a
second `pnpm prisma migrate status`. Before promoting the new application,
verify the expansion and existing-row backfill:

```sql
SELECT "column_name", "is_nullable", "column_default"
FROM information_schema.columns
WHERE "table_schema" = 'public'
  AND "table_name" = 'RazorpayWebhookEvent'
  AND "column_name" IN (
    'processingToken',
    'processingStartedAt',
    'processingLeaseUntil',
    'attemptCount'
  )
ORDER BY "column_name";

SELECT
  COUNT(*) AS receipt_count,
  COUNT(*) FILTER (WHERE "processedAt" IS NOT NULL) AS processed_count,
  COUNT(*) FILTER (WHERE "processedAt" IS NULL) AS unprocessed_count,
  COUNT(*) FILTER (
    WHERE "attemptCount" <> 0
       OR "processingToken" IS NOT NULL
       OR "processingStartedAt" IS NOT NULL
       OR "processingLeaseUntil" IS NOT NULL
  ) AS unexpectedly_claimed_existing_count
FROM "RazorpayWebhookEvent";
```

With ingress held, the three receipt counts must equal the recorded pre-
operation counts and `unexpectedly_claimed_existing_count` must be zero. Stop on
any other result. Next, use the old deployment's runtime logs and request state
to prove that every webhook invocation started before the hold has terminated.
The new two-minute lease is not evidence that an old worker drained, because the
old code never owned that lease. If any old invocation is active or its outcome
is unknown, keep ingress held and stop the promotion.

Only after that proof may the new application be promoted. Verify its migration
status and one signed canary, then release the ingress hold and use Razorpay
delivery evidence plus provider-authoritative reconciliation to recover every
event emitted during the hold. The old application ignores the additive fields;
the new application requires them, so migration remains database-first even
though worker promotion is drain-gated.

For application rollback, re-establish the ingress hold, prove all new token-
owned webhook invocations have terminated (or let their leases expire and
reconcile them under the new protocol), and retain the columns and all receipt
evidence. Do not roll directly back to the unfenced worker while a new claim is
active. Do not down-migrate or clear claims to manufacture recovery; prefer a
compatible forward fix.

### Initial subscription-provisioning migration

The September 5 replacement-provisioning and source-cancellation changes reuse
these existing columns and the audit ledger; they add no billing migration.
For a later approved rollout, hold interactive billing writes and deadline work,
drain old provider-mutating invocations, and inventory unresolved replacement
changes and source cancellations. An old attempt with no dispatch evidence is
unknown, not safe to retry. The new code sends such replacement retries to
manual review. Source calls made by the old code have no admission ledger;
identify and reconcile those operations before restarting deadline work.
Preserve provider IDs, attempts, frozen intent, and audit history. Do not clear
the lease or failure state to force retry. New replacement recovery may adopt
one matching uncharged CREATED object by read only. Source cancellation has no
automatic replay from ambiguity. Owner retry fetches the source and can adopt
terminal truth, or reuse a durable confirmed cancellation response with matching
current scheduled state. A scheduled-change flag alone and candidate
authorization are insufficient. Checkout replacement waits for terminal provider
state, including when local authorization expiry elapsed. A rollback must retain this fence and history;
use a compatible forward repair rather than restoring unfenced workers.

Migration `20260831160000_add_subscription_provisioning_intent` adds the
`PROVISIONING` billing-operation state, nullable immutable provisioning fields
to `OrganizationBillingChange`, and the tenant-scoped,
deduplicated `OrganizationBillingChangeAudit` ledger. It performs no backfill,
provider request, subscription cancellation, entitlement change, or rewrite of
an existing billing change.

This expansion is database-first, but old and new initial-checkout protocols
must not overlap. The old deployment can call Razorpay before recording a local
intent; the new deployment relies on the durable intent and admission marker to
decide that a create must never be repeated. Before migration, put
`RAZORPAY_BILLING_WRITES_ENABLED` on an operator-owned server-side hold, record
the UTC hold time, and stop new owner checkout submissions. Prove from runtime
request state and logs that every old-deployment initial-subscription request
and provider-create call started before the hold has terminated. A zero lease
count is useful but is not sufficient proof because the old create-before-intent
path could be between its provider call and local persistence.

After an approved backup and exact target/deployment confirmation, record these
pre-migration values without provider IDs or connection details:

```sql
SELECT COUNT(*) AS billing_change_count
FROM "OrganizationBillingChange";

SELECT COUNT(*) AS active_organization_mutation_leases
FROM "Organization"
WHERE "billingMutationLeaseToken" IS NOT NULL
  AND "billingMutationLeaseUntil" > CURRENT_TIMESTAMP;

SELECT "migration_name", "finished_at", "rolled_back_at"
FROM "_prisma_migrations"
WHERE "migration_name" = '20260831160000_add_subscription_provisioning_intent';
```

The active lease count must be zero after the request/provider-call drain, and
the migration-history query must return no row on first application. Stop on
any other result. Apply through the protected migration workflow, then run the
normal before/after `pnpm prisma migrate status` checks. While billing writes
remain held, verify the exact expansion:

```sql
SELECT enumlabel
FROM pg_enum
JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
WHERE pg_type.typname = 'BillingOperationStatus'
  AND enumlabel = 'PROVISIONING';

SELECT "column_name", "is_nullable"
FROM information_schema.columns
WHERE "table_schema" = 'public'
  AND "table_name" = 'OrganizationBillingChange'
  AND "column_name" IN (
    'provisioningIntentVersion',
    'provisioningSourceSubscriptionId',
    'providerMutationAdmittedAt',
    'authorizedBillingModelVersion',
    'authorizedProviderStartAt',
    'authorizedProviderExpireAt',
    'authorizedTotalCount'
  )
ORDER BY "column_name";

SELECT
  to_regclass('"OrganizationBillingChangeAudit"') AS audit_table,
  to_regclass('"OrganizationBillingChangeAudit_dedupeKey_key"') AS audit_dedupe,
  to_regclass('"OrganizationBillingChangeAudit_organizationId_createdAt_idx"') AS audit_org_time,
  to_regclass('"OrganizationBillingChangeAudit_changeId_createdAt_idx"') AS audit_change_time;

SELECT
  COUNT(*) AS billing_change_count,
  COUNT(*) FILTER (
    WHERE "provisioningIntentVersion" IS NOT NULL
       OR "provisioningSourceSubscriptionId" IS NOT NULL
       OR "providerMutationAdmittedAt" IS NOT NULL
       OR "authorizedBillingModelVersion" IS NOT NULL
       OR "authorizedProviderStartAt" IS NOT NULL
       OR "authorizedProviderExpireAt" IS NOT NULL
       OR "authorizedTotalCount" IS NOT NULL
  ) AS unexpectedly_initialized_existing_count
FROM "OrganizationBillingChange";

SELECT COUNT(*) AS audit_count
FROM "OrganizationBillingChangeAudit";
```

Require one `PROVISIONING` enum row, all seven nullable columns, all four
non-null `regclass` values, the exact pre-migration billing-change count,
`unexpectedly_initialized_existing_count = 0`, `audit_count = 0`, and clean
migration status. Then promote the new provisioning code while writes remain
held. In isolated Test mode, create one checkout and verify an intent-created,
call-admitted, and provider-state-adopted audit sequence before releasing a
single allowlisted canary and then the broader billing-write gate.

For rollback, re-establish the billing-write hold and drain every new request and
lease. Retain the additive columns, audit ledger, and all provider/local
evidence. Do not send traffic to the old create-before-intent code while any new
provisioning row is unresolved or any admitted provider call may still be in
flight. There is no automatic down migration; prefer a compatible forward fix.

### Webhook operations

1. Use separate Test and Live endpoints, credentials, and webhook secrets.
2. Make the endpoint publicly reachable by Razorpay without weakening
   authentication elsewhere. Confirm any Preview Deployment Protection
   exception with the operator.
3. Configure exactly the approved event set in the
   [Workspace billing V2 rollout](./workspace-billing-rollout.md) and
   [Razorpay live-review checklist](./razorpay-live-review.md).
4. Send a provider-signed Test delivery, require `2xx`, and verify one durable
   receipt with `attemptCount = 1` and provider-authoritative reconciliation.
   Confirm the stored status, customer, plan, quantity, paid period, invoice,
   and payment came from the provider fetch, not from the otherwise-valid signed
   payload snapshot.
5. Replay the same event after completion, then issue two simultaneous copies in
   Preview. Confirm one owner reconciles, the nonowner receives the generic
   in-progress success response, and one receipt is finalized. Test expired-
   claim recovery, out-of-order delivery, hash collision rejection, and lost-
   callback recovery before Production.
6. For secret rotation, add the new current secret and retain old secrets only
   through the owner-approved overlap in `RAZORPAY_WEBHOOK_OLD_SECRETS`. Redeploy,
   verify a signed delivery using the new secret, then remove the old secret and
   redeploy again.

Do not log or retain raw webhook bodies as incident evidence. Use event IDs,
payload hashes, timestamps, processing state, provider entity IDs, and redacted
error categories.

### Billing release controls

Billing changes are deliberately staged by
`RAZORPAY_BILLING_WRITES_ENABLED`,
`RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED`,
`RAZORPAY_LIVE_CANARY_ORG_IDS`, and
`WORKSPACE_BRANCH_BILLING_V2_ENABLED`. An environment-variable change is not
active until a new deployment uses it.

`RAZORPAY_BILLING_WRITES_ENABLED` is not a complete billing kill switch. Signed
webhooks, provider reconciliation, or work already in progress can still change
local state. When a billing incident requires a full worker pause, separately
disable the hourly cron and allow active mutation leases/provider requests to
drain according to the incident decision.

Use the repository scripts as follows:

- `scripts/razorpay-preflight.ts` is read-only and rejects mutation flags. Run
  it for the selected target with explicit expectations from the detailed
  billing runbook. It can assert an exact target with
  `--expect-database-fingerprint=<SHA256>`.
- `scripts/prepare-workspace-billing-rollout.ts` is a dry run unless `--apply`
  is present. Selecting promotion targets uses
  `--promote=<comma-separated-org-ids>`; selection alone does not apply changes.
  Promotion refuses any existing current subscription whose `paidThrough` or
  paid status lacks the same exact stored settlement evidence used by runtime
  entitlement. Apply takes the organization mutation lock, reloads subscription
  evidence, branch count, billing model, and mutation sequence, and reruns all
  guards before promotion.
- `scripts/reconcile-legacy-paid-entitlements.ts` is provider-read-only and a
  database dry run unless `--apply` is present. Both modes require an explicit
  organization allowlist and expected Razorpay mode. Apply additionally requires
  the exact deployment target, database fingerprint, and fresh batch proposal
  hash; ambiguous evidence becomes manual review and never paid access.
- `scripts/audit-legacy-unsupported-method-cancellations.ts` is a dry run unless
  `--apply` is present. Resolve every manual-review row before any apply run.

All three scripts parse `BILLING_ENV_FILE` into a fresh allowlisted environment
before dynamically importing Prisma or Razorpay code. A missing file or a
conflicting ambient `DATABASE_URL`, `ACCELERATE_URL`, `RAZORPAY_MODE`,
`RAZORPAY_KEY_ID`, or `VERCEL_ENV` stops the command. Unknown file variables are
not installed into the script process.

Prisma runtime precedence is reported only as `ACCELERATE_URL`,
`DATABASE_URL_AS_ACCELERATE`, `DATABASE_URL`, or `UNCONFIGURED`; hosts,
credentials, query strings, and complete connection URLs are never printed.
The database fingerprint is derived from the singleton database-resident
`BillingDatabaseIdentity`, so it describes the database actually selected by
that precedence.

An apply run requires all of the following in addition to the selected
`BILLING_ENV_FILE` and `VERCEL_ENV`:

```text
--apply
--target=preview|production
--expect-razorpay-mode=TEST|LIVE
--expect-database-fingerprint=<SHA256_FROM_THE_SAME_TARGET_PREFLIGHT>
--scope=organizations
--organization-ids=<COMMA_SEPARATED_REVIEWED_ORGANIZATION_IDS>
```

The organization IDs are normalized, sorted, and represented in output by only
a count and SHA-256 set fingerprint. Every candidate query, write, and provider
fetch is filtered to that allowlist. Promotion IDs must be a subset of the same
allowlist. Run a dry audit with the identical scope and IDs immediately before
apply; an unscoped dry run may be used only for read-only discovery. The script
reads the database identity through Prisma's selected connection and compares
it to the expected fingerprint before any scoped work. A copied apply command
therefore cannot silently run against a different database, provider mode,
deployment environment, or implicit/broader tenant set.

Retain preflight fingerprints and redacted aggregate reports privately. Never
publish organization, subscription, payment, or credential values. Follow the
full Preview acceptance, Live canary, provider-Dashboard, migration, and flag
sequence in the [Workspace billing V2 rollout](./workspace-billing-rollout.md).

### Legacy paid-entitlement transition

Finding 5 uses the exact-commercial-evidence schema already deployed by
`20260829120000_add_exact_commercial_evidence`; it adds no migration or new
environment variable. Do not infer or bulk-write paid state from
`AUTHENTICATED`, `ACTIVE`, or a future `paidThrough`.

Before applying the shared entitlement gate to a target, take the approved
backup, hold Razorpay writes and Live canaries, pause only the hourly billing
schedule through the operator control, and let active billing leases drain.
Use small, reviewed organization batches. The Production dry run is:

```powershell
pnpm exec tsx scripts/reconcile-legacy-paid-entitlements.ts --env-file=.env.production.local --target=production --expect-razorpay-mode=LIVE --scope=organizations --organization-ids=<COMMA_SEPARATED_ORG_IDS>
```

The dry run performs database and Razorpay reads only. Privately retain its
target binding, database fingerprint, organization-set fingerprint,
`batchProposalHash`, pre-operation stored-evidence counts, proposal counts, and
itemized dispositions. Verify every organization belongs in the batch and stop
on a wrong target, wrong mode, missing record, ambiguous/incomplete provider
evidence, overlapping current invoices, mismatched commercial tuple, or provider
read failure. A status-only record is not an exact proposal.

Immediately before apply, rerun the same dry command and require an unchanged
database fingerprint and a freshly reviewed proposal hash. Apply exactly that
batch with:

```powershell
pnpm exec tsx scripts/reconcile-legacy-paid-entitlements.ts --apply --env-file=.env.production.local --target=production --expect-razorpay-mode=LIVE --expect-database-fingerprint=<DATABASE_SHA256> --scope=organizations --organization-ids=<SAME_COMMA_SEPARATED_ORG_IDS> --confirm-batch-proposal-hash=<FRESH_BATCH_PROPOSAL_SHA256>
```

Apply re-fetches provider evidence before each local transaction. It writes only
an exact current settlement tuple and its idempotent `LEGACY_TRANSITION` lineage,
or durable manual-review history for unresolved evidence; it never calls a
Razorpay mutation. A changed local/provider proposal is quarantined rather than
adopted. Require `postCounts.exactBackedCurrentPeriods` to increase only by the
reviewed exact-apply dispositions, require every unresolved record to appear in
manual review, and rerun the dry command to prove idempotence. Retain the
redacted pre/apply/post reports privately.

Only after those counts are reconciled should the exact entitlement code be
released and any organization be considered for Workspace V2 promotion. The
rollout audit rejects unbacked paid state independently. Resume the hourly
schedule and billing writes only after legacy Basic fallback, exact paid access,
trial access, manual-review visibility, and provider-mode isolation pass the
target smoke tests.

There is no destructive rollback for this transition. Do not delete exact
invoice/payment/intent lineage or clear manual-review history. If rollout
verification fails, keep billing writes and V2 promotion held, preserve the
reports, and deploy a compatible forward repair. An application rollback must
not restore status-only premium entitlement; provider reconciliation remains the
recovery path.

## Rollback and recovery are different operations

| Layer | Safe interpretation |
| --- | --- |
| Application deployment | Vercel Instant Rollback can point Production traffic to a previous deployment artifact. It does not reverse database migrations or external provider actions. Verify configuration and cron state afterward. |
| Environment configuration | Changing a Vercel variable does not change an existing deployment. Set the intended configuration and create a new deployment. A rolled-back artifact can carry stale configuration assumptions. |
| Database | This repository has no down-migration or automatic Production database rollback procedure. Prefer a compatible forward fix. Restore only through the operator-owned, tested backup procedure with explicit approval and a data-loss assessment. |
| Import Workflow | Holding `IMPORT_V2_ENABLED` in a new deployment stops new starts only. Existing deployment-pinned runs must be drained or explicitly cancelled; completed items and the PostgreSQL ledger are not rolled back. |
| Razorpay | An application rollback does not cancel, refund, or reverse provider subscriptions, mandates, invoices, payments, or webhook delivery. Reconcile provider and local state; ambiguous cases require manual review. |
| Meta WhatsApp | Holding integration/onboarding/template/message/planners/report/notice/health/operations/webhook flags, clearing every canary, and separately pausing WhatsApp schedules stops new work only after the new deployment/control is active. It does not undo an in-flight provider result, WABA/system-user subscription, phone registration, template creation, accepted/unknown message, report snapshot, notice, incident, budget state, sender evidence, or customer-owned asset. Preserve history and prefer forward reconciliation; local disconnect is deliberately non-destructive. |
| Scheduled jobs | Disable or update schedules through the approved Vercel control, then verify the active Cron Jobs dashboard. Do not assume deployment rollback paused them. |

Vercel's official
[Production rollback guidance](https://vercel.com/docs/deployments/rollback-production-deployment)
describes repointing traffic to a previous deployment. It does not reverse this
application's database migrations or provider actions. Before using it, prove
that the previous application is compatible with the current database schema
and provider state.

### Rollback decision

1. Identify whether the failure is in application code, schema/data,
   environment, scheduled work, or an external provider.
2. Stop new harmful work with the narrowest verified control.
3. Confirm old-code/current-schema compatibility before application rollback.
4. Preserve evidence and record the exact deployment and database state.
5. Choose application rollback, new fixed deployment, forward database repair,
   or approved backup restore. Do not combine them without an explicit sequence.
6. Verify tenant access, billing entitlements, webhook processing, scheduled
   jobs, and provider reconciliation before declaring recovery.

## Incident procedure

### Declare and assess

1. Assign the incident commander and record all times in UTC.
2. Record the current commit, Vercel deployment ID, domains, recent migration
   workflow runs, changed environment names, and affected routes or tenants.
3. Classify impact: authentication/authorization, cross-tenant access, data
   integrity, database availability, billing/provider state, secret exposure,
   cron backlog, or AI/vendor data flow.
4. Start the approved private incident record. Do not include secrets or raw
   customer data.

### Contain

- For a bad but schema-compatible application deployment, use the approved
  Vercel rollback or deploy a fixed artifact, then verify current database and
  provider compatibility.
- For a billing incident, deploy with billing writes held, remove any canary
  allowlist, separately disable the hourly cron when required, and let in-flight
  leases settle. Continue accepting valid signed webhooks unless the incident
  commander determines webhook processing itself is harmful; provider evidence
  is needed for reconciliation.
- For an import execution incident, deploy with `IMPORT_V2_ENABLED=false`,
  inspect the PostgreSQL ledger, and decide explicitly whether active
  deployment-pinned runs drain or receive cancellation requests. Disable the
  import-retention cron separately only when purging is implicated. Preserve
  immutable plans, idempotency keys, completion markers, and redacted results;
  do not delete rows or run ad hoc cleanup to claim rollback.
- For a WhatsApp incident, deploy with onboarding, template, message, both
  planners, reports, notices, health, and operations controls false, clear every
  Live/health canary, and separately pause all WhatsApp schedules. If the whole
  product surface is harmful, also set
  `WHATSAPP_INTEGRATION_ENABLED=false`. Disable webhook ingestion separately only
  if signed processing itself is harmful; otherwise retain provider evidence for
  reconciliation. Inspect connection/provisioning/message/receipt leases,
  provider-authoritative sender/template state, report/notice sources, safety/
  incidents/jobs, queue and budget state, and every `UNKNOWN` outcome. Do not
  delete history, release an ambiguous reservation,
  blindly repeat a provider mutation, change a payment/student, share credit, or
  perform a destructive provider disconnect.
- For a runaway or compromised cron, disable Vercel Cron Jobs through the
  approved dashboard procedure. Rotate `CRON_SECRET` and redeploy if the secret
  was exposed.
- For a credential incident, create/rotate at the provider, update the narrowly
  scoped Vercel environment, redeploy, verify the new deployment, then revoke
  the old credential. Handle webhook overlap using the approved bounded window.
- For a database incident, stop harmful writes using the operator-owned traffic
  or database control, take a forensic backup, and engage the database owner.
  The repository has no global maintenance-mode or read-only switch.

Do not automatically refund charges, delete webhook receipts, clear billing
operations, edit migration history, or run ad hoc Production SQL during
containment.

### Evidence to retain privately

- Vercel deployment/build/runtime logs and Cron invocation summaries;
- GitHub CI and Production migration workflow run IDs and logs;
- migration status and approved database backup identifiers;
- billing operation, subscription history, invoice, and webhook receipt IDs,
  hashes, timestamps, and redacted errors;
- import session/run IDs, target revision, plan/request hashes, item/progress
  counts, Workflow run ID, lease/retry/cancellation timestamps, retention-cron
  counts, and redacted error codes—never source rows or mutation payloads;
- Razorpay subscription, invoice, payment, webhook-delivery, and Dashboard audit
  evidence;
- WhatsApp connection/provisioning/subscription/snapshot/notice/message/receipt/
  safety/incident/job IDs, lease/mode/status timestamps, catalogue key/version/
  hash, bounded audit actions, template-sync and job counts, receipt hashes/
  statuses, message status-event IDs, safe error codes, estimated budget/rate-
  card version, and redacted Meta request identifiers where
  already safely retained—never recipient phone/name, typed message values,
  OAuth codes, access tokens, PINs, raw signup sessions, signatures, webhook
  bodies, inbound text, raw errors, or customer secrets; and
- actor/time records from the relevant application audit trail.

Repository evidence is incomplete on its own: there is no public platform-health
endpoint, centralized log sink, alert routing, status page, or operator-owned
log-retention policy. Tenant incidents and bounded cron evidence do not fill
those external monitoring and communications gaps.

### Recover and verify

1. Confirm the intended deployment, environment scope, domains, and migration
   status.
2. Confirm database invariants and that no unresolved migration or restore work
   remains.
3. Smoke-test sign-in, owner access, restricted-staff access, entitlement
   enforcement, and foreign-tenant denial with approved non-Production or
   restricted Production accounts.
4. Verify affected public routes and API responses without exposing internal
   errors.
5. For cron incidents, invoke each affected protected route once through the
   approved private client, inspect `2xx` metrics and errors, and confirm the
   intended schedule/dashboard state.
6. For billing incidents, verify a signed webhook, duplicate handling,
   subscription/invoice/payment cross-linkage, `paidThrough`, entitlements,
   queued operations, leases, and provider reconciliation. Restart with one
   reviewed canary before broad writes.
7. For import incidents, verify the feature gate deployment, current
   revision/plan hash, run and item counts, duplicate-safe replay, active leases,
   cancellation state, redacted results, staging deadline, and retention-cron
   health. Repair only through a new revision and plan.
8. For WhatsApp incidents, verify the exact deployed flags/canaries/mode and
   schedule state; owner/tenant scope; connection, provisioning, planner,
   dispatcher, and receipt leases; sender assignment; provider-authoritative
   WABA/phone/template state; active recipient/consent; outbox/event projection;
   budget/rate-card state; subscriptions/snapshots/notices; safety/incidents/job
   evidence; signed replay/scoped/full STOP behavior; and every failed or
   `UNKNOWN` row. Resume with one reviewed manual Test/Live delivery canary only
   after ambiguity is resolved; enable one branch's prospective automation last.
9. Observe operator-owned logs and alerts for the approved recovery window.
10. Record residual risk, customer impact, follow-up owners, and any approved
   decision in `docs/decisions/`.

## Release and incident record template

Record the following without values or customer data:

```text
UTC start/end:
Operator / incident commander:
Approved commit and Vercel deployment ID:
Environment:
Migration workflow run and migration names:
Backup identifier and restore-test date:
Configuration names changed (names only):
Cron/webhook/billing/import Workflow/Meta WhatsApp impact:
Validation commands and results:
Smoke checks and observation window:
Rollback/recovery decision:
Remaining risks and owners:
```

## Related repository guidance

- [Workspace billing V2 rollout](./workspace-billing-rollout.md)
- [Razorpay live-review checklist](./razorpay-live-review.md)
- [Auth environments](./auth-environments.md)
- [Import Workflow execution proposal](./decisions/0001-managed-workflow-for-import-execution.md) — Proposed, not Accepted
- [WhatsApp communication foundation proposal](./decisions/0002-whatsapp-communication-foundation.md) — Proposed, not Accepted
- [WhatsApp managed Utility delivery decision](./decisions/0003-whatsapp-template-delivery-and-collections.md) — Accepted architecture; not rollout approval
- [WhatsApp reports and operational hardening decision](./decisions/0004-whatsapp-daily-reports-and-operational-hardening.md) — Accepted architecture; not rollout approval
- [CI workflow](../.github/workflows/ci.yml)
- [Production migration workflow](../.github/workflows/production-migrate.yml)
- [Vercel cron configuration](../vercel.json)

### Billing and WhatsApp tenant constraints (20260905173000)

Run `prisma/preflight/billing-and-whatsapp-tenants.sql` read-only against the
explicitly approved target and retain each named count; all must be zero before
migration. Snapshot counts of all tables named in that script before and after;
this migration must not change row counts. The migration locks all affected
parents/children, repeats preflight and adds keys/checks atomically. Drain these
writers while applying it. It adds no tenant fields or guessed backfills.
Previous writers producing coherent references remain compatible. Corrupt data
requires a separately reviewed repair preserving billing/provider history.
Nullable composite relations use PostgreSQL column-specific SET NULL; preserve
that SQL despite Prisma's required-scope-column warning. Never use db push to
replace the maintained migration chain. Rollback application code is possible
only for writers respecting these constraints; use forward repair for data or
constraint defects rather than rewriting this applied migration.

### Import and grouped-payment scopes (20260905180000 / 20260905183000)

Drain imports (including Workflow steps), WhatsApp planning/reconciliation and
staging retention before migration 44; old direct bulk writers omit newly
required branchId and cannot overlap new code. Run
`prisma/preflight/import-and-collection-tenants.sql`; all six blocker counts
must be zero. The migration locks parents and children, validates agreement,
backfills five new branch columns, then installs keys. Compare all ten table
counts before/after; no rows are deleted. Nullable session/plan/evaluation/row
history detaches only its foreign ID.

After 44, run `prisma/preflight/import-targets.sql`. Retain per-kind reference,
detached-history and foreign-blocker counts. Every foreign blocker must be zero;
missing historical targets are retained as explicitly detached snapshots. 45
locks import sources and six target tables, installs the typed ledger and
backfills it before installing maintenance triggers, all atomically. Supported
JSON is unchanged; malformed/unknown target kinds block rather than invent a
type. References survive payload redaction until staging retention deletes the
owner. Compare source row counts, expected distinct ledger references and live
versus detached counts after migration. Runtime new references require existing
same-branch targets; no caller bypasses the trigger with bulk SQL.

Deploy compatible application/worker code before resuming writers. Reverting
application code requires keeping branch-aware writers; the target ledger is
compatible with existing JSON writers. Repair constraints/triggers with a new
forward migration. Never remove history or rewrite applied migration files.
