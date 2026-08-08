# Workspace billing V2 rollout

Workspace billing uses one Razorpay subscription per organization and bills each active branch as a quantity unit. `PRO` remains the database value displayed as Standard. Keep Production billing held until the Test Mode flow, database isolation, and Live canary in this runbook have passed.

## Environment isolation

Preview and Production must use separate databases, Clerk instances, Razorpay modes, webhook secrets, and cron secrets. Preserve the existing database as Production and provision a fresh Preview database with migrations and demo-only data.

| Variable | Preview | Production |
| --- | --- | --- |
| `DATABASE_URL` | Preview-only database | Existing Production database |
| `ACCELERATE_URL` | Preview database endpoint, if used | Production database endpoint, if used |
| `RAZORPAY_KEY_ID` | Test Key ID (`rzp_test_...`) | Live Key ID (`rzp_live_...`) |
| `RAZORPAY_KEY_SECRET` | Matching Test secret | Matching Live secret |
| `RAZORPAY_WEBHOOK_SECRET` | Test webhook secret | Separate Live webhook secret |
| `RAZORPAY_MODE` | `TEST` | `LIVE` |
| `RAZORPAY_BILLING_WRITES_ENABLED` | `true` | `false` until the canary passes |
| `RAZORPAY_LIVE_CANARY_ORG_IDS` | Empty | One reviewed organization ID during the canary only |
| `WORKSPACE_BRANCH_BILLING_V2_ENABLED` | `true` | `false` until the release gate passes |
| `CRON_SECRET` | Unique Preview value | Unique Production value |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk Test instance | Clerk Live instance |
| `CLERK_SECRET_KEY` | Matching Clerk Test secret | Matching Clerk Live secret |
| `NEXT_PUBLIC_SITE_URL` | `https://lablords.in` | `https://lablords.in` |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Monitored support inbox | Monitored support inbox |
| `NEXT_PUBLIC_BUSINESS_ADDRESS` | Exact KYC-matching address | Exact KYC-matching address |

`RAZORPAY_KEY_ID` is server-only. Do not configure `NEXT_PUBLIC_RAZORPAY_KEY_ID`; the server includes the public Key ID in the authenticated Checkout payload. Never put an API secret or webhook secret in a `NEXT_PUBLIC_` variable.

Set GitHub Environment secret `PRODUCTION_DIRECT_DATABASE_URL` to the direct Production Postgres URL. The protected `.github/workflows/production-migrate.yml` workflow requires an explicit confirmation and is the only supported Production migration path.

## Provider and database preflight

`scripts/razorpay-preflight.ts` is read-only. It validates the target, `VERCEL_ENV`, key prefix, Clerk mode, feature switches, required public business data, database identity, provider-mode rows, active operations, and provider fetchability. It prints fingerprints and aggregate counts only; it never prints credentials or raw provider IDs.

Pull each Vercel environment into a separate ignored file. Because local script execution is not itself a Vercel deployment, set `VERCEL_ENV` explicitly for the invocation:

```powershell
vercel env pull .env.preview.local --environment=preview --yes
pnpm exec cross-env VERCEL_ENV=preview tsx scripts/razorpay-preflight.ts --target=preview --env-file=.env.preview.local
```

Record the full Preview `databaseFingerprint`, then audit Production while writes and new V2 onboarding remain disabled:

```powershell
vercel env pull .env.production.local --environment=production --yes
pnpm exec cross-env VERCEL_ENV=production tsx scripts/razorpay-preflight.ts --target=production --env-file=.env.production.local --must-differ-from=<PREVIEW_DATABASE_FINGERPRINT> --expect-empty-provider-catalog
```

The command exits non-zero for a shared database, wrong-mode row, credential mismatch, inaccessible provider entity, plan snapshot mismatch, unresolved configuration placeholder, or an unexpected feature-switch value. Use `--expect-billing-writes=enabled` and `--expect-v2=enabled` only after those switches are intentionally released.

The preflight has no `--apply`, cleanup, cancel, delete, or migration mode. Old Test artifacts in the preserved Production database require all of the following before any change: a current backup, a reviewed itemized report, explicit owner approval, and a separately reviewed one-off operation. Preserve organizations, branches, students, owner trials, selected post-trial plans, and subscription history. Do not improvise cleanup SQL from this runbook.

## Database deployment order

1. Deploy existing migration `20260802120000_add_subscription_history`.
2. Deploy `20260803120000_add_workspace_branch_billing`.
3. Deploy `20260804120000_add_billing_operation_experience`.
4. Deploy `20260805120000_add_selected_post_trial_plan`.
5. Deploy `20260807120000_add_razorpay_provider_catalog` without modifying prior migration history.
6. Run `pnpm exec tsx scripts/prepare-workspace-billing-rollout.ts` for the existing database-only dry audit.
7. Run the new Razorpay preflight for the target environment.
8. Use the existing rollout script `--apply` or `--promote` modes only after separately reviewing their database changes. It never calls Razorpay.

The provider-catalog migration labels all pre-existing plan, offer, and current-subscription references as `TEST`. This is a one-time backfill justified by the audited empty Live Razorpay account; there is no permanent database default. A Production preflight must fail until any legacy Test references in the preserved database have been explicitly reviewed and resolved.

## Razorpay Dashboard configuration

Configure these settings independently in Test and Live Mode:

- Disable Flash Checkout and Quick Buy.
- Under Subscription payment methods, enable Card only; disable UPI and eMandate for V1.
- Use a unique webhook secret for each mode.
- Keep the Production webhook absent or disabled while Production billing writes are held, then configure it before the canary.

Use a stable, publicly reachable Preview hostname for the Test webhook. Do not use an ephemeral deployment URL that changes on every push, and ensure Vercel Deployment Protection does not block Razorpay from reaching the webhook route.

Webhook endpoints:

- Preview Test Mode: `https://<stable-preview-host>/api/razorpay/webhook`
- Production Live Mode: `https://lablords.in/api/razorpay/webhook`

Enable exactly:

- `subscription.authenticated`
- `subscription.activated`
- `subscription.charged`
- `subscription.updated`
- `subscription.pending`
- `subscription.halted`
- `subscription.cancelled`
- `subscription.completed`
- `invoice.paid`
- `invoice.partially_paid`
- `payment.authorized`
- `payment.captured`
- `payment.failed`

Do not configure `subscription.expired`. Authorization/start deadlines and missing webhook state are resolved through local deadlines and provider reconciliation. Browser success alone never grants access or advances `paidThrough`.

## Scheduled jobs

- `/api/cron/billing/hourly`: cancellation cutoffs, expired mutation leases, bounded retries, authorization/start deadlines, branch reductions, and missing-webhook reconciliation.
- `/api/cron/payments/daily`: student payment-due generation.

Both routes require `Authorization: Bearer $CRON_SECRET`. Vercel Cron invokes schedules only on Production deployments. During Preview acceptance, call the protected Preview routes manually and verify a `2xx` response and runtime logs; never put `CRON_SECRET` in the URL or documentation output.

## Preview acceptance and Live canary

1. Apply all migrations to the isolated Preview database and add demo-only data.
2. Confirm the Preview preflight reports only `TEST` rows and a database fingerprint different from Production.
3. Complete initial authorization, decline/retry, lost callback plus signed webhook, upgrade, quantity increase, cancellation, recovery, and confirmed `paidThrough` in Test Mode.
4. Run authenticated desktop and mobile browser tests with a restricted Preview QA account.
5. Back up Production and run the protected Production migration workflow.
6. Review and explicitly approve resolution of every old Test plan, offer, subscription, and unresolved Checkout operation in Production.
7. Run the held Production preflight with `--expect-empty-provider-catalog`; it must contain no `TEST` row and no provider catalog entity.
8. Configure the Live webhook and Dashboard settings. Verify a signed `2xx` delivery without enabling global writes.
9. Add one reviewed organization to `RAZORPAY_LIVE_CANARY_ORG_IDS`; leave `RAZORPAY_BILLING_WRITES_ENABLED=false` for everyone else.
10. Complete its first Live authorization and copy the resulting non-secret `plan_...` identifier from Razorpay Dashboard.
11. Prove the plan is stored and fetchable in Production:

```powershell
pnpm exec cross-env VERCEL_ENV=production tsx scripts/razorpay-preflight.ts --target=production --env-file=.env.production.local --must-differ-from=<PREVIEW_DATABASE_FINGERPRINT> --expect-plan-id=<LIVE_PLAN_ID>
```

While the controlled Production organization remains allowlisted, append
`--expect-canary-org-id=<CANARY_ORG_ID>`. Without that explicit assertion the
preflight requires `RAZORPAY_LIVE_CANARY_ORG_IDS` to be empty.

12. Prove the same ID is not stored in Preview:

```powershell
pnpm exec cross-env VERCEL_ENV=preview tsx scripts/razorpay-preflight.ts --target=preview --env-file=.env.preview.local --must-differ-from=<PRODUCTION_DATABASE_FINGERPRINT> --forbid-plan-id=<LIVE_PLAN_ID>
```

These checks provide the four release assertions: Production contains no Test mapping; the empty Live catalog causes first authorization to create a Live plan; Preview and Production have different database fingerprints; and the returned Live plan is stored and provider-fetchable only in Production.

After webhook delivery, processing completion, `paidThrough`, cancellation, recovery, and cron logs pass for the canary, remove the canary ID. Enable global billing writes first, then enable V2 onboarding. Redeploy after each Vercel environment change because environment updates do not alter an existing deployment.
