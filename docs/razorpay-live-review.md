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

## Checkout, mandates, saved cards, and OTP copy

Initial authorization and recovery Checkout must set `remember_customer: false`. In Razorpay Dashboard, disable Flash Checkout and Quick Buy in both Test and Live Mode. This prevents Lab Lords from asking Razorpay to save the card for later selection; the recurring subscription mandate itself remains available for provider-initiated charges.

Keep billing phone and email editable. They are Checkout contact and notification defaults, not proof of the contact registered with a card, bank account, or UPI app. When the multi-method flag is enabled, omit the card-only Checkout display configuration and allow Razorpay to show only the recurring methods eligible for that account, amount, bank/app, and device.

For UPI AutoPay, verify mobile app Intent and desktop QR paths in Standard Checkout; do not collect or trust a VPA in Lab Lords. For eMandate, explain that authorisation can use netbanking, debit card, or Aadhaar and may remain in `CREATED` while the bank completes setup. No paid access or `paidThrough` advancement follows from browser success alone.

Only when Card is selected, tell the customer:

- Lab Lords does not know or control the card-registered phone.
- The issuer/bank sends the required 3-D Secure authorization OTP to the mobile, email, or device registered with that card.
- A skippable “Securely saving your card” OTP is Razorpay saved-card/contact verification, not the issuer's mandatory card-authorization OTP.
- Test Mode authentication is simulated and sends no real SMS.
- Razorpay may make a temporary ₹5 verification charge that it automatically refunds; the plan fee starts only on the provider-confirmed charge date.

Confirm the skippable saved-card OTP screen no longer appears after disabling the Dashboard features and deploying `remember_customer: false`. If it still appears, capture the Razorpay payment/subscription IDs and screen recording and open a Razorpay support case; do not replace the Checkout contact with a guessed “card phone,” because merchants cannot read that value.

A `billingPlan` query may highlight a plan and open the Lab Lords confirmation sheet only. It must never create a subscription or open Razorpay until the owner explicitly confirms.

## Razorpay account settings

Configure and verify settings independently in Test and Live Mode:

- Subscription payment methods: Card, UPI AutoPay, and eMandate enabled. Netbanking is an eMandate authorisation route, not a separate one-time rail.
- Account approval: the account-specific Methods API and Standard Checkout both expose the expected recurring capabilities.
- Dynamic eligibility: use the Methods API for current recurring card/eMandate catalogs and Razorpay Checkout for UPI, amount, and device eligibility; do not maintain bank/app lists in Lab Lords.
- UPI presentation: mobile Intent and desktop QR complete successfully for an eligible Test amount.
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
- `subscription.paused`
- `subscription.resumed`
- `subscription.cancelled`
- `subscription.completed`
- `invoice.paid`
- `invoice.partially_paid`
- `payment.authorized`
- `payment.captured`
- `payment.failed`

Do not select `subscription.expired`. Verify a signed delivery receives `2xx` and produces one idempotent receipt before acceptance. The endpoint must reject declared and streamed bodies above 512 KiB with `413`, authenticate exact bytes before parsing, reconcile only once for simultaneous same-body deliveries, acknowledge the nonowner as in progress, reclaim an expired claim, and reject same-ID/different-body collisions. Invoice-only events must resolve their subscription/payment IDs and reconcile provider state. Frontend success and `subscription.activated` alone never advance `paidThrough`.

## Test Mode acceptance

Use the isolated Preview database, Test credentials, and a restricted Clerk QA account containing demo data only.

1. Confirm the four-step onboarding flow stores the selected post-trial plan and starts one owner trial without opening Checkout.
2. Confirm Standard trial access, exact end date, ₹0 plan fee today, projected branch quantity/total, authorization state, and provider-confirmed first charge date semantics.
3. Authorise Basic and Standard with Card, UPI AutoPay, and eMandate. Verify Razorpay—not a Lab Lords selector—controls eligible method visibility; test UPI mobile Intent, desktop QR, and delayed eMandate activation.
4. Decline authorisation, close Checkout without an attempt, retry with another eligible method, delay the callback, and complete via signed webhook. Existing trial/current entitlement must remain unchanged until mandate confirmation. Card contact remains editable and the saved-card OTP screen is absent.
5. Confirm Basic direct calls to Standard analytics/staff/AI APIs return `403`; Standard succeeds when the role also permits it.
6. Confirm Card plan/quantity changes still use provider PATCH. Confirm UPI/eMandate upgrade, downgrade, quantity change, and proactive payment-method switch create one authorised replacement with a boundary at least seven days away.
7. Verify upgrades and branch additions receive complimentary access only after candidate mandate confirmation while canonical billing remains on the old subscription. Verify downgrades and branch removals do not apply early, and Undo works until 72 hours before cutover.
8. Test candidate failure/undo, old-subscription cancellation retry, duplicate events, orphan adoption after response loss, overlapping-charge manual review, atomic cutover, and the three-day eMandate bank-confirmation grace. Do not expect an automatic refund.
9. Test renewal `PENDING`, `PAUSED`, `HALTED`, hosted mandate recovery, Card fallback recovery, and full-access restoration only after captured payment/paid invoice advances `paidThrough`.
10. Replay callbacks and webhooks out of order, race two identical signed deliveries, reclaim one deliberately expired Test claim, and confirm one provider reconciliation plus one invoice/history/activation effect. Confirm a stale token cannot finalize its successor.
11. Run the enabled preflight with Subscription settings, UPI Intent, UPI QR, webhook, and amount evidence flags; retain its aggregate account Methods API report.
12. Invoke the protected Preview billing cron manually. Vercel schedules crons only on Production deployments.

Run and retain results for Prisma validation/migration status, full Vitest, lint, production build, authenticated desktop/mobile Playwright, Test Mode lifecycle, and signed webhook reconciliation.

## Production release evidence

Before the first Live authorization, the held Production preflight must prove:

1. Production `SaasRazorpayPlan`, current subscriptions, offers, and provisioning records contain no `TEST` row.
2. The Live provider catalog is empty, so the first Production authorization must provision a new Live ₹299 or ₹499 plan.
3. Preview and Production database fingerprints differ.
4. The account-specific Methods API is reachable with the Live Key ID and reports current recurring Card/eMandate capabilities plus UPI account availability. Dashboard evidence confirms Card, UPI AutoPay, eMandate, UPI Intent/QR, required webhooks, and tested amount eligibility.

After the controlled authorization, rerun the preflight with the returned Live `plan_...` ID in Production and forbid that ID in Preview. This proves:

5. The Live plan returned by Razorpay is stored and provider-fetchable in Production only.

Also retain evidence of a signed Live webhook `2xx`, completed processing page, correct quantity and charge date, `paidThrough` behavior, replacement/cutover, pause/resume, cancellation, hosted recovery, and successful Production hourly cron invocation.

The release order is: place Razorpay webhook ingress on an operator-owned hold and prove every old-deployment webhook request has terminated; deploy and verify the additive receipt-claim migration; promote the new token-fenced code with the multi-method flag off; verify a signed canary and reconcile the held interval before releasing ingress; have an authorized operator pause the Production hourly billing cron through the approved Vercel control and drain mutation leases; audit legacy unsupported-method cancellations against the explicitly bound, verified target; enable and validate all three methods in Test Mode; run one allowlisted Live workspace; then enable the application flag broadly only after reconciliation is clean. Never overlap the old unfenced webhook worker with the new worker merely because both versions accept the expanded schema. Preview has no automatic cron worker. Any ambiguous provider state or overlapping charge goes to manual review, never an automatic refund.

## Reviewer access

Create a dedicated restricted Clerk reviewer account only if Razorpay requests login credentials. Include demo-only organization, branch, student, and payment data. Share credentials privately through Razorpay onboarding or another approved private channel; never commit them, place them in logs, or include them in a pull request.
