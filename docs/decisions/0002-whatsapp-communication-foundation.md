# 0002: WhatsApp communication foundation and customer-owned Meta assets

- Status: Proposed
- Date: 2026-08-23
- Deciders: Pending
- Supersedes: None
- Superseded by: None

## Context

Lab Lords needs a safe foundation for future WhatsApp communication without
turning an integration/onboarding release into a message-delivery or customer-
billing release. A Meta connection crosses several trust and cost boundaries:
browser-delivered IDs and events are untrusted, Meta owns provider truth, tenant
isolation is application-enforced, provider mutations can complete after a
timeout, webhook delivery is replayed, and a delivered message could incur a
customer charge.

Existing `MessageDraft` records are AI-assisted, human-reviewed copy. They do
not carry consent, provider sender/template identity, scheduling, idempotency,
delivery history, or provider cost and therefore cannot safely become an
outbox. Customer Meta assets must also remain portable rather than becoming Lab
Lords property.

This proposal records the intended boundary for the implemented foundation. It
does not approve a real provider connection, Preview/Production setup, or
message delivery.

## Decision

- Use the official Meta WhatsApp Cloud API directly through a narrow bounded
  server client. Do not use unofficial WhatsApp Web/browser automation.
- The customer owns its WABA, phone number, Meta business identity, payment
  method, provider billing, charges, and portable provider assets. Lab Lords
  receives only the delegated access needed to operate the integration. It does
  not share a credit line, assign extended credit, absorb customer usage, or
  rebill Meta delivery.
- Represent each connected sender as organization-owned application state.
  Support several senders per organization, several same-organization branches
  per sender, and zero or one assignment per branch. Branch assignment does not
  enable automation.
- Use one server-controlled Facebook JavaScript SDK/Embedded Signup
  configuration ID, fixed `sessionInfoVersion: "3"`, and an explicitly pinned
  Graph version. Customers cannot select any of these values. Browser business,
  WABA, phone, code, state, and session values are untrusted hints. The server
  validates the expected Meta app/scopes, resolves the authorized WABA, and
  verifies provider-authoritatively that the phone belongs to it. Operators
  must reverify the configuration and session-info contract against current
  official Meta requirements before external setup.
- Keep the configured Lab Lords system-user credential globally server-only.
  Do not persist a customer's OAuth code or access token. Exchange and use the
  one-time signup credential only for bounded asset proof, then discard it.
  App secret, verification token, system-user token, registration PIN, raw
  signup session, and raw webhook body are neither persisted nor logged.
- Fence connection completion with a short database claim/lease, make provider
  calls outside transactions, and finalize only after rechecking owner,
  organization, entitlement, writable state, mode, release gates, and lease
  ownership. Query provider state before a system-user assignment, WABA app
  subscription, or phone registration and refetch after an ambiguous outcome;
  never blindly repeat a provider mutation.
- Persist provider-authoritative template metadata through a bounded complete
  sync. Meta templates are read-only in this release. Future delivery must use
  reviewed approved templates rather than arbitrary browser content.
- Verify Meta webhooks over exact bounded raw bytes and persist mode-bound
  replay-safe receipt metadata before acknowledgement. Unknown signed assets
  reveal no tenant existence. The foundation does not interpret inbound
  messages or delivery statuses into product actions.
- Add consent current/history, durable message/outbox, message-event, webhook-
  receipt, and WhatsApp audit schema. Consent starts unknown. The outbox is an
  empty foundation with unique dedupe/lease/provider identity and cost micros;
  no PR2 application path creates a message row.
- Keep AI drafts separate and human reviewed. AI cannot choose a provider
  action, select an automatic message, or cause an external send.
- PR2 intentionally has no Meta `/messages` call, send client method, API,
  dispatcher, planner, cron, test-send UI, automatic reminder, or credit/billing
  path. Connection correctness, tenant/secret boundaries, migrations, App
  Review, consent/legal policy, provider observability, and cost controls must
  be validated before delivery is designed.
- Any future message delivery requires a separate architectural/security/legal
  review, explicit consent/template/idempotency rules, provider-status
  projection, cost/budget semantics, operational monitoring, and an independent
  fail-closed release gate. Enabling the connection gate must never implicitly
  enable delivery.

## Alternatives considered

- **Unofficial WhatsApp Web automation:** rejected because it relies on browser
  session emulation, weakens customer ownership and provider assurance, and can
  create account-ban, security, and operational risk.
- **A BSP owns or intermediates every customer sender:** can reduce provider
  integration work but adds another processor, portability and billing
  boundary. Direct official Meta integration keeps the selected foundation
  narrow; a future BSP would require its own decision.
- **Lab Lords-owned WABA, phone, payment method, or shared credit line:** rejected
  because it transfers customer assets and message charges to Lab Lords,
  complicates exit/portability, and creates unacceptable credit and abuse risk.
- **Persist each customer's long-lived access token:** rejected because it
  expands credential storage, rotation, tenant-compromise, and incident scope.
  A single approved server-side system-user credential plus one-time customer
  authorization proof is the chosen boundary.
- **Trust Embedded Signup IDs and finalize synchronously:** rejected because a
  hostile browser can invent IDs and a serverless request/provider mutation can
  time out after committing. Provider-authoritative reads plus claim/provider/
  finalize leasing make ownership and replay explicit.
- **Reuse `MessageDraft` as the outbox:** rejected because reviewable AI copy is
  not provider/consent/payment/delivery truth and lacks durable idempotency and
  status evidence.
- **Ship onboarding and sending together:** rejected because it would couple
  asset verification, App Review, consent, delivery charges, status ordering,
  automation policy, and rollout into one irreversible risk surface. The empty
  schema foundation makes the boundary inspectable first.

## Consequences

Customers retain ownership and provider billing while Lab Lords accepts the
operational burden of an official app, Business verification, App Review/
Advanced Access, Embedded Signup, global system-user rotation, callback
availability, provider reconciliation, Test/Live isolation, and incident
response. One WABA can safely contain several numbers and one sender can serve
several branches without converting a branch ID into provider authority.

The schema is larger before delivery exists. That is deliberate: later work can
refer to stable consent, template, outbox, event, receipt, and audit identities
without breaking permission or data shape, while cost-bearing behavior remains
absent. These tables and a green connection state do not constitute consent,
automation, or a promise that a message can be delivered.

Meta's APIs, Graph versions, permissions, App Review rules, response fields,
and account modes can change. The provider client pins and validates its
version/origin/schema, but operators must reverify current official primary
sources before setup. Provider outage or ambiguous state may leave an intent
failed while a remote assignment/subscription/registration succeeded; recovery
is reconciliation and safe forward correction, not blind retry.

## Security and data impact

Meta Graph, the Facebook JavaScript SDK/postMessage flow, and the public webhook
are new external trust boundaries. Only authenticated organization owners may
own provider configuration changes; branch permission does not grant provider
ownership. Both sides of every branch assignment are tenant-scoped. Connection
state is random, hashed, expiring, actor-bound, and leased. Test and Live assets,
credentials, rows, and webhooks are isolated and all flags fail closed.

The database stores bounded provider identifiers and normalized metadata, not
credentials or raw provider payloads. Signed webhook receipts retain hashes and
bounded routing metadata without raw body, message text, or student data.
Consent remains unknown until an explicit trusted change, and immutable history
survives local disconnect. Foreign phone/WABA conflicts and unknown signed
assets return generic outcomes.

The principal cost control is capability absence: no delivery or credit method
exists, so normal PR2 behavior cannot incur a per-message Meta charge. Future
delivery must preserve customer-owned billing, rate precision in currency
micros, purpose/template/consent constraints, durable dedupe/lease behavior,
and a separately operable kill switch.

## Rollout and rollback

1. Merge/deploy with all WhatsApp flags absent or false after explicit
   `SECURITY.md` review and this proposal's owner review.
2. Verify ordinary application paths remain healthy and do not touch the new
   tables while flags are off.
3. Run the documented read-only row-count/metadata preflight, apply the additive
   migration through the protected operator path, and confirm existing counts
   are unchanged and all ten WhatsApp tables are empty.
4. Keep every flag false. Configure no real customer asset or Production
   webhook as part of the schema/application release.
5. Validate a dedicated Test app/WABA/phone, callback, signatures, replay,
   owner/tenant gates, provider reconciliation, and empty message tables only in
   a separately approved Preview operation.
6. Any Live onboarding begins with one exact Production canary after App Review,
   customer-owned billing proof, monitoring, incident ownership, and explicit
   operator approval. Message delivery remains unavailable.

Rollback first deploys with integration/onboarding/webhook flags held and
allows in-flight provider requests to settle. Do not drop sender, template,
consent, receipt, or audit evidence and do not interpret local disconnect as
provider rollback. Before any WhatsApp row exists, a separately reviewed
schema-only rollback may be possible. After data exists, preserve history and
prefer a compatible forward fix; destructive schema/provider changes require
exact affected-row inspection and separate human approval.

## Evidence

- [Meta official WhatsApp Business Platform Postman workspace](https://www.postman.com/meta/whatsapp-business-platform/overview)
- [Meta official Embedded Signup collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup)
- [Meta official tech-provider sample](https://github.com/fbsamples/business-messaging-sample-tech-provider-app)
- [Meta official Node.js Business SDK releases](https://github.com/facebook/facebook-nodejs-business-sdk/releases)
- `prisma/schema.prisma`
- `prisma/migrations/20260822120000_whatsapp_communication_foundation/migration.sql`
- `lib/metaWhatsApp.ts`
- `lib/whatsappFeature.ts`
- `services/whatsappConnection.service.ts`
- `services/whatsappSender.service.ts`
- `services/whatsappTemplate.service.ts`
- `services/whatsappWebhook.service.ts`
- `docs/domain-invariants.md`
- `SECURITY.md`
- `docs/production-runbook.md`

Repository evidence does not prove any real Meta credential, app permission,
Embedded Signup, WABA/phone connection, webhook delivery, customer billing
setup, Preview/Production deployment, or applied external migration.

## Approval

Pending explicit human-owner review. This proposal is not binding, must not be
marked Accepted by an automated agent, and does not approve provider setup or
message delivery.
