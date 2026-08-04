# Razorpay live-review checklist

Complete this checklist in Razorpay Test Mode before requesting Live Mode approval.

## Required deployment configuration

- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`: use a valid Test Mode pair during verification, then configure Live Mode values only in the production environment.
- `RAZORPAY_WEBHOOK_SECRET`: use the secret configured for the deployed webhook endpoint.
- `NEXT_PUBLIC_BUSINESS_ADDRESS`: use the exact public address supplied in Razorpay KYC.
- `NEXT_PUBLIC_SITE_URL=https://lablords.in`
- `NEXT_PUBLIC_SUPPORT_EMAIL`: use the monitored billing and refund inbox.

The local aliases `Test_API_Key`, `Test_Key_Secret`, and `Test_Webhook_Secret` remain supported for development. Never expose a key secret through a `NEXT_PUBLIC_` variable.

## Webhook configuration

For Preview acceptance, set the Test Mode webhook URL to the exact protected Preview deployment URL:

`https://<preview-deployment>.vercel.app/api/razorpay/webhook`

For production Live Mode, use `https://lablords.in/api/razorpay/webhook` with a separate production webhook secret.

Subscribe to:

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

Do not configure or depend on `subscription.expired`. Authorization and start-date expiry are detected by the hourly deadline job and provider reconciliation.

Use the same webhook secret in Razorpay and the deployed environment. Verify a successful delivery and a `2xx` response before live review.

## Test Mode acceptance flow

1. Confirm `/privacy`, `/terms`, `/refund-policy`, `/shipping-delivery-policy`, and `/contact` load without authentication.
2. Confirm Basic is ₹299/month and Standard is ₹499/month.
3. Complete a Basic checkout and confirm AI endpoints return `403`.
4. Complete a Standard checkout and confirm AI reports and message drafting are enabled.
5. Test paid upgrade and branch quantity increase without opening a second Checkout; confirm access changes only after provider payment reconciliation.
6. Schedule cancellation from organization billing settings and confirm access remains until the paid boundary.
7. Confirm the cancellation/completion webhook preserves data and changes the V2 workspace to read-only after `paidThrough`.
8. Test `PENDING`, `HALTED`, card recovery, and automatic restoration only after a captured renewal advances `paidThrough`.

## Reviewer access

If Razorpay requests login credentials, create a dedicated Clerk account containing demo-only organization, branch, student, and payment data. Share those credentials only through Razorpay onboarding or another private channel; never commit them to the repository.
