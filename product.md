> **Historical roadmap:** This document records product intent and phased plans;
> it is not the source of truth for current implementation status. See
> [`docs/ai/current-state.md`](docs/ai/current-state.md) for the verified snapshot
> and [`docs/domain-invariants.md`](docs/domain-invariants.md) for required
> behavior and known discrepancies.

# Product Overview: Micro-ERP for Offline Education Businesses

*Version State: Active Development | Phase 0–6 implementation active*

## 1. Executive Summary
This project is a **multi-branch, role-based, analytics-driven micro-ERP** designed explicitly for offline education businesses (Study Halls, Libraries, Coaching Centers). It digitizes paper-based records through a phased feature rollout, culminating in AI-assisted analytics and localized communication tools.

## 2. Technology Stack
- **Framework:** Next.js (App Router)
- **Language:** TypeScript
- **Database:** PostgreSQL (via Prisma ORM)
- **Styling:** Tailwind CSS (Dark theme, Card-based layout, High-contrast metrics)
- **Architecture Pattern:** Service Layer Architecture (UI -> Server Actions/API -> Services -> Prisma)

---

## 3. Directory & File Structure (Pinpointed)

### `app/` (Routing & Pages)
The application adheres to a strict 3-scope routing pattern (`/auth`, `/org`, `/branch`).
- **`app/api/`** (Backend API Routes):
  - `ai/`, `analytics/`, `branches/`, `organizations/`, `payments/`, `seat-allocations/`, `students/`, `users/`
- **`app/branch/[branchId]/`** (Core Operational Scope):
  - `page.tsx` (Branch Dashboard)
  - `layout.tsx` (Branch Shell)
  - `allocations/` (Seat Allocation UI)
  - `analytics/` (Branch Health & Stats)
  - `payments/` (Billing & Dues)
  - `seats/` (Physical Asset Management)
  - `shifts/` (Time-slot Management)
  - `staff/` (Role Assignment)
  - `students/` (Student Directory)
  - `settings/` (Branch Configuration)
  - `ai/` (AI Reports, Insights, Messages)
- **`app/org/`** (Organization Level Scope)
- **`app/(auth)/`** (Authentication Scope)

### `services/` (Business Logic & Data Access)
The service layer isolates database operations from routing/UI logic.
- `organization.service.ts`: Tenant management.
- `branch.service.ts`: Cross-branch queries and lifecycle.
- `student.service.ts`: CRUD operations and active/inactive state handling.
- `seat.service.ts`: Seat inventory rules.
- `shift.service.ts`: Shift creation, soft-deletes (`deleteAt`), and timing logic.
- `seatAllocation.service.ts`: The complex **allocation engine** enforcing atomic shift overlaps and preventing logical conflicts.
- `payment.service.ts`: Billing generation logic (DUE/PAID/WAIVED statuses).
- `staff.service.ts`: Access control resolving `MANAGER`/`STAFF` authorizations.

### `components/` (UI Library & Domain Components)
- `layout/`: `OrgSidebar.tsx`, Header components, Navigation shells.
- `branch/`: Shared branch context features (e.g., `CreateBranchDialog.tsx`).
- `allocations/`: Modals (`AllocateSeatDialog`) and `SeatPicker` systems for the visual assignment.
- `analytics/`: Chart/Table renderers for Phase 4 snapshot and trend panels.
- `tables/`: Reusable data tables for students, payments, and shifts.
- `snapshot/`: Dashboard metric cards.
- `ui/`: Core design system atoms (Buttons, Inputs, Dialogs) adhering to dark theme rules.
- `ai/`: AI Draft message reviewers and Branch Health Report renderers.

### `types/` (TypeScript Domain Models)
- `branch.ts`, `organization.ts`, `student.ts`, `seatAllocation.ts`, `shift.ts`, `payment.ts`, `staff.ts`, `enums.ts` (Mirroring Prisma schemas strictly).

### `prisma/`
- `schema.prisma`: The single source of truth for the database schema, utilizing rigorous `@relation` mappings and compound `@unique` indices (`[branchId, label]`, `[userId, branchId]`).

---

## 4. Phase Completion Status

| Phase | Description | Status | Key Sub-Systems Involved |
| :--- | :--- | :--- | :--- |
| **Phase 0** | Foundation & Identity | ✅ Complete | Users, Organizations, Branch routing shells |
| **Phase 1** | Core Operations | ✅ Complete | Students, Seats, Shifts, **Atomic Shift Seat Allocations** |
| **Phase 2** | Payments & Billing | ✅ Complete | Monthly / Admission payments tracked |
| **Phase 3** | Staff & Roles | ✅ Complete | Branch-scoped roles (`MANAGER`, `STAFF`) |
| **Phase 4** | Standard Analytics | ✅ Complete | Snapshot dashboards, Seat utilization logic |
| **Phase 5** | AI Decision Engine | 🔄 Refining | `BranchAIReport` JSON generation, Risk alerts (Human-in-loop) |
| **Phase 6** | Communications | 🔄 Refining | Localized `MessageDraft` generation (No auto-sending) |

---

## 5. Critical System Behaviors (The "Guardrails")

1. **Strict Data Boundary:** Branch-owned data must be scoped through authorized organization and branch service paths. The database does not structurally prevent every cross-branch relationship, so direct or unscoped Prisma writes are unsafe.
2. **Atomic Shift Engine:** A single physical Seat can be booked by multiple students *only if* their corresponding Shifts do not overlap in time. The `seatAllocation.service.ts` rigorously validates this before mutation.
3. **Soft-Delete Architecture:** Shifts use `deletedAt` rather than destructive drops, preserving historical referential integrity for old bills and allocations.
4. **Read -> Render -> Mutate:** The UI logic enforces immediate visual rendering of data without optimistic assumptions. Mutation (like saving an allocation) occurs sequentially after validation.
5. **Non-Autonomous AI:** The system acts as a "Copilot". AI generates advisory alerts, narrative, and message drafts. A human reviews and copies any draft; no external message-sending integration is implemented.
