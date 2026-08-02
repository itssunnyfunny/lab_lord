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

Set the Test Mode webhook URL to:

`https://lablords.in/api/razorpay/webhook`

Subscribe to:

- `subscription.authenticated`
- `subscription.activated`
- `subscription.charged`
- `subscription.pending`
- `subscription.halted`
- `subscription.cancelled`
- `subscription.completed`
- `subscription.expired`
- `payment.captured`

Use the same webhook secret in Razorpay and the deployed environment. Verify a successful delivery and a `2xx` response before live review.

## Test Mode acceptance flow

1. Confirm `/privacy`, `/terms`, `/refund-policy`, `/shipping-delivery-policy`, and `/contact` load without authentication.
2. Confirm Basic is ₹299/month and Standard is ₹499/month.
3. Complete a Basic checkout and confirm AI endpoints return `403`.
4. Complete a Standard checkout and confirm AI reports and message drafting are enabled.
5. Schedule cancellation from organization billing settings and confirm access remains until the cycle end.
6. Confirm the cancellation webhook changes the subscription to cancelled and access falls back to Basic.

## Reviewer access

If Razorpay requests login credentials, create a dedicated Clerk account containing demo-only organization, branch, student, and payment data. Share those credentials only through Razorpay onboarding or another private channel; never commit them to the repository.
