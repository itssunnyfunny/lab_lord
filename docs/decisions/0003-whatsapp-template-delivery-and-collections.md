# 0003: Managed WhatsApp Utility delivery and collections automation

- Status: Accepted
- Date: 2026-08-23
- Deciders: itssunnyfunny (human repository owner)
- Approval date: 2026-08-24
- Supersedes: None
- Superseded by: None

## Context

ADR 0002 proposed an official, customer-owned Meta sender foundation and
deliberately excluded message delivery. Lab Lords now needs a narrow first
customer workflow for reviewed payment reminders and prospective deterministic
collections automation. A provider message can incur a customer charge, reveal
student/payment context to Meta, arrive out of order, and be accepted even when
the application loses the response. Tenant isolation is application-enforced,
phone-scoped consent alone does not prove which student may use that phone, and
Meta message submission supplies no application idempotency key.

This decision builds on but does not supersede ADR 0002, which remains Proposed.
Human-owner acceptance of this ADR does not approve App Review, legal/privacy
policy, a rate card, real provider setup, Preview/Production migration, or Live
delivery.

## Decision

### Capability and content boundary

- Add exactly two PR3 provider writes to the narrow official Meta client:
  controlled creation of a Lab Lords-managed template at
  `POST /{WABA_ID}/message_templates`, and one approved individual template send
  at `POST /{PHONE_NUMBER_ID}/messages`.
- Use a versioned code catalogue with deterministic provider name, language,
  category, typed variable order/bounds, synthetic samples, preview renderer,
  canonical component hash, and exact quick-reply payload. V1 supports only
  official language codes `en_IN` and `hi`; it does not invent `hi_IN` or a
  Hinglish provider language.
- Template creation hardcodes `UTILITY`. Delivery requires the current provider
  template and active binding to be `APPROVED` and `UTILITY` with the exact
  catalogue key/version/hash. Provider rejection, pending state, marketing or
  authentication category, pause, disablement, staleness, or incompatible
  content blocks sending and suppresses safe unsubmitted messages.
- Do not add free-form or user-authored provider text, arbitrary recipient,
  template, language or component input, media, marketing, authentication/OTP,
  payment links, chat/replies, daily reports, service notices, broadcasts,
  credit sharing, provider billing aggregation, or a generic `/messages` proxy.
  AI `MessageDraft` content remains human-reviewed copy/open-WhatsApp output and
  cannot reach official delivery.

### Tenant, recipient, consent, and payment truth

- The organization owns the sender; owner-only actions connect/register it,
  assign it, and install managed templates. Branch permissions separately govern
  recipient/settings (`manage_whatsapp`), manual sends (`send_whatsapp` plus
  payment visibility), and history (`view_whatsapp`). Entitlement and branch
  writability are independent checks.
- Add an explicit student-recipient association that ties one organization,
  branch, student, assigned sender, exact normalized current phone, relationship,
  and operational consent. Consent remains unique by sender/phone/type, begins
  `UNKNOWN`, records a versioned policy statement, and changes with append-only
  evidence. Existing students are not opted in. Several students may share one
  guardian phone, but a phone change or student reactivation never transfers or
  restores consent/mapping automatically.
- Treat `Payment`, its typed identity, and immutable
  `PaymentResolutionEvent` as the only financial truth. Browser input may select
  bounded payment IDs, but the server resolves branch, student, recipient,
  current phone, amount, due date, template, variables, and status. Messaging and
  inbound `PAID` claims never create, resolve, waive, or mark a payment paid.
- Use the narrow `WhatsAppMessagePayment` join for every payment represented by
  a grouped reminder. Keep the existing nullable single `paymentId` and
  `paymentResolutionEventId` snapshots for compatibility/history; the join does
  not create a new payment aggregate or weaken tenant checks.

### Outbox, frequency, and estimated cost

- Extend the single `WhatsAppMessage` outbox rather than creating a second queue.
  Store trusted catalogue, source, schedule, trigger, configuration revision,
  lifecycle, frequency, provider, estimated-cost, and budget snapshots.
- Derive SHA-256 dedupe/frequency keys from stable business events, not cron
  invocations: sender/student welcome; sender/student/cycle/stage; grouped
  recipient/local-date/stage; payment-resolution event; or manual request/group.
- Manual preview is read-only. Manual commit binds a bounded idempotency key to a
  canonical request hash, revalidates eligibility, and atomically creates the
  request, grouped messages, payment joins, frequency reservations, and estimated
  budget reservation. Same key/same content replays; different content conflicts.
- Branch budget is an owner-controlled monthly paise ceiling. Per-message and
  aggregate estimates use `BIGINT` INR micros from an explicitly configured
  versioned rate card and effective UTC time. V1 may estimate `+91` recipients
  only. The estimate is not Meta's invoice; signed status metadata supplies no
  exact charged amount, so `actualCostMicros` remains null.

### Automation and dispatch

- Separate delivery enablement from automation activation. Store deterministic
  stage rules, local send time, daily/cycle limits, configuration revision, and
  `automationEnabledAt`. Automation is prospective: existing students are
  `LEGACY`, imports are `IMPORT`, and only a qualifying `MANUAL` enrollment after
  activation can receive welcome automation. Do not blast historical students,
  dues, or payment-resolution events.
- Branch delivery disable atomically cancels every safely unsubmitted manual and
  automatic message and releases `RESERVED` budget, preventing an old manual
  batch from sending after re-enable. Automation-only disable cancels automatic
  rows only. Both preserve message/event rows and accepted/ambiguous history.
- The planner is a machine-authenticated, bounded, tenant-scoped, idempotent
  local process. It leases one branch configuration, rechecks entitlement and
  current rules/sources, and creates outbox/budget reservations only. Cron
  authentication does not bypass eligibility and planning never calls Meta.
- No provider call occurs inside a student, payment, consent, recipient,
  settings, outbox, frequency, or budget transaction. Provider work follows:
  short database authorization/claim and validation; local commit; bounded Meta
  request; lease-fenced database finalization.
- The dispatcher claims a bounded fair batch and revalidates tenant, provider
  mode, integration/message flags, Live delivery canary, entitlement,
  writability, sender assignment, active mapping/consent, managed template,
  source payment/event, schedule/frequency, and reserved budget immediately
  before `SUBMITTING`. A success must contain exactly one bounded provider
  message ID. Definite rejection fails safely; bounded rate-limit retries remain
  lease-owned.
- A timeout, connection loss, provider `5xx`, or invalid success body may have
  been accepted. Set `UNKNOWN`, commit the estimated budget, do not retry
  automatically, and require human review. A stale `SUBMITTING` lease follows
  the same rule. Only a stale pre-submission claim may return to the queue, and a
  stale worker cannot finalize state owned by a newer lease.

### Webhooks and opt-out

- Extend the one signed public webhook. Verify HMAC over exact bounded raw bytes,
  persist and lease the replay-safe receipt, append deduplicated provider events,
  and project sent/delivered/read/failed using provider time and precedence
  without regression. Retain bounded orphan status events that arrive before API
  finalization and attach them when the provider message ID becomes known.
- Store optional bounded provider recipient, billable, and category values only
  when the current signed schema supplies them. `pricing_model` or `type` may be
  present in provider metadata but none of these values is an exact charge. Do
  not infer cost or retain raw provider error text.
- Only normalized inbound text exactly `STOP`, or quick-reply payload exactly
  `LABLORDS_STOP_UPDATES`, opts the sender/phone out. The operation is replay-
  safe, changes only real consent transitions across all consent types, disables
  mappings, cancels/suppresses future unsubmitted messages, preserves accepted
  history, stores no raw body/text, sends no automatic reply, and never changes a
  payment. `START`, `PAID`, and natural-language phrases are not commands.

### Ownership and release controls

- Preserve customer ownership of WABA, number, business assets, payment method,
  and Meta charges. Lab Lords neither funds nor re-bills usage and never shares
  credit.
- Keep integration, onboarding writes, template writes, message writes,
  automatic planning, webhook ingestion, onboarding Live canary, and delivery
  Live canary as separate fail-closed controls. Disabling a flag preserves
  provider IDs, queue, budget, consent, receipts, and history.
- Production use requires current official Meta verification, App Review and
  Advanced Access for `whatsapp_business_management` and
  `whatsapp_business_messaging`, a stable callback, customer-owned billing,
  monitoring and a human `UNKNOWN` queue, rate-card ownership, support/incident
  procedures, and separate human legal/privacy approval. `business_management`
  is requested only if separately approved portfolio operations require it.

## Alternatives considered

- **Free-form or arbitrary template sends:** rejected because browser/user text
  cannot prove policy category, bounded variables, consent purpose, or cost.
- **AI-generated external content:** rejected because model output is untrusted
  and cannot select a financially sensitive external action.
- **Unofficial WhatsApp Web automation:** rejected for credential/session,
  account-ban, provider-policy, ownership, and reliability risk.
- **Lab Lords credit sharing or provider rebilling:** rejected because the
  customer must own payment, charges, portability, and abuse exposure.
- **Synchronous send in the user/domain transaction:** rejected because provider
  latency/ambiguity would hold locks and couple payment/student truth to an
  irreversible external action.
- **One Workflow/provider job per message:** rejected for V1 because the durable
  PostgreSQL outbox, leases, cron, and bounded dispatcher keep business truth and
  idempotency local with less external orchestration state.
- **Blind retry with a local idempotency key:** rejected because Meta message
  submission does not honor that key; a retry can duplicate a billable message.
- **Broad historical catch-up at activation:** rejected because old students,
  balances, and events were not collected under the prospective automation
  expectation and could create a costly message blast.

## Consequences

The design makes recipient, consent, content, schedule, source, frequency,
budget, delivery, and opt-out evidence inspectable and preserves customer-owned
billing. It supports grouped guardian reminders without turning one nullable
payment link into aggregate truth. It also adds schema, feature flags, two cron
paths, template approval operations, rate-card maintenance, webhook ordering,
lease recovery, and human `UNKNOWN` review burden.

Estimated budget can conservatively hold money for an outcome that Meta did not
accept, because avoiding a duplicate paid message takes priority over automated
release. Provider template policy/category, rate limits, languages, prices, and
permissions can change independently of code; operators must reverify them and
update the reviewed catalogue/rate card through a new release or configuration
decision.

## Security and data impact

Meta receives only the managed template and typed values required for an
explicitly mapped/consented recipient. The browser never supplies final provider
payload values. Tenant joins remain application-enforced and therefore require
service-layer cross-checks at queue and send time. Secrets, raw webhooks, inbound
text, arbitrary provider errors, AI output, and unnecessary personal data are
excluded from storage/logging.

The public webhook is an attacker-controlled bounded parser after raw-byte HMAC.
Cron bearer authentication is a machine boundary, not tenant/provider authority.
Provider calls occur after local commit, and leases prevent stale finalization.
Append-only event/consent/audit evidence and non-destructive disable/disconnect
paths support investigation without erasing accepted or ambiguous outcomes.

## Rollout and rollback

1. Merge only after documented human-owner approval of `SECURITY.md` and this
   ADR, with every WhatsApp flag false and both canaries empty. Do not promote
   the PR3 application against the PR2 schema: ordinary student queries require
   the new `enrollmentSource` column even when WhatsApp is held.
2. With the previously compatible application serving, run the documented
   read-only preflight, establish the approved deployment/traffic hold, apply
   and verify the additive PR3 migration, and require unchanged existing
   counts, `LEGACY` students, empty new tables, no consent/automation/messages,
   and clean migration status. Only then promote the exact reviewed application
   commit and run ordinary plus flag-off smoke checks.
3. Configure isolated TEST assets only after callback, monitoring, rate-card,
   `UNKNOWN` review, and legal/privacy gates. Install/sync approved Utility
   templates, record one synthetic explicit consent, and validate one manual
   send plus signed status/STOP behavior while planning remains false.
4. A separate human approval may add one Live delivery canary. Begin with manual
   delivery, observe provider/cost/failure/unknown/opt-out evidence, then enable
   one prospective branch automation. Expand gradually; do not launch public
   pricing in this decision.

Containment deploys template/message/planner/onboarding writes false, clears both
canaries, and separately pauses the two WhatsApp schedules. Keep signed webhook
ingestion unless it is harmful. An application rollback does not undo provider
actions or the additive schema. Preserve `UNKNOWN`, provider IDs, budget,
messages/events, mappings, consent, receipts, and audit history; prefer compatible
forward repair. There is no automatic down migration, and destructive schema or
provider cleanup requires exact private inspection and separate human approval.

## Evidence

- [Meta message API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api)
- [Meta template API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api)
- [Meta WhatsApp permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/permissions)
- [Meta supported template languages](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages)
- [Meta pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- [Meta message-status webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status)
- [Meta error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)
- `prisma/schema.prisma`
- `prisma/migrations/20260823120000_whatsapp_template_delivery_and_collections/migration.sql`
- `lib/metaWhatsApp.ts`
- `lib/whatsappManagedTemplates.ts`
- `lib/whatsappFeature.ts`
- `lib/whatsappCost.ts`
- `lib/whatsappMessageState.ts`
- `services/whatsappTemplateProvisioning.service.ts`
- `services/whatsappRecipient.service.ts`
- `services/whatsappMessage.service.ts`
- `services/whatsappPlanner.service.ts`
- `services/whatsappDispatcher.service.ts`
- `services/whatsappWebhook.service.ts`
- `SECURITY.md`
- `docs/domain-invariants.md`
- `docs/production-runbook.md`

Repository evidence does not prove any real credential, permission, customer
asset, template approval/category, message/status/STOP delivery, provider charge,
rate-card correctness, legal compliance, Preview/Production deployment,
migration, schedule health, callback reachability, or Live canary.

## Approval

Accepted on 2026-08-24 by itssunnyfunny, the human repository owner, with
explicit approval of this decision and the accompanying `SECURITY.md` changes
for PR #265. This approval makes the architecture decision binding but does not
authorize real provider operations, Preview or Production migration, flag or
canary enablement, or rollout. Operations and legal/privacy gates remain
separate requirements.
