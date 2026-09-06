# Architecture Decision Records

This directory records important decision proposals, human-approved decisions,
and their rationale. Do not reconstruct or invent approvals.

## Accepted decision index

Add Accepted or Superseded records here in numeric order:

| ADR | Status | Decision | Superseded by |
| --- | --- | --- | --- |
| [0003](./0003-whatsapp-template-delivery-and-collections.md) | Accepted | Managed WhatsApp Utility delivery and collections automation | — |
| [0004](./0004-whatsapp-daily-reports-and-operational-hardening.md) | Accepted | WhatsApp daily reports, typed service notices, and operational hardening | — |

## Proposed decision index

These drafts are review material only. Listing them does not make them binding
or imply owner approval.

| ADR | Status | Proposal |
| --- | --- | --- |
| [0001](./0001-managed-workflow-for-import-execution.md) | Proposed | Managed Workflow for import execution |
| [0002](./0002-whatsapp-communication-foundation.md) | Proposed | WhatsApp communication foundation and customer-owned Meta assets |
| [0005](./0005-tenant-integrity-and-authoritative-execution-boundaries.md) | Proposed | Tenant integrity and authoritative execution boundaries |

## Naming and status

Use `NNNN-kebab-title.md`, beginning at `0001`. Each ADR has exactly one of
these statuses:

- **Proposed** — drafted for review; not binding.
- **Accepted** — explicitly approved by the responsible human owner; binding.
- **Superseded** — replaced by a later Accepted ADR, with links in both records.
- **Rejected** — considered but not approved; retained for context.

An AI agent may research, draft, or update a Proposed ADR. It must not mark its
own proposal Accepted, infer approval from existing code, or self-approve a
decision. Record the approving person or governance body and approval date when
the status changes to Accepted.

## When an ADR is required

Create or update an ADR for a durable choice that materially changes:

- system architecture, service boundaries, or deployment model;
- tenant isolation, authentication, authorization, or entitlement policy;
- database ownership, schema strategy, migration policy, or data retention;
- operational or SaaS billing semantics and provider trust;
- an external vendor or a significant provider integration;
- AI autonomy, personal-data boundaries, human review, or external actions; or
- rollout, rollback, availability, or disaster-recovery strategy.

Routine implementation details, bug fixes that restore an existing invariant,
and reversible local refactors normally do not need an ADR.

## Workflow

1. Copy the template below into the next numbered file with status `Proposed`.
2. Link evidence and identify affected invariants, security boundaries, data,
   operations, alternatives, and unresolved questions.
3. Obtain explicit human review and approval before changing status to
   `Accepted`.
4. Add Accepted and Superseded records to the index above.
5. Update `AGENTS.md` and the applicable canonical documents in the same change.

## Template

```markdown
# NNNN: Decision title

- Status: Proposed
- Date: YYYY-MM-DD
- Deciders: Pending
- Supersedes: None
- Superseded by: None

## Context

What problem, constraints, evidence, and required invariants make a decision
necessary?

## Decision

What is being decided? State boundaries and deliberately excluded work.

## Alternatives considered

What credible alternatives were evaluated, and why were they not selected?

## Consequences

Describe benefits, costs, operational burden, compatibility, and follow-up work.

## Security and data impact

Describe trust-boundary, tenant-isolation, personal-data, secret, vendor, and
abuse implications.

## Rollout and rollback

Describe sequencing, validation, observability, containment, and recovery.

## Evidence

Link repository paths, tests, incidents, measurements, or approved external
references that support the decision.

## Approval

Record the approving human or governance body and approval date only when the
status becomes Accepted.
```
