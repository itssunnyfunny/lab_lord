# Access and work ownership contracts

The canonical interactive policy is `services/accessPolicy.service.ts`.
`branchActionPolicy.ts` owns role defaults and explicit override precedence;
`lib/branchCapabilities.ts` owns feature requirements shared with UI gating.
Contexts contain database-derived actor, membership, scope and permissions, are
frozen, and must belong to a private WeakSet. A copied/client object is rejected.
Rechecking resolves current membership, overrides, entitlements and writability;
there is no global authorization cache. Authenticated actor IDs still originate
at the server auth boundary; a context is not a substitute for authentication.

| Callers | Canonical delegation / action difference |
| --- | --- |
| Organization settings/actions | OrganizationService owner projection delegates to AccessPolicy; writes require organization writability |
| Branch lifecycle/billing recovery | Ten owner-filtered reads delegate to AccessPolicy, including reads inside locked billing transactions. Recovery deliberately permits inactive/pending branches; domain billing checks still control dispatch |
| Students, seats, shifts, bundles, allocations, payments | StaffService authorization facade delegates role/entitlement decisions; adjacent write checks now use AccessPolicy in the same client/transaction. Student/payment/allocation object lookups map foreign membership to the same missing-resource error |
| Staff and invitations | One role/override implementation; staff mutations require staffManage; staff projection uses staffView, including entitlement for counts and identities |
| Analytics routes and direct interactive services | AnalyticsAccessService authorizes each invocation before calling the internal analytics read layer; architecture test prohibits route/action imports of raw analytics functions |
| AI routes and direct generation/draft services | aiUse permits entitled cached reads; aiGenerate requires writable access. Services require issued context and recheck before work. Permission denial protects the entire payload |
| Imports | ImportSession/Plan/Question/Run/Evaluation services use the shared boundary. The durable executor rechecks current actor permissions and branch writability inside the item transaction |
| Billing | OrganizationService owner-access facade delegates to AccessPolicy. Billing recovery does not require a currently paid workspace; provider evidence and immutable intent remain authoritative |

System ownership is explicit in existing machine entry points, not a fabricated
interactive context. Signed provider callbacks/webhooks, authenticated cron
routes and persisted Workflow run identities retain their distinct protocols.
Billing reconciliation is read-only toward the provider; any maintenance
subscription mutation uses BillingProviderAction. WhatsApp planning/sending
continues to enforce sender, consent, entitlements and prospective activation.
Import retention deletes staged data only, never domain targets or billing
access. Imports requested by users retain the persisted requesting actor and
recheck their permissions; a Workflow identity does not bypass them.

The daily dues cron's missing writability check remains the explicitly recorded
policy discrepancy in domain-invariants.md. This consolidation neither approves
an exception nor changes anniversary dues/later-month generation policy.

| Work | Stable identity and admission | Publication / cleanup fence | Replay / takeover evidence |
| --- | --- | --- | --- |
| AI report and draft generation | BranchGenerationLease `(branchId,kind)`; row lock, random token, lastStartedAt, leaseUntil; durable cooldown | publishGeneration locks lease and checks exact token plus live expiry; failure cleanup updateMany matches token | generation-ownership, generation-callers, generation-migration tests; six-minute takeover, late completion, failed publication and cached cooldown |
| SaaS actions | Organization lease + change attempt/start; BillingProviderAction semantic key, immutable request/hash, unique dispatchToken, ADMITTED committed before I/O | Provider response stored against action identity/token; domain finalizers separately check lease, attempt, exact mode/subscription/intent/provider evidence | billing-provider-action, billing-mutation, billing replacement tests; UNKNOWN blocks replay, CONFIRMED reused; source/candidate actions independent |
| Import mutations | ImportRun immutable plan/revision, unique item key; runner locks run/items, token and leaseUntil, bounded batch | Executor re-reads stored item, exact RUNNING/token, current plan/session/permissions; domain writes and success marker share Serializable transaction; fail/heartbeat/cleanup match token | import-runner, import-run-executor, import-commit-flow; SQL-injected completion failure rolls back mutation; workflow bounded-replay and retry-finalizer preserve successful progress |
| Import analysis | Session branch/revision plus analysisLeaseToken/analysisLeaseUntil; atomic conditional claim, five-minute expiry | Mapping publication locks session and matches token/revision; cleanup matches token/revision/ANALYZING. Superseded/busy attempts cannot publish run failure | import-analysis-ownership tests late success AND failure during newer attempt; import-analysis-replay checks one revision advancement; Workflow engine retained |
| WhatsApp inbound text | Sender + provider message ID receipt, inserted atomically with challenge/consent mutation | Transaction rollback removes both receipt and effects; committed receipt prevents later modified-payload redelivery | whatsapp-consent/inbound and generation-migration tests; sender scope and expiry retained |
| WhatsApp status/template webhook | Verified mode/payload hash receipt; stable eventKey; PROCESSING leaseToken/leaseUntil | Receipt ownership checked in effect transaction; completion and failure match token; event projections enforce ordering | whatsapp-webhook/service tests cover duplicate/reordered events, claim expiry, sender/mode isolation |
| Razorpay webhook | Signature + provider event identity, immutable hash/mode, processingToken/claim generation | Domain application verifies org/subscription scope and paid evidence; receipt completion/failure matches claim. Replay of a committed domain action is idempotent even if receipt completion fails | razorpay-webhook route, billing and webhook-boundary migration tests; no raw body logging, mode mismatch rejected |

External-call ambiguity is distinct from ownership. Expiring a lease never
authorizes repeating an uncertain charge/subscription mutation. No local token
promises exactly-once external effects. AI may be recomputed after takeover;
only the current attempt can publish its result.

Removed: the uncalled V1 ImportCommitService and its compensating-deletion path
(only callers were its own isolated unit tests), plus two unscoped obsolete AI
verification scripts. Existing V2 import payment/dues/permissions/atomicity
regressions remain. The architecture test prevents the retired import executor
from being reintroduced into application entry points.
