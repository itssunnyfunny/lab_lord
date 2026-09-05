# 0005: Tenant integrity and authoritative execution boundaries

- Status: Proposed
- Date: 2026-09-05
- Deciders: Pending
- Supersedes: None
- Superseded by: None

The user explicitly authorized local implementation of architecture consolidation
after `6ee00d0`. This ADR records the durable choices for human review; it does
not assert Accepted status or authorize Production changes.

Maintain the modular monolith and existing Prisma, Workflow and provider stack.
Extend composite tenant foreign keys only where multi-parent links need them;
preserve nullable history with explicit PostgreSQL column-scoped SET NULL.
Block inconsistent existing rows before backfill and constraint installation.
Keep authorization independent from referential integrity.

Consolidate billing provider mutations behind one durable action-dispatch
boundary while preserving separate outcomes for distinct provider actions,
historical compatibility and read-only uncertain-result recovery. Centralize
server-derived authorization policy and preserve explicit system-owned contexts.
Keep domain-specific AI, import and webhook ownership implementations when they
already enforce admission, fencing and replay safety.

Implementation and validation status is tracked in the
[outcome matrix](../ai/architecture-consolidation-2026-09-05.md). Production
inventory, final legacy removal and migration-versus-fresh cutover require
separate evidence and approval. Retain IDs, provider obligations and billing
history in either operational choice. No automatic cleanup, generic jobs
framework or commercial policy change is part of this decision.

Rollout requires the matching generated client, preflight counts and drained old
writers. Preserve constraints/history and use forward repair if reverting the
application would reintroduce unfenced writers. Detailed sequencing belongs in
the [production runbook](../production-runbook.md).
