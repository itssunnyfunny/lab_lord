# Workspace billing V2 rollout

Workspace/branch-seat billing is disabled by default and is activated only for organizations whose `billingModelVersion` is explicitly promoted to `WORKSPACE_V2`.

## Required environment

- `WORKSPACE_BRANCH_BILLING_V2_ENABLED=true` enables V2 for newly onboarded organizations.
- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` must be a matching Test or Live Mode pair.
- `RAZORPAY_WEBHOOK_SECRET` must be the secret configured for the webhook endpoint.
- `CRON_SECRET` protects billing and payment deadline jobs.
- `NEXT_PUBLIC_BUSINESS_ADDRESS` must match the merchant KYC address before live review.

## Razorpay webhook

Configure the endpoint as `https://lablords.in/api/razorpay/webhook` and enable:

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

Do not depend on `subscription.expired`. The hourly billing job detects authorization/start deadlines and reconciles provider subscription, invoice, and payment state.

Razorpay requests must use card authorization in V1. Callback verification and signed webhooks both trigger server-side provider fetches; browser success alone never grants access or advances `paidThrough`.

## Database deployment order

1. Deploy existing migration `20260802120000_add_subscription_history`.
2. Deploy `20260803120000_add_workspace_branch_billing`.
3. Run a dry audit: `pnpm exec tsx scripts/prepare-workspace-billing-rollout.ts`.
4. Apply owner grants and branch backfill: `pnpm exec tsx scripts/prepare-workspace-billing-rollout.ts --apply`.
5. Reconcile a candidate organization against Razorpay Test Mode.
6. Audit promotion: `pnpm exec tsx scripts/prepare-workspace-billing-rollout.ts --promote=ORG_ID`.
7. Promote after review: `pnpm exec tsx scripts/prepare-workspace-billing-rollout.ts --apply --promote=ORG_ID`.

The rollout script never calls Razorpay or changes an existing provider subscription. If an existing subscription quantity differs from the active branch count, it queues a next-cycle `LEGACY_TRANSITION` for serialized provider processing.

## Scheduled jobs

- `/api/cron/billing/hourly`: cancellation cutoffs, expired mutation leases, bounded retries, authorization/start deadlines, branch reductions, and missing-webhook reconciliation.
- `/api/cron/payments/daily`: existing student payment-due generation.

Vercel calls both with `Authorization: Bearer $CRON_SECRET`.
