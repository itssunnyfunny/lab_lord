import { createHash } from "node:crypto";
import type { ImportRowStatus } from "@/app/generated/prisma/enums";
import type {
    CommitMode,
    ImportIssue,
    ImportMappingState,
    ImportNormalizedRow,
    ImportSessionSummary,
} from "../contracts/import-session.contract";
import {
    IMPORT_ENGINE_VERSION,
    IMPORT_PLAN_SCHEMA_VERSION,
    type CompiledImportPlan,
    type ImportGoal,
    type ImportMutationSummary,
    type ImportPlanPaymentCycleDetail,
    type ImportPreviouslySucceededMutation,
    type ImportReadinessPolicy,
} from "../contracts/import-v2.contract";
import { buildImportPaymentPlan } from "./import-payment-plan";

export type ImportPlanEvaluation = {
    id: string;
    rowId: string;
    rowNumber: number;
    status: ImportRowStatus;
    skipped: boolean;
    normalizedData: ImportNormalizedRow | null;
    warnings: ImportIssue[];
};

export type CompileImportPlanSnapshotInput = {
    sessionId: string;
    targetRevision: number;
    goal: ImportGoal;
    readinessPolicy: ImportReadinessPolicy;
    mapping: ImportMappingState;
    summary: ImportSessionSummary | null;
    hasOpenQuestions: boolean;
    expectedRowCount: number;
    evaluations: ImportPlanEvaluation[];
    previouslySucceededItems?: ImportPreviouslySucceededMutation[];
    asOf?: Date;
    maxPlannedMutations?: number;
};

type ImportPlanMutationItem = CompiledImportPlan["snapshot"]["items"][number];

type ImportConfigurationCandidates = {
    items: ImportPlanMutationItem[];
    affectedRowIdsByItemKey: Map<string, Set<string>>;
    conflictingIdentities: Set<string>;
};

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonicalize(item)])
    );
}

export function createImportRequestHash(value: unknown) {
    return createHash("sha256")
        .update(JSON.stringify(canonicalize(value)))
        .digest("hex");
}

/**
 * Stable semantic identity for a domain mutation. Dependency transport fields are
 * deliberately omitted so a retry can replace a run-local student item key with
 * the retained student id without changing the reviewed mutation.
 */
export function createImportMutationRequestHash(
    item: Pick<CompiledImportPlan["snapshot"]["items"][number], "itemKey" | "kind" | "payload">
) {
    const payload = item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
        ? Object.fromEntries(
            Object.entries(item.payload).filter(([key]) => !["studentId", "studentItemKey"].includes(key))
        )
        : item.payload ?? null;
    return createImportRequestHash({ itemKey: item.itemKey, kind: item.kind, payload });
}

export function assertImportPlanWithinMutationLimit(snapshot: unknown, maxPlannedMutations: number) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new Error("Import plan snapshot is invalid");
    }
    const mutationSummary = (snapshot as { mutationSummary?: unknown }).mutationSummary;
    if (!mutationSummary || typeof mutationSummary !== "object" || Array.isArray(mutationSummary)) {
        throw new Error("Import plan snapshot is invalid");
    }
    const total = (mutationSummary as { total?: unknown }).total;
    if (!Number.isSafeInteger(total) || Number(total) < 0) {
        throw new Error("Import plan snapshot is invalid");
    }
    if (Number(total) > maxPlannedMutations) {
        throw new Error(`Import plan contains ${total} mutations, above the current safety limit of ${maxPlannedMutations}`);
    }
}

export function exactImportPaymentCycleFromPayload(
    payload: Record<string, unknown>
): Omit<ImportPlanPaymentCycleDetail, "itemKey" | "rowId" | "rowNumber" | "studentName"> {
    if (payload.bucket !== "historical" && payload.bucket !== "current") {
        throw new Error("Import payment mutation has an invalid history bucket");
    }
    if (payload.status !== "DUE" && payload.status !== "PAID" && payload.status !== "WAIVED") {
        throw new Error("Import payment mutation has an invalid status");
    }
    const cycle = payload.cycle;
    if (!cycle || typeof cycle !== "object" || Array.isArray(cycle)) {
        throw new Error("Import payment mutation has an invalid cycle");
    }
    const periodStart = (cycle as Record<string, unknown>).periodStart;
    const periodEnd = (cycle as Record<string, unknown>).periodEnd;
    const dueDate = (cycle as Record<string, unknown>).dueDate;
    if (
        typeof periodStart !== "string"
        || typeof periodEnd !== "string"
        || typeof dueDate !== "string"
        || !Number.isFinite(Date.parse(periodStart))
        || !Number.isFinite(Date.parse(periodEnd))
        || !Number.isFinite(Date.parse(dueDate))
    ) {
        throw new Error("Import payment mutation has invalid cycle dates");
    }
    if (typeof payload.amount !== "number" || !Number.isSafeInteger(payload.amount) || payload.amount < 0) {
        throw new Error("Import payment mutation amount must be a non-negative integer");
    }
    if (
        payload.method !== undefined
        && payload.method !== "CASH"
        && payload.method !== "UPI"
        && payload.method !== "BANK_TRANSFER"
    ) {
        throw new Error("Import payment mutation has an invalid method");
    }
    if (payload.referenceId !== undefined && typeof payload.referenceId !== "string") {
        throw new Error("Import payment mutation has an invalid reference");
    }
    return {
        bucket: payload.bucket,
        periodStart,
        periodEnd,
        dueDate,
        amount: payload.amount,
        status: payload.status,
        ...(payload.method ? { method: payload.method } : {}),
        ...(typeof payload.referenceId === "string" && payload.referenceId.trim()
            ? { referenceId: payload.referenceId.trim() }
            : {}),
    };
}

export function readinessPolicyFromLegacyCommitMode(mode: CommitMode): ImportReadinessPolicy {
    return mode === "STRICT_ALL_OR_NOTHING"
        ? "REQUIRE_ALL_ROWS_READY"
        : "READY_ROWS_ONLY";
}

function normalizedConfigurationIdentity(type: string, value: Record<string, unknown>) {
    const candidate = type === "seat" ? value.label : value.name;
    return typeof candidate === "string" ? candidate.trim().toLocaleLowerCase() : "";
}

function normalizedConfigurationDefinition(type: string, value: Record<string, unknown>) {
    const normalizeText = (candidate: unknown) => typeof candidate === "string"
        ? candidate.trim().toLocaleLowerCase()
        : candidate ?? null;
    if (type === "seat") return { label: normalizeText(value.label) };
    if (type === "shift") {
        return {
            name: normalizeText(value.name),
            startTime: normalizeText(value.startTime),
            endTime: normalizeText(value.endTime),
            price: value.price ?? null,
        };
    }
    return {
        name: normalizeText(value.name),
        componentShiftNames: Array.isArray(value.componentShiftNames)
            ? value.componentShiftNames.map(normalizeText)
            : [],
        price: value.price ?? null,
    };
}

function configurationPayloadsForEvaluation(evaluation: ImportPlanEvaluation, mapping: ImportMappingState) {
    const normalized = evaluation.normalizedData ?? {};
    const options = mapping.importOptions ?? {};
    const payloads: Array<{ type: string; value: Record<string, unknown> }> = [];
    if (options.createUnknownSeats && normalized.seat?.label) {
        payloads.push({ type: "seat", value: { label: normalized.seat.label } });
    }
    if (options.createUnknownShifts && normalized.shift?.name) {
        payloads.push({
            type: "shift",
            value: {
                ...normalized.shift,
                ...(normalized.student?.monthlyFee !== undefined
                    ? { price: normalized.student.monthlyFee }
                    : {}),
            },
        });
    }
    if (options.createUnknownMultiShifts && normalized.multiShift?.name) {
        payloads.push({
            type: "multi-shift",
            value: {
                ...normalized.multiShift,
                ...(normalized.student?.monthlyFee !== undefined
                    ? { price: normalized.student.monthlyFee }
                    : {}),
            },
        });
    }
    return payloads;
}

function buildImportConfigurationCandidates(input: Pick<
    CompileImportPlanSnapshotInput,
    "evaluations" | "mapping"
>): ImportConfigurationCandidates {
    const items = new Map<string, ImportPlanMutationItem>();
    const affectedRowIdsByItemKey = new Map<string, Set<string>>();
    const definitionHashes = new Map<string, string>();
    const conflictingIdentities = new Set<string>();
    const readyEvaluations = [...input.evaluations]
        .filter(evaluation => !evaluation.skipped && ["READY", "WARNING"].includes(evaluation.status))
        .sort((left, right) => left.rowNumber - right.rowNumber || left.rowId.localeCompare(right.rowId));

    for (const evaluation of readyEvaluations) {
        for (const config of configurationPayloadsForEvaluation(evaluation, input.mapping)) {
            const identity = normalizedConfigurationIdentity(config.type, config.value);
            const identityKey = `${config.type}:${identity}`;
            const definitionHash = createImportRequestHash(
                normalizedConfigurationDefinition(config.type, config.value)
            );
            const priorDefinitionHash = definitionHashes.get(identityKey);
            if (priorDefinitionHash && priorDefinitionHash !== definitionHash) {
                conflictingIdentities.add(identityKey);
            } else if (!priorDefinitionHash) {
                definitionHashes.set(identityKey, definitionHash);
            }

            const itemKey = `config:${config.type}:${createImportRequestHash({ type: config.type, identity }).slice(0, 24)}`;
            if (!items.has(itemKey)) {
                items.set(itemKey, {
                    itemKey,
                    kind: "CONFIG",
                    evaluationId: evaluation.id,
                    rowId: evaluation.rowId,
                    payload: { type: config.type, ...config.value },
                });
            }
            const affectedRows = affectedRowIdsByItemKey.get(itemKey) ?? new Set<string>();
            affectedRows.add(evaluation.rowId);
            affectedRowIdsByItemKey.set(itemKey, affectedRows);
        }
    }

    return {
        items: [...items.values()],
        affectedRowIdsByItemKey,
        conflictingIdentities,
    };
}

/**
 * Produces only the bounded configuration candidates needed to revalidate
 * successful configuration mutations. It deliberately does not expand
 * student payment history.
 */
export function compileImportConfigurationCandidateItems(input: Pick<
    CompileImportPlanSnapshotInput,
    "evaluations" | "mapping"
>) {
    return buildImportConfigurationCandidates(input).items;
}

export function compileImportPlanSnapshot(input: CompileImportPlanSnapshotInput): CompiledImportPlan {
    if (
        input.maxPlannedMutations !== undefined
        && (!Number.isSafeInteger(input.maxPlannedMutations) || input.maxPlannedMutations <= 0)
    ) {
        throw new Error("Import mutation safety limit must be a positive integer");
    }
    const evaluations = [...input.evaluations].sort((left, right) =>
        left.rowNumber - right.rowNumber || left.rowId.localeCompare(right.rowId)
    );
    const excludedEvaluations = evaluations.filter(evaluation =>
        evaluation.skipped || ["SKIPPED", "IMPORTED"].includes(evaluation.status)
    );
    const skippedRows = excludedEvaluations.length;
    const readyEvaluations = evaluations.filter(evaluation =>
        !evaluation.skipped && ["READY", "WARNING"].includes(evaluation.status)
    );
    const warningRows = readyEvaluations.filter(evaluation => evaluation.status === "WARNING").length;
    const blockedRows = evaluations.length - readyEvaluations.length - skippedRows;
    const uniqueRowIds = new Set(evaluations.map(evaluation => evaluation.rowId));
    const hasCompleteCoverage = evaluations.length === input.expectedRowCount
        && uniqueRowIds.size === input.expectedRowCount;

    const checks: CompiledImportPlan["checks"] = [
        {
            code: "EVALUATION_COVERAGE",
            status: hasCompleteCoverage ? "pass" : "block",
            count: evaluations.length,
            message: hasCompleteCoverage
                ? "Every staged row has a published evaluation for this revision."
                : "Published evaluations do not cover every staged row.",
        },
        {
            code: "OPEN_QUESTIONS",
            status: input.hasOpenQuestions ? "block" : "pass",
            message: input.hasOpenQuestions
                ? "Open import decisions remain."
                : "No open import decisions remain.",
        },
        {
            code: "READY_ROWS",
            status: readyEvaluations.length > 0 ? "pass" : "block",
            count: readyEvaluations.length,
            message: readyEvaluations.length > 0
                ? `${readyEvaluations.length} row${readyEvaluations.length === 1 ? " is" : "s are"} ready to run.`
                : "No rows are ready to run.",
        },
        {
            code: "ALL_ROWS_READY",
            status: input.readinessPolicy === "REQUIRE_ALL_ROWS_READY" && blockedRows > 0 ? "block" : "pass",
            count: blockedRows,
            message: blockedRows === 0
                ? "All non-skipped rows are ready."
                : input.readinessPolicy === "REQUIRE_ALL_ROWS_READY"
                    ? `${blockedRows} non-skipped row${blockedRows === 1 ? " is" : "s are"} not ready.`
                    : `${blockedRows} non-ready row${blockedRows === 1 ? " is" : "s are"} outside this run.`,
        },
    ];

    const mutationItems = new Map<string, CompiledImportPlan["snapshot"]["items"][number]>();
    const configurationAffectedRowIds = new Set<string>();
    const previouslySucceededItems = new Map<string, ImportPreviouslySucceededMutation>();
    for (const item of input.previouslySucceededItems ?? []) {
        if (!previouslySucceededItems.has(item.itemKey)) {
            previouslySucceededItems.set(item.itemKey, item);
        }
    }
    const previouslySucceededPaymentsByRow = new Map<string, ImportPreviouslySucceededMutation[]>();
    for (const item of previouslySucceededItems.values()) {
        if (item.kind !== "PAYMENT_CYCLE" || !item.rowId) continue;
        const rowPayments = previouslySucceededPaymentsByRow.get(item.rowId) ?? [];
        rowPayments.push(item);
        previouslySucceededPaymentsByRow.set(item.rowId, rowPayments);
    }
    const missingRetryStudentIds = new Set<string>();
    const retryMutationConflicts = new Set<string>();
    const asOf = input.asOf ?? new Date();
    let mutationLimitExceeded = false;
    const addMutationItem = (item: ImportPlanMutationItem) => {
        if (mutationItems.has(item.itemKey)) return true;
        mutationItems.set(item.itemKey, item);
        if (
            input.maxPlannedMutations !== undefined
            && mutationItems.size > input.maxPlannedMutations
        ) {
            mutationLimitExceeded = true;
            return false;
        }
        return true;
    };

    const configurationCandidates = buildImportConfigurationCandidates({
        evaluations: readyEvaluations,
        mapping: input.mapping,
    });
    for (const item of configurationCandidates.items) {
        if (previouslySucceededItems.has(item.itemKey)) continue;
        for (const rowId of configurationCandidates.affectedRowIdsByItemKey.get(item.itemKey) ?? []) {
            configurationAffectedRowIds.add(rowId);
        }
        if (!addMutationItem(item)) break;
    }

    evaluationLoop:
    for (const evaluation of mutationLimitExceeded ? [] : readyEvaluations) {
        const normalized = evaluation.normalizedData ?? {};
        const remainingMutationCapacity = input.maxPlannedMutations === undefined
            ? undefined
            : Math.max(0, input.maxPlannedMutations - mutationItems.size);
        const paymentPlan = buildImportPaymentPlan(normalized, input.mapping, asOf, {
            maxItems: remainingMutationCapacity === undefined
                ? undefined
                : remainingMutationCapacity
                    + (previouslySucceededPaymentsByRow.get(evaluation.rowId)?.length ?? 0)
                    + 1,
        });

        const studentItemKey = `row:${evaluation.rowId}:student`;
        const studentMutation = {
            itemKey: studentItemKey,
            kind: "STUDENT" as const,
            evaluationId: evaluation.id,
            rowId: evaluation.rowId,
            payload: {
                student: normalized.student ?? {},
                billingStartAt: paymentPlan.billingStartAt?.toISOString() ?? null,
            },
        };
        const historicalStudent = previouslySucceededItems.get(studentItemKey);
        const succeededStudent = historicalStudent
            && historicalStudent.kind === "STUDENT"
            && historicalStudent.requestHash === createImportMutationRequestHash(studentMutation)
            ? historicalStudent
            : undefined;
        if (historicalStudent && !succeededStudent) {
            retryMutationConflicts.add(studentItemKey);
        }
        const recoveredStudentId = succeededStudent?.entityIds[0];
        if (!historicalStudent) {
            if (!addMutationItem(studentMutation)) break evaluationLoop;
        } else if (!succeededStudent) {
            continue;
        } else if (!recoveredStudentId) {
            missingRetryStudentIds.add(evaluation.rowId);
        }
        const studentDependency = succeededStudent
            ? { studentId: recoveredStudentId ?? null }
            : { studentItemKey };

        const allocationSkipped = evaluation.warnings.some(warning => warning.code.startsWith("ALLOCATION_SKIPPED_"));
        if (
            input.goal !== "STUDENTS"
            &&
            !allocationSkipped
            && normalized.allocation?.seatLabel
            && (normalized.allocation.shiftName || normalized.allocation.multiShiftName)
        ) {
            const itemKey = `row:${evaluation.rowId}:allocation`;
            const allocationMutation = {
                itemKey,
                kind: "ALLOCATION" as const,
                evaluationId: evaluation.id,
                rowId: evaluation.rowId,
                payload: {
                    ...studentDependency,
                    allocation: {
                        ...normalized.allocation,
                        ...(normalized.allocation.multiShiftName
                            ? { componentShiftNames: normalized.multiShift?.componentShiftNames ?? [] }
                            : {}),
                    },
                },
            };
            const historicalAllocation = previouslySucceededItems.get(itemKey);
            if (!historicalAllocation) {
                if (!addMutationItem(allocationMutation)) break evaluationLoop;
            } else if (
                historicalAllocation.kind !== "ALLOCATION"
                || historicalAllocation.requestHash !== createImportMutationRequestHash(allocationMutation)
            ) {
                retryMutationConflicts.add(itemKey);
            }
        } else if (previouslySucceededItems.has(`row:${evaluation.rowId}:allocation`)) {
            retryMutationConflicts.add(`row:${evaluation.rowId}:allocation`);
        }

        const currentPaymentKeys = new Set<string>();
        for (const payment of input.goal === "FULL" ? paymentPlan.items : []) {
            const cycleKey = payment.cycle.periodStart.toISOString().slice(0, 10);
            const itemKey = `row:${evaluation.rowId}:payment:${cycleKey}`;
            currentPaymentKeys.add(itemKey);
            const paymentMutation = {
                itemKey,
                kind: "PAYMENT_CYCLE" as const,
                evaluationId: evaluation.id,
                rowId: evaluation.rowId,
                payload: {
                    ...studentDependency,
                    cycle: {
                        periodStart: payment.cycle.periodStart.toISOString(),
                        periodEnd: payment.cycle.periodEnd.toISOString(),
                        dueDate: payment.cycle.dueDate.toISOString(),
                    },
                    status: payment.status,
                    bucket: payment.bucket,
                    amount: normalized.payment?.amount ?? normalized.student?.monthlyFee ?? 0,
                    ...(payment.status === "PAID"
                        ? {
                            method: normalized.payment?.method,
                            referenceId: normalized.payment?.referenceId,
                        }
                        : {}),
                },
            };
            const historicalPayment = previouslySucceededItems.get(itemKey);
            if (!historicalPayment) {
                if (!addMutationItem(paymentMutation)) break evaluationLoop;
            } else if (
                historicalPayment.kind !== "PAYMENT_CYCLE"
                || historicalPayment.requestHash !== createImportMutationRequestHash(paymentMutation)
            ) {
                retryMutationConflicts.add(itemKey);
            }
        }
        for (const previous of previouslySucceededPaymentsByRow.get(evaluation.rowId) ?? []) {
            if (
                !currentPaymentKeys.has(previous.itemKey)
            ) {
                retryMutationConflicts.add(previous.itemKey);
            }
        }
    }
    checks.push({
        code: "RETRY_DEPENDENCY",
        status: missingRetryStudentIds.size > 0 ? "block" : "pass",
        count: missingRetryStudentIds.size,
        message: missingRetryStudentIds.size > 0
            ? `${missingRetryStudentIds.size} repaired row${missingRetryStudentIds.size === 1 ? " is" : "s are"} missing the retained student identifier required for a safe retry.`
            : "Previously completed student mutations have retained identifiers for safe retries.",
    });
    checks.push({
        code: "RETRY_MUTATION_CONFLICT",
        status: retryMutationConflicts.size > 0 ? "block" : "pass",
        count: retryMutationConflicts.size,
        message: retryMutationConflicts.size > 0
            ? `${retryMutationConflicts.size} previously completed mutation${retryMutationConflicts.size === 1 ? " no longer matches" : "s no longer match"} the edited repair data.`
            : "Previously completed mutations still match the reviewed repair data.",
    });
    checks.push({
        code: "CONFIGURATION_CONFLICT",
        status: configurationCandidates.conflictingIdentities.size > 0 ? "block" : "pass",
        count: configurationCandidates.conflictingIdentities.size,
        message: configurationCandidates.conflictingIdentities.size > 0
            ? `${configurationCandidates.conflictingIdentities.size} missing configuration name${configurationCandidates.conflictingIdentities.size === 1 ? " has" : "s have"} conflicting reviewed definitions.`
            : "Shared missing configuration names have consistent reviewed definitions.",
    });
    const mutationKindOrder = { CONFIG: 0, STUDENT: 1, ALLOCATION: 2, PAYMENT_CYCLE: 3 } as const;
    const configurationSubtypeOrder = (item: CompiledImportPlan["snapshot"]["items"][number]) => {
        if (item.kind !== "CONFIG") return 0;
        if (item.payload?.type === "seat") return 0;
        if (item.payload?.type === "shift") return 1;
        if (item.payload?.type === "multi-shift") return 2;
        return 3;
    };
    const sortedMutationItems = [...mutationItems.values()].sort((left, right) =>
        mutationKindOrder[left.kind] - mutationKindOrder[right.kind]
        || configurationSubtypeOrder(left) - configurationSubtypeOrder(right)
        || left.itemKey.localeCompare(right.itemKey)
    );
    const affectedRowsFor = (kind: typeof sortedMutationItems[number]["kind"]) => kind === "CONFIG"
        ? configurationAffectedRowIds.size
        : new Set(
            sortedMutationItems.filter(item => item.kind === kind).map(item => item.rowId).filter(Boolean)
        ).size;
    const paymentCounts = {
        historical: { DUE: 0, PAID: 0, WAIVED: 0 },
        current: { DUE: 0, PAID: 0, WAIVED: 0 },
    };
    const evaluationByRowId = new Map(evaluations.map(evaluation => [evaluation.rowId, evaluation]));
    const paymentBreakdownByRow = new Map<string, {
        rowId: string;
        rowNumber: number;
        studentName: string;
        historical: { DUE: number; PAID: number; WAIVED: number };
        current: { DUE: number; PAID: number; WAIVED: number };
        total: number;
    }>();
    for (const item of sortedMutationItems.filter(candidate => candidate.kind === "PAYMENT_CYCLE")) {
        const payload = item.payload ?? {};
        const exactCycle = exactImportPaymentCycleFromPayload(payload);
        const { bucket, status } = exactCycle;
        paymentCounts[bucket][status] += 1;
        if (item.rowId) {
            const evaluation = evaluationByRowId.get(item.rowId);
            if (evaluation) {
                const existing = paymentBreakdownByRow.get(item.rowId) ?? {
                    rowId: item.rowId,
                    rowNumber: evaluation.rowNumber,
                    studentName: evaluation.normalizedData?.student?.name?.trim() || `Row ${evaluation.rowNumber}`,
                    historical: { DUE: 0, PAID: 0, WAIVED: 0 },
                    current: { DUE: 0, PAID: 0, WAIVED: 0 },
                    total: 0,
                };
                existing[bucket][status] += 1;
                existing.total += 1;
                paymentBreakdownByRow.set(item.rowId, existing);
            }
        }
    }
    const mutationSummary: ImportMutationSummary = {
        total: sortedMutationItems.length,
        configuration: sortedMutationItems.filter(item => item.kind === "CONFIG").length,
        students: sortedMutationItems.filter(item => item.kind === "STUDENT").length,
        allocations: sortedMutationItems.filter(item => item.kind === "ALLOCATION").length,
        paymentCycles: sortedMutationItems.filter(item => item.kind === "PAYMENT_CYCLE").length,
        affectedRows: {
            students: affectedRowsFor("STUDENT"),
            allocations: affectedRowsFor("ALLOCATION"),
            payments: affectedRowsFor("PAYMENT_CYCLE"),
            configuration: affectedRowsFor("CONFIG"),
        },
        payments: paymentCounts,
        paymentBreakdown: [...paymentBreakdownByRow.values()].sort((left, right) =>
            left.rowNumber - right.rowNumber || left.rowId.localeCompare(right.rowId)
        ),
    };
    const configurationApproval = {
        required: mutationSummary.configuration > 0,
        approved: Boolean(input.mapping.importOptions?.configurationBatchApproved),
        affectedRows: mutationSummary.affectedRows.configuration,
    };
    checks.push({
        code: "CONFIGURATION_APPROVAL",
        status: configurationApproval.required && !configurationApproval.approved ? "block" : "pass",
        count: mutationSummary.configuration,
        message: configurationApproval.required
            ? configurationApproval.approved
                ? "Missing branch configuration was approved as one reviewed batch."
                : "Approve the reviewed missing seats, shifts, and bundles as one batch, or map/skip them."
            : "No branch configuration will be created.",
    });
    if (input.maxPlannedMutations !== undefined) {
        const withinLimit = mutationSummary.total <= input.maxPlannedMutations;
        checks.push({
            code: "MUTATION_LIMIT",
            status: withinLimit ? "pass" : "block",
            count: mutationSummary.total,
            message: withinLimit
                ? `This plan contains ${mutationSummary.total} bounded mutations.`
                : mutationLimitExceeded
                    ? `This plan requires more than the tested safety limit of ${input.maxPlannedMutations} mutations. Compilation stopped safely after proving at least ${mutationSummary.total} mutations are required.`
                    : `This plan contains ${mutationSummary.total} mutations, above the tested safety limit of ${input.maxPlannedMutations}.`,
        });
    }
    const requiredPermissions = [
        "students",
        ...(mutationSummary.configuration > 0 ? ["manage_branch"] : []),
        ...(mutationSummary.allocations > 0 ? ["seat_allocation"] : []),
        ...(mutationSummary.paymentCycles > 0 ? ["generate_payments"] : []),
        ...(paymentCounts.historical.PAID + paymentCounts.current.PAID > 0 ? ["mark_payment_paid"] : []),
        ...(paymentCounts.historical.WAIVED + paymentCounts.current.WAIVED > 0 ? ["waive_payments"] : []),
    ];

    const snapshot: CompiledImportPlan["snapshot"] = {
        schemaVersion: IMPORT_PLAN_SCHEMA_VERSION,
        sessionId: input.sessionId,
        targetRevision: input.targetRevision,
        engineVersion: IMPORT_ENGINE_VERSION,
        goal: input.goal,
        readinessPolicy: input.readinessPolicy,
        mapping: input.mapping,
        summary: input.summary,
        evaluations: evaluations.map(evaluation => ({
            evaluationId: evaluation.id,
            rowId: evaluation.rowId,
            rowNumber: evaluation.rowNumber,
            status: evaluation.status,
            skipped: evaluation.skipped || ["SKIPPED", "IMPORTED"].includes(evaluation.status),
        })),
        items: sortedMutationItems,
        requiredPermissions,
        configurationApproval,
        mutationSummary,
    };
    const counts = {
        totalRows: evaluations.length,
        readyRows: readyEvaluations.length,
        blockedRows,
        warningRows,
        skippedRows,
    };

    return {
        planVersion: createImportRequestHash(snapshot),
        canRun: checks.every(check => check.status !== "block"),
        ...counts,
        checks,
        snapshot,
        summary: {
            ...counts,
            mutations: mutationSummary,
            requiredPermissions,
        },
    };
}
