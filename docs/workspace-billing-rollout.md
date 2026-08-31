# Workspace billing V2 rollout

Workspace billing derives quantity from billable branch lifecycle state. Card subscriptions can be updated in place; UPI AutoPay and eMandate plan, quantity, and payment-method changes use a separately authorised replacement subscription. `PRO` remains the database value displayed as Standard. Keep `RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED=false` until the Test Mode flow, database isolation, legacy-operation audit, and Live canary in this runbook have passed.

## Environment isolation

Preview and Production must use separate databases, Clerk instances, Razorpay modes, webhook secrets, and cron secrets. An authorized operator must identify and independently verify the Production database; an existing or locally configured database is not Production merely because of its name or history. Provision a separate Preview database with migrations and demo-only data.

| Variable | Preview | Production |
| --- | --- | --- |
| `DATABASE_URL` | Preview-only database | Independently verified Production database |
| `ACCELERATE_URL` | Preview database endpoint, if used | Production database endpoint, if used |
| `RAZORPAY_KEY_ID` | Test Key ID (`rzp_test_...`) | Live Key ID (`rzp_live_...`) |
| `RAZORPAY_KEY_SECRET` | Matching Test secret | Matching Live secret |
| `RAZORPAY_WEBHOOK_SECRET` | Test webhook secret | Separate Live webhook secret |
| `RAZORPAY_MODE` | `TEST` | `LIVE` |
| `RAZORPAY_BILLING_WRITES_ENABLED` | `true` | `false` until the canary passes |
| `RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED` | `false` until multi-method Test acceptance | `false` until the controlled Live canary |
| `RAZORPAY_LIVE_CANARY_ORG_IDS` | Empty | One reviewed organization ID during the canary only |
| `WORKSPACE_BRANCH_BILLING_V2_ENABLED` | `true` | `false` until the release gate passes |
| `CRON_SECRET` | Unique Preview value | Unique Production value |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk Test instance | Clerk Live instance |
| `CLERK_SECRET_KEY` | Matching Clerk Test secret | Matching Clerk Live secret |
| `NEXT_PUBLIC_SITE_URL` | Operator-approved stable Preview URL | Operator-approved Production URL |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Monitored support inbox | Monitored support inbox |
| `NEXT_PUBLIC_BUSINESS_ADDRESS` | Exact KYC-matching address | Exact KYC-matching address |

`RAZORPAY_KEY_ID` is server-only. Do not configure `NEXT_PUBLIC_RAZORPAY_KEY_ID`; the server includes the public Key ID in the authenticated Checkout payload. Never put an API secret or webhook secret in a `NEXT_PUBLIC_` variable.

### Diagnosing a Card-only Checkout

There are two independent gates. If `RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED` is absent or not exactly `true`, the billing overview reports `checkoutMethodAvailability.mode` as `CARD_ONLY` and the Checkout payload intentionally contains a card-only `config.display` block. For an approved local Test-mode check, set the server-only flag to `true` in the ignored local environment file and restart the Next.js process; environment changes are not applied to an already-running server. The overview should then report `PROVIDER_MANAGED`, and the Checkout payload must omit `config` so Razorpay can choose eligible recurring methods.

`PROVIDER_MANAGED` does not guarantee that every candidate method appears. Razorpay still requires Card, UPI AutoPay, and eMandate to be enabled for Subscriptions in the matching Test or Live account, with any required account approval complete. Currency, mandate amount, merchant category, device, UPI app, and bank support can further narrow Checkout. Netbanking appears only as an eMandate authorisation route, not as a separate one-time payment option.

Set GitHub Environment secret `PRODUCTION_DIRECT_DATABASE_URL` to the direct Production Postgres URL. The protected `.github/workflows/production-migrate.yml` workflow requires an explicit confirmation and is the only supported Production migration path.

## Provider and database preflight

`scripts/razorpay-preflight.ts` is read-only. It validates the target, `VERCEL_ENV`, key prefix, Clerk mode, feature switches, required public business data, database identity, provider-mode rows, active operations, and provider fetchability. It also calls Razorpay's account-specific [`GET /v1/methods`](https://razorpay.com/docs/payments/subscriptions/supported-banks-apps/?preferred-country=IN) endpoint using only the Key ID and reports aggregate Card, UPI, recurring-card, and recurring-eMandate capabilities. Bank, app, handle, and card-network lists are never compiled into this repository; Razorpay's current response remains authoritative. It prints fingerprints and aggregate counts only; it never prints credentials or raw provider IDs.

The Methods API does not prove every Dashboard-only or device-dependent setting. When `--expect-multi-method-subscriptions=enabled` is used, the preflight therefore requires explicit evidence flags for Subscription settings, Standard Checkout UPI Intent, desktop UPI QR, webhook subscriptions, and amount eligibility. The output records those attestations, the required webhook event set, and the highest configured charge per currency. Eligibility is still decided by Razorpay Checkout for the account, amount, customer bank/app, and device; do not turn these checks into a static allow-list.

The following environment-pull and Production preflight commands are for an
explicitly authorized human operator on an approved workstation. Coding agents
must not execute them or access the resulting values. If the operator-approved
procedure permits a local pull, place each Vercel environment in a separate
ignored, access-restricted file. Because local script execution is not itself a
Vercel deployment, set `VERCEL_ENV` explicitly for the invocation:

```powershell
vercel env pull .env.preview.local --environment=preview --yes
pnpm exec cross-env BILLING_ENV_FILE=.env.preview.local VERCEL_ENV=preview tsx scripts/razorpay-preflight.ts --target=preview
```

Record the full Preview `databaseFingerprint`, then audit Production while writes and new V2 onboarding remain disabled:

```powershell
vercel env pull .env.production.local --environment=production --yes
pnpm exec cross-env BILLING_ENV_FILE=.env.production.local VERCEL_ENV=production tsx scripts/razorpay-preflight.ts --target=production --must-differ-from=<PREVIEW_DATABASE_FINGERPRINT> --expect-empty-provider-catalog
```

The command exits non-zero for a shared database, wrong-mode row, credential mismatch, inaccessible provider entity, plan snapshot mismatch, unresolved configuration placeholder, unexpected feature-switch value, unavailable Methods API, or missing expected recurring capabilities. Use `--expect-billing-writes=enabled`, `--expect-v2=enabled`, or `--expect-multi-method-subscriptions=enabled` only after those switches are intentionally released.

After Card, UPI, and eMandate have been enabled and exercised in the target Razorpay mode, run the enabled check with evidence captured from that same mode:

```powershell
pnpm exec cross-env BILLING_ENV_FILE=.env.preview.local VERCEL_ENV=preview tsx scripts/razorpay-preflight.ts --target=preview --expect-multi-method-subscriptions=enabled --confirm-subscription-settings --confirm-upi-intent --confirm-upi-qr --confirm-webhook-events --confirm-amount-eligibility
```

The preflight has no `--apply`, cleanup, cancel, delete, or migration mode. Old Test artifacts in the operator-verified Production database require all of the following before any change: a current backup, a reviewed itemized report, explicit owner approval, and a separately reviewed one-off operation. Preserve organizations, branches, students, owner trials, selected post-trial plans, and subscription history. Do not improvise cleanup SQL from this runbook.

## Database deployment order

1. Deploy existing migration `20260802120000_add_subscription_history`.
2. Deploy `20260803120000_add_workspace_branch_billing`.
3. Deploy `20260804120000_add_billing_operation_experience`.
4. Deploy `20260805120000_add_selected_post_trial_plan`.
5. Deploy `20260807120000_add_razorpay_provider_catalog` without modifying prior migration history.
6. Deploy `20260810150000_add_subscription_replacement_foundation` while the multi-method flag remains off.
7. Deploy `20260810153000_cut_over_subscription_current_slot` after the expansion/backfill checks pass.
8. Deploy additive migration `20260829120000_add_exact_commercial_evidence` database-first and complete its pre/post count, constraint, index, and migration-status checks from the production runbook. Do not backfill historical intent from the current plan catalog.
9. Before entitlement cutover or V2 promotion, run the organization-scoped, provider-read-only `scripts/reconcile-legacy-paid-entitlements.ts` dry audit from the approved release artifact. Review its pre/proposal counts and exact updates, then apply only an unchanged fresh proposal with the matching target, Razorpay mode, database fingerprint, organization allowlist, and batch proposal hash. Ambiguous records must enter manual review. Follow the exact commands and rollback rules in the production runbook; this step uses the existing exact-evidence schema and has no additional migration.
10. Run `pnpm exec cross-env BILLING_ENV_FILE=.env.production.local VERCEL_ENV=production tsx scripts/prepare-workspace-billing-rollout.ts --scope=organizations --organization-ids=<REVIEWED_ORGANIZATION_IDS>` for the operator-verified Production target's database-only dry audit. Record the database fingerprint and organization-set fingerprint reported through the selected Prisma connection. The audit must refuse any current subscription whose paid state is not backed by the shared exact settlement tuple. Promotion apply takes the organization mutation lock, reloads subscription evidence, branch count, billing model, and mutation sequence, and reruns all promotion guards before writing V2.
11. Run the new Razorpay preflight for the target environment.
12. The rollout script is dry-run by default. Database mutation requires `--apply`, `--target=production`, `--expect-razorpay-mode=LIVE`, `--expect-database-fingerprint=<FINGERPRINT_FROM_THIS_TARGET>`, `--scope=organizations`, and `--organization-ids=<REVIEWED_ORGANIZATION_IDS>`; selected organization promotion additionally requires `--promote=<comma-separated-org-ids>` and every promotion ID must be in the same allowlist. Keep the explicit `BILLING_ENV_FILE` and `VERCEL_ENV` binding on every dry-run or apply invocation and review a dry run with the identical organization allowlist first. The guard re-reads the database-resident identity before any scoped query, write, or provider fetch. The script never calls Razorpay.

Example Production apply after review:

```powershell
pnpm exec cross-env BILLING_ENV_FILE=.env.production.local VERCEL_ENV=production tsx scripts/prepare-workspace-billing-rollout.ts --apply --target=production --expect-razorpay-mode=LIVE --expect-database-fingerprint=<PRODUCTION_DATABASE_FINGERPRINT> --scope=organizations --organization-ids=<REVIEWED_ORGANIZATION_IDS>
```

The provider-catalog migration labels all pre-existing plan, offer, and current-subscription references as `TEST`; there is no permanent database default. Its original empty-Live-account assumption is not repository-verifiable. Before applying it, obtain dated owner-approved provider evidence and reconcile every existing Live/Test entity. A Production preflight must fail until all legacy Test references in the verified target have been explicitly reviewed and resolved.

## Razorpay Dashboard configuration

Configure these settings independently in Test and Live Mode:

- Disable Flash Checkout and Quick Buy.
- Under Subscription payment methods, enable Card, UPI AutoPay, and eMandate. “Netbanking” is an eMandate authorisation route, not a separate one-time payment option.
- Verify account approval for both recurring methods. If UPI or eMandate is missing from the account-specific Methods API response or Checkout, stop and resolve account enablement with Razorpay Support.
- Exercise UPI Intent on supported mobile devices and UPI QR on desktop Standard Checkout. Do not infer support from a hardcoded app list.
- Exercise the smallest and largest configured plan/quantity combinations. Razorpay Checkout, the selected bank/app, and the current account/MCC decide amount eligibility.
- Use a unique webhook secret for each mode.
- Keep the Production webhook absent or disabled while Production billing writes are held, then configure it before the canary.

Use a stable, publicly reachable Preview hostname for the Test webhook. Do not use an ephemeral deployment URL that changes on every push, and ensure Vercel Deployment Protection does not block Razorpay from reaching the webhook route.

Webhook endpoints:

- Preview Test Mode: `https://<stable-preview-host>/api/razorpay/webhook`
- Production Live Mode: `https://<approved-production-host>/api/razorpay/webhook`

Enable exactly:

- `subscription.authenticated`
- `subscription.activated`
- `subscription.charged`
- `subscription.updated`
- `subscription.pending`
- `subscription.halted`
- `subscription.paused`
- `subscription.resumed`
- `subscription.cancelled`
- `subscription.completed`
- `invoice.paid`
- `invoice.partially_paid`
- `payment.authorized`
- `payment.captured`
- `payment.failed`

Do not configure `subscription.expired`. Authorization/start deadlines and missing webhook state are resolved through local deadlines and provider reconciliation. Browser success, `AUTHENTICATED`, `ACTIVE`, and signed webhook snapshot fields alone never grant access or advance `paidThrough`; both legacy and V2 deliveries are reconciliation triggers.

The public endpoint accepts at most 512 KiB, verifies the HMAC and payload hash
over the exact received bytes before JSON parsing, and uses an expiring
token-fenced receipt claim. Concurrent same-body deliveries must produce one
provider reconciliation; the nonowner is acknowledged as in progress. Reusing
an event ID with a different payload remains a `400` collision.

## Scheduled jobs

- `/api/cron/billing/hourly`: cancellation cutoffs, expired mutation leases, bounded retries, authorization/start deadlines, branch reductions, and missing-webhook reconciliation.
- `/api/cron/payments/daily`: student payment-due generation.

Both routes require `Authorization: Bearer $CRON_SECRET`. Vercel Cron invokes schedules only on Production deployments. During Preview acceptance, call the protected Preview routes manually and verify a `2xx` response and runtime logs; never put `CRON_SECRET` in the URL or documentation output.

## Multi-method deployment sequence

Follow this order exactly; do not combine the gates into one deployment:

1. Establish an operator-owned Razorpay webhook-ingress hold, record its UTC start, and prove every old-deployment webhook invocation has terminated. Keep ingress held while applying and verifying all additive migrations, including `20260831120000_add_razorpay_webhook_claim`, and while promoting the application code with `RAZORPAY_MULTI_METHOD_SUBSCRIPTIONS_ENABLED=false`. Schema compatibility does not make the old unfenced worker safe to overlap with the new token-fenced worker. Release the hold only after the new deployment reports the applied migration and one signed canary is ready; reconcile provider state for the held interval.
2. In Production, use the operator-approved Vercel control to pause only the hourly billing schedule, then wait for active mutation leases and in-flight billing operations to drain. Preview has no automatic cron worker; stop manual Preview invocations during the audit. Do not interrupt the daily student-payment schedule.
3. Run `pnpm exec cross-env BILLING_ENV_FILE=.env.production.local VERCEL_ENV=production tsx scripts/audit-legacy-unsupported-method-cancellations.ts --scope=organizations --organization-ids=<REVIEWED_ORGANIZATION_IDS>` and review every scoped dry-run row against the verified target. After provider verification and manual-review resolution, rerun with `--apply --target=production --expect-razorpay-mode=LIVE --expect-database-fingerprint=<PRODUCTION_DATABASE_FINGERPRINT> --scope=organizations --organization-ids=<THE_SAME_REVIEWED_ORGANIZATION_IDS>` to supersede eligible queued or failed legacy cancellations; retain both reports. The apply guard must match both the database and organization-set fingerprints from that target's retained dry-run evidence.
4. Enable Card, UPI AutoPay, and eMandate in Razorpay Test Mode. Turn on the application flag only in the isolated Preview environment, complete end-to-end acceptance, run the enabled preflight with all evidence flags, and resume only the approved manual Preview checks.
5. Configure the same methods in Live Mode and admit one reviewed workspace with `RAZORPAY_LIVE_CANARY_ORG_IDS`. Keep global billing writes held, complete the Live canary, and reconcile subscription, invoice, payment, webhook, and access state.
6. Remove the canary restriction and enable the application flag broadly only after reconciliation is clean. Re-enable the Production hourly schedule through the operator-approved control, verify its dashboard state, then enable global billing writes and V2 onboarding in separately observed redeployments.

If any capability disappears from the Methods API, a configured amount/method is absent in Checkout, a candidate replacement is ambiguous, or reconciliation reports overlapping charges, stop the rollout. Do not auto-refund or invent provider state.

## Preview acceptance and Live canary

1. Apply all migrations to the isolated Preview database and add demo-only data.
2. Confirm the Preview preflight reports only `TEST` rows and a database fingerprint different from Production.
3. Complete initial Card, UPI AutoPay, and eMandate authorisation, including UPI app/QR, delayed eMandate activation, decline/retry, lost callback plus signed webhook, simultaneous duplicate/in-progress handling, expired-claim recovery, collision rejection, out-of-order delivery, pause/resume, cancellation, hosted recovery, and confirmed `paidThrough` in Test Mode.
4. Exercise a Card in-place update and UPI/eMandate replacement for upgrade, downgrade, quantity increase/reduction, proactive method switch, Undo before the 72-hour cutoff, and safe-cycle cutover. Confirm no early downgrade, proration, duplicate charge, or client-trusted access grant.
5. Run authenticated desktop and mobile browser tests with a restricted Preview QA account, including eligible and ineligible amount/device combinations.
6. Run the enabled multi-method preflight with all five explicit evidence flags and retain its aggregate Methods API report.
7. Back up Production and run the protected Production migration workflow.
8. Review and explicitly approve resolution of every old Test plan, offer, subscription, unsupported-method cancellation, unresolved Checkout operation, and legacy paid-entitlement proposal in Production. Provider-confirmed legacy paid customers must have the exact stored invoice/payment/intent tuple; all ambiguous legacy records must remain Basic and enter manual review.
9. Run the held Production preflight with `--expect-empty-provider-catalog`; it must contain no `TEST` row and no provider catalog entity.
10. Configure the Live webhook and Dashboard settings. Verify a signed `2xx` delivery without enabling global writes.
11. Add one reviewed organization to `RAZORPAY_LIVE_CANARY_ORG_IDS`; leave `RAZORPAY_BILLING_WRITES_ENABLED=false` for everyone else.
12. Complete its first Live authorization and copy the resulting non-secret `plan_...` identifier from Razorpay Dashboard.
13. Prove the plan is stored and fetchable in Production:

```powershell
pnpm exec cross-env BILLING_ENV_FILE=.env.production.local VERCEL_ENV=production tsx scripts/razorpay-preflight.ts --target=production --must-differ-from=<PREVIEW_DATABASE_FINGERPRINT> --expect-plan-id=<LIVE_PLAN_ID> --expect-multi-method-subscriptions=enabled --confirm-subscription-settings --confirm-upi-intent --confirm-upi-qr --confirm-webhook-events --confirm-amount-eligibility
```

While the controlled Production organization remains allowlisted, append
`--expect-canary-org-id=<CANARY_ORG_ID>`. Without that explicit assertion the
preflight requires `RAZORPAY_LIVE_CANARY_ORG_IDS` to be empty.

14. Prove the same ID is not stored in Preview:

```powershell
pnpm exec cross-env BILLING_ENV_FILE=.env.preview.local VERCEL_ENV=preview tsx scripts/razorpay-preflight.ts --target=preview --must-differ-from=<PRODUCTION_DATABASE_FINGERPRINT> --forbid-plan-id=<LIVE_PLAN_ID>
```

These checks provide the four release assertions: Production contains no Test mapping; the empty Live catalog causes first authorization to create a Live plan; Preview and Production have different database fingerprints; and the returned Live plan is stored and provider-fetchable only in Production.

After webhook delivery, processing completion, `paidThrough`, replacement/cutover, cancellation, recovery, pause/resume, and cron logs pass for the canary, remove the canary ID. Enable multi-method billing broadly, then enable global billing writes and V2 onboarding in separately observed deployments. Redeploy after each Vercel environment change because environment updates do not alter an existing deployment.
