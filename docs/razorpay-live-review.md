# Razorpay live-review checklist

Do not request Live review or enable Production billing until the isolated Preview Test Mode acceptance and controlled Live canary in `docs/workspace-billing-rollout.md` pass.

## Public website

Verify these routes return `200` without Clerk authentication and remain linked in the public footer, sitemap, and robots allow-list:

- `/privacy`
- `/terms`
- `/refund-policy`
- `/shipping-delivery-policy`
- `/contact`

The Contact page must display the exact business/operational address supplied in Razorpay KYC. `NEXT_PUBLIC_BUSINESS_ADDRESS` cannot be empty, “available on request,” or another placeholder. Also confirm the monitored support email, one-business-day response time, billing/refund instructions, and Lab Lords brand name.

Pricing must show only:

- Basic: ₹299 per billable branch per month.
- Standard: ₹499 per billable branch per month.

Both plans include student records/import, seats/shifts/allocations, payments/dues/history, and separately billed multiple branches. Standard adds staff invitations and permission controls, advanced branch/cross-branch analytics, and AI insights/reports/message drafting. The 30-day Standard trial starts after first-branch onboarding, requires no card, is shared by all branches, and is granted only once per owner.

## Checkout, saved cards, and OTP copy

Initial authorization and recovery Checkout must set `remember_customer: false`. In Razorpay Dashboard, disable Flash Checkout and Quick Buy in both Test and Live Mode. This prevents Lab Lords from asking Razorpay to save the card for later selection; the recurring subscription mandate itself remains available for provider-initiated charges.

Keep billing phone and email editable. They are Checkout contact and notification defaults, not proof of the contact registered with a card. Before Checkout, tell the customer:

- Lab Lords does not know or control the card-registered phone.
- The issuer/bank sends the required 3-D Secure authorization OTP to the mobile, email, or device registered with that card.
- A skippable “Securely saving your card” OTP is Razorpay saved-card/contact verification, not the issuer's mandatory card-authorization OTP.
- Test Mode authentication is simulated and sends no real SMS.
- Razorpay may make a temporary ₹5 verification charge that it automatically refunds; the plan fee starts only on the provider-confirmed charge date.

Confirm the skippable saved-card OTP screen no longer appears after disabling the Dashboard features and deploying `remember_customer: false`. If it still appears, capture the Razorpay payment/subscription IDs and screen recording and open a Razorpay support case; do not replace the Checkout contact with a guessed “card phone,” because merchants cannot read that value.

A `billingPlan` query may highlight a plan and open the Lab Lords confirmation sheet only. It must never create a subscription or open Razorpay until the owner explicitly confirms.

## Razorpay account settings

Configure settings independently in Test and Live Mode:

- Subscription payment methods: Card enabled; UPI and eMandate disabled for V1.
- Flash Checkout: disabled.
- Quick Buy: disabled.
- Test and Live webhook endpoints use different secrets.

Webhook events:

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

Do not select `subscription.expired`. Verify a signed delivery receives `2xx` and produces one idempotent receipt before acceptance. Invoice-only events must resolve their subscription/payment IDs and reconcile provider state. Frontend success and `subscription.activated` alone never advance `paidThrough`.

## Test Mode acceptance

Use the isolated Preview database, Test credentials, and a restricted Clerk QA account containing demo data only.

1. Confirm the four-step onboarding flow stores the selected post-trial plan and starts one owner trial without opening Checkout.
2. Confirm Standard trial access, exact end date, ₹0 plan fee today, projected branch quantity/total, authorization state, and provider-confirmed first charge date semantics.
3. Authorize Basic and Standard with card-only Checkout; verify Checkout contact remains editable and the saved-card OTP screen is absent.
4. Decline authorization, close Checkout without an attempt, retry with another card, delay the callback, and complete via signed webhook. Existing trial/current entitlement must remain unchanged until confirmation.
5. Confirm Basic direct calls to Standard analytics/staff/AI APIs return `403`; Standard succeeds when the role also permits it.
6. Test a paid Basic→Standard upgrade and branch quantity increase. No second Checkout should open; pending branches activate only after server provider-fetch or signed-webhook confirmation.
7. Test scheduled downgrade, branch reduction, cancellation, and Undo before the cutoff.
8. Test renewal `PENDING`, `HALTED`, update-card recovery, and full-access restoration only after captured payment/paid invoice advances `paidThrough`.
9. Replay callbacks and webhooks out of order and confirm one invoice/history/activation effect.
10. Invoke the protected Preview billing cron manually. Vercel schedules crons only on Production deployments.

Run and retain results for Prisma validation/migration status, full Vitest, lint, production build, authenticated desktop/mobile Playwright, Test Mode lifecycle, and signed webhook reconciliation.

## Production release evidence

Before the first Live authorization, the held Production preflight must prove:

1. Production `SaasRazorpayPlan`, current subscriptions, offers, and provisioning records contain no `TEST` row.
2. The Live provider catalog is empty, so the first Production authorization must provision a new Live ₹299 or ₹499 plan.
3. Preview and Production database fingerprints differ.

After the controlled authorization, rerun the preflight with the returned Live `plan_...` ID in Production and forbid that ID in Preview. This proves:

4. The Live plan returned by Razorpay is stored and provider-fetchable in Production only.

Also retain evidence of a signed Live webhook `2xx`, completed processing page, correct quantity and charge date, `paidThrough` behavior, cancellation, recovery, and successful Production hourly cron invocation.

## Reviewer access

Create a dedicated restricted Clerk reviewer account only if Razorpay requests login credentials. Include demo-only organization, branch, student, and payment data. Share credentials privately through Razorpay onboarding or another approved private channel; never commit them, place them in logs, or include them in a pull request.
