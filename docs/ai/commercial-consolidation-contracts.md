# Commercial execution contracts

Local implementation, September 5. No Production/provider action is authorized
by this inventory. Billing maintainers own the remaining historical boundary.

| Surface | Execution and retained purpose |
| --- | --- |
| New organization/first branch | OnboardingService only; explicit WORKSPACE_V2, selected plan and atomic owner trial grant. Disabled release flag blocks creation. Old organization POST stays a 410 tombstone. |
| Removed dispatcher | `isWorkspaceBillingEnabledFor` had no production callers; removed with its obsolete unit test. The onboarding release switch remains. |
| Cancellation | `BillingService.requestCancellation` replaces both cancellation entry points and updates the route/callers. One enqueue/process protocol. Historical immediate scheduling and current undo cutoff remain policy differences. |
| Historical runtime policy | `legacyCommercialCompatibility.ts` owns fallback entitlement/profile, billing experience and cancellation policy. It performs no creation, authorization or provider dispatch. |
| Historical quantity/identity | Initial checkout/provisioning keeps quantity one for old commercial records; V2 uses active branch count. Frozen commercial-version identity is still checked during recovery. |
| Historical maintenance | `legacyPaidEntitlementTransition`, `legacyUnsupportedMethodAudit`, rollout policy and their three CLI tools retain invoice/provider mappings, evidence repair, audit and reviewed promotion. They are not alternate checkout engines. |
| Schema/API history | LEGACY/LEGACY_TRANSITION enums and DTO fields remain to interpret historical rows, reconciliation, deadlines and transition operations. Import V1 and WhatsApp legacy payload compatibility are unrelated to SaaS billing versions. |

| Provider action | Durable owner/intent before common dispatch | Evidence/finalization |
| --- | --- | --- |
| Initial create | Initial provisioning immutable tuple + organization lease; purpose CREATE | Exact discovery/current read, initial finalizer |
| Replacement create | Replacement version-2 tuple + processing attempt/lease; CREATE | Exact discovery/binding and replacement finalizer |
| Plan/quantity/cancellation | BillingMutation enqueue + immutable commercial intent/attempt/lease; MUTATE | Exact mutation expectation, paid evidence or scheduled state |
| Scheduled undo | Claimed scheduled undo and fresh pending-state checks; UNDO_SCHEDULE | Exact undo finalizer |
| Candidate cancellation | Candidate slot/cleanup intent and attempt/lease; CANCEL_CANDIDATE | Terminal candidate identity and slot finalizer |
| Source cancellation | Healthy viable replacement, exact boundary/source identity, independent admission; CANCEL_SOURCE | Source-specific confirmed response or terminal source read; candidate evidence cannot resolve it |
| Initial authorization expiry | Existing scoped subscription + expiry checks + organization lease; EXPIRE_INITIAL | Terminal provider identity and ownership-checked local expiry |

All ten call sites dispatch through `executeBillingProviderAction`. Its key is
operation identity plus purpose, and its request/hash/mode/identity are immutable
in PostgreSQL. Each action commits ADMITTED before external I/O. ADMITTED/UNKNOWN
cannot be taken over or replayed because time elapsed or a new client key arrived.
A definitely rejected request can retry the identical intent. CONFIRMED stores
the provider response independently of domain finalization; it does not grant
paid access. Domain reconcilers acknowledge only their exact action after their
existing provider-evidence and ownership checks. Uncertain actions block other
dispatch for the organization. No database transaction spans the provider call.

`getRazorpayClient` excludes subscription mutation methods; the mutation factory
is restricted to the executor by an AST architecture test. Plan-catalog creation
retains its separate durable global catalog protocol and a narrowed catalog
client; creating a plan is not changing an organization's subscription. The
read-only methods preflight and application HTTP helpers are explicit test
exceptions, not provider dispatch paths.

Reviewed official [create](https://razorpay.com/docs/api/payments/subscriptions/create-subscription/),
[update](https://razorpay.com/docs/api/payments/subscriptions/update-subscription/)
and [scheduled-update undo](https://razorpay.com/docs/api/payments/subscriptions/cancel-update/)
documentation. Request shapes and provider lifecycle policy are unchanged. No
provider-native subscription idempotency guarantee is assumed.

Final historical retirement is evidence/approval-gated: inventory every LEGACY
organization, legitimate data/access, current and archived subscriptions, exact
invoice/payment evidence, provider mode/customer/subscription IDs, transition
history and unresolved operations. Every organization needs an approved
preservation/promotion disposition, reconciled provider obligations and no old
workers. Removing a runtime branch does not delete enums, external accounts or
evidence needed for recovery. A fresh database cannot substitute for this work.
