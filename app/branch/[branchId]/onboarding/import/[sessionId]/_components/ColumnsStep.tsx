import { useEffect, useMemo, useState } from "react";
import { Brain, Save } from "lucide-react";
import { AppButton, AppPanel, AppSelect } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { IMPORT_TARGET_FIELDS, type ImportColumnMapping } from "@/importing/contracts/import-session.contract";
import { aiAssistanceState } from "@/importing/utils/import-wizard-view-model";
import { pageInsetSurfaceClass, pageMutedTextClass, pageTableBodyDividerClass, pageTableHeadClass, pageTableRowClass } from "@/components/ui/pageSurface";
import { AccessibleTableScroll, StepNotice } from "./shared";
import type { ImportRecipe } from "@/lib/api/importSessions";
import type { ImportDetail, ImportGoal } from "./types";

type ColumnsStepProps = {
    detail: ImportDetail;
    goal: ImportGoal;
    saving: boolean;
    mutationsDisabled: boolean;
    suggestedRecipe?: ImportRecipe | null;
    onDirtyChange: (dirty: boolean) => void;
    onSave: (columnMappings: ImportColumnMapping[]) => Promise<void>;
};

const targetFieldLabels: Record<ImportColumnMapping["targetField"], string> = {
    "student.name": "Student name (required)",
    "student.phone": "Phone number",
    "student.joinedAt": "Joined date",
    "student.monthlyFee": "Monthly fee",
    "student.feeSource": "Fee source",
    "student.feeLinkedShiftName": "Fee-linked shift",
    "student.feeLinkedMultiShiftName": "Fee-linked bundle",
    "seat.label": "Seat to create",
    "shift.name": "Shift to create",
    "shift.startTime": "Shift start time",
    "shift.endTime": "Shift end time",
    "multiShift.name": "Bundle to create",
    "multiShift.componentShiftNames": "Bundle component shifts",
    "allocation.seatLabel": "Assigned seat",
    "allocation.shiftName": "Assigned shift",
    "allocation.multiShiftName": "Assigned bundle",
    "payment.amount": "Payment amount",
    "payment.status": "Payment status",
    "payment.method": "Payment method",
    "payment.referenceId": "Payment reference",
    ignore: "Do not import this column",
};

function fieldAllowedForGoal(field: ImportColumnMapping["targetField"], goal: ImportGoal) {
    if (field === "ignore" || field.startsWith("student.")) return true;
    if (goal === "STUDENTS") return false;
    if (field.startsWith("payment.")) return goal === "FULL";
    return true;
}

function targetOptions(goal: ImportGoal) {
    const groups = [
        ["Student", "student.", true],
        ["Seats and shifts", "seat.|shift.|multiShift.|allocation.", goal !== "STUDENTS"],
        ["Payments", "payment.", goal === "FULL"],
    ] as const;
    return [
        ...groups.filter(([, , visible]) => visible).map(([label, prefixes]) => ({
            label,
            options: IMPORT_TARGET_FIELDS
                .filter(field => field !== "ignore" && prefixes.split("|").some(prefix => field.startsWith(prefix)))
                .map(field => ({
                    value: field,
                    label: targetFieldLabels[field],
                })),
        })),
        { label: "Other", options: [{ value: "ignore", label: targetFieldLabels.ignore }] },
    ];
}

function spreadsheetColumnName(index: number) {
    if (!Number.isInteger(index) || index < 0) return null;
    let value = index + 1;
    let label = "";
    while (value > 0) {
        value--;
        label = String.fromCharCode(65 + value % 26) + label;
        value = Math.floor(value / 26);
    }
    return label;
}

export function ColumnsStep({ detail, goal, saving, mutationsDisabled, suggestedRecipe, onDirtyChange, onSave }: ColumnsStepProps) {
    const mapping = useMemo(() => detail.mapping?.columnMappings ?? [], [detail.mapping?.columnMappings]);
    const [draft, setDraft] = useState<ImportColumnMapping[]>(mapping);

    useEffect(() => {
        setDraft(mapping);
    }, [mapping]);

    const sourceColumns = useMemo(
        () => new Map((detail.mapping?.analysis?.sourceProfile?.columns ?? []).map(column => [column.column, column])),
        [detail.mapping?.analysis?.sourceProfile?.columns]
    );
    const sourceHeaderLabels = useMemo(() => {
        const headers = detail.fileMeta?.parser?.headers;
        if (!Array.isArray(headers)) return new Map<string, string>();
        return new Map(headers.flatMap(header => {
            const spreadsheetColumn = spreadsheetColumnName(header.index);
            if (!spreadsheetColumn || typeof header.column !== "string") return [];
            const original = typeof header.original === "string" ? header.original.trim() : "";
            return [[header.column, `${spreadsheetColumn} · ${header.wasBlank || !original ? "blank" : original}`] as const];
        }));
    }, [detail.fileMeta?.parser?.headers]);
    const sourceColumnLabel = (sourceColumn: string) => sourceHeaderLabels.get(sourceColumn) ?? sourceColumn;
    const mappingNeedsReview = draft.some(item => item.needsReview);
    const aiState = aiAssistanceState({
        ai: detail.mapping?.analysis?.ai,
        usedFallback: detail.mapping?.usedFallback,
        mappingNeedsReview,
    });
    const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(mapping), [draft, mapping]);

    useEffect(() => {
        onDirtyChange(changed);
    }, [changed, onDirtyChange]);
    const mappedCount = draft.filter(item => item.targetField !== "ignore").length;
    const intentionalBehavior = [
        "Student status is not imported; every new student starts active.",
        goal !== "STUDENTS" ? "Allocation start dates are not imported; allocations start when this plan is applied." : null,
        goal === "FULL" ? "Payment periods are not mapped; payment history is generated only by the four joined-date policies in Payments." : null,
    ].filter((message): message is string => Boolean(message)).join(" ");
    const updateTargetField = (index: number, targetField: ImportColumnMapping["targetField"]) => {
        setDraft(current => current.map((item, itemIndex) => itemIndex === index
            ? {
                ...item,
                targetField,
                source: "MANUAL",
                needsReview: false,
                autoApplied: targetField !== "ignore",
            }
            : item));
    };
    const applySuggestedRecipe = () => {
        if (!suggestedRecipe) return;
        setDraft(current => current.map((item, index) => {
            const recipeMapping = suggestedRecipe.columnMappings[index];
            if (!recipeMapping || !fieldAllowedForGoal(recipeMapping.targetField, goal)) return item;
            return {
                ...item,
                targetField: recipeMapping.targetField,
                confidence: 100,
                reason: `Suggested by saved recipe ${suggestedRecipe.name}.`,
                source: "MANUAL",
                autoApplied: recipeMapping.targetField !== "ignore",
                needsReview: false,
            };
        }));
    };

    return (
        <div className="space-y-5">
            <AppPanel
                title="Column meanings"
                description="Confirm how each source column maps into the ERP. AI is only a suggestion layer."
                action={
                    <AppButton
                        variant="primary"
                        icon={Save}
                        onClick={() => onSave(draft.map(item => ({ ...item, needsReview: false })))}
                        disabled={mutationsDisabled || !changed && !mappingNeedsReview}
                        aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                        isLoading={saving}
                    >
                        Confirm columns
                    </AppButton>
                }
            >
                <div className="space-y-4">
                    <StepNotice tone={aiState.tone} title={aiState.title} message={aiState.message} />
                    <StepNotice tone="cyan" title="Intentional import behavior" message={intentionalBehavior} />

                    {suggestedRecipe && (
                        <div className={cn("flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between", pageInsetSurfaceClass)}>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Badge variant="purple">Saved recipe</Badge>
                                    <p className="text-sm font-semibold text-[color:var(--text-primary)]">{suggestedRecipe.name}</p>
                                </div>
                                <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>
                                    The headers match a recipe used before. Apply its field meanings, then review every column before confirming.
                                </p>
                            </div>
                            <AppButton variant="secondary" onClick={applySuggestedRecipe} disabled={mutationsDisabled || saving}>
                                Use recipe, then review
                            </AppButton>
                        </div>
                    )}

                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className={cn("p-3", pageInsetSurfaceClass)}>
                            <p className={cn("text-xs", pageMutedTextClass)}>Mapped columns</p>
                            <p className="mt-1 text-xl font-semibold text-[color:var(--text-primary)]">{mappedCount}</p>
                        </div>
                        <div className={cn("p-3", pageInsetSurfaceClass)}>
                            <p className={cn("text-xs", pageMutedTextClass)}>Needs review</p>
                            <p className="mt-1 text-xl font-semibold text-[color:var(--text-primary)]">
                                {draft.filter(item => item.needsReview).length}
                            </p>
                        </div>
                        <div className={cn("p-3", pageInsetSurfaceClass)}>
                            <p className={cn("text-xs", pageMutedTextClass)}>AI mode</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                                <Badge variant={aiState.tone}>
                                    {detail.mapping?.analysis?.ai?.status?.replace(/_/g, " ") ?? "manual"}
                                </Badge>
                                {detail.mapping?.usedFallback && <Badge variant="warning">fallback</Badge>}
                            </div>
                        </div>
                    </div>

                    <div role="list" className="space-y-3 md:hidden" aria-label="Column mappings">
                        {draft.map((item, index) => {
                            const profile = sourceColumns.get(item.sourceColumn);
                            const displayLabel = sourceColumnLabel(item.sourceColumn);
                            const headingId = `column-mapping-${index}-title`;
                            const selectId = `column-mapping-${index}-field`;

                            return (
                                <article
                                    key={item.sourceColumn}
                                    role="listitem"
                                    aria-labelledby={headingId}
                                    className={cn("p-4", pageInsetSurfaceClass)}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <h3 id={headingId} className="break-words text-sm font-semibold text-[color:var(--text-primary)]">
                                            {displayLabel}
                                        </h3>
                                        {item.needsReview ? <Badge variant="warning">Review</Badge> : item.targetField === "ignore" ? <Badge variant="default">Ignored</Badge> : null}
                                    </div>

                                    <label htmlFor={selectId} className="mt-4 block text-xs font-semibold text-[color:var(--text-secondary)]">
                                        ERP field
                                    </label>
                                    <AppSelect
                                        id={selectId}
                                        value={item.targetField}
                                        disabled={mutationsDisabled}
                                        aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                                        onValueChange={value => updateTargetField(index, value as ImportColumnMapping["targetField"])}
                                        options={targetOptions(goal)}
                                        containerClassName="mt-2 w-full"
                                    />

                                    <dl className="mt-4 grid gap-3 text-xs">
                                        <div className="flex items-center justify-between gap-3">
                                            <dt className={pageMutedTextClass}>Confidence</dt>
                                            <dd>
                                                <Badge variant={item.confidence >= 85 ? "success" : item.confidence >= 60 ? "warning" : "default"}>
                                                    {Math.round(item.confidence)}%
                                                </Badge>
                                            </dd>
                                        </div>
                                        <div>
                                            <dt className={pageMutedTextClass}>Sample values</dt>
                                            <dd className="mt-1 break-words leading-5 text-[color:var(--text-primary)]">
                                                {profile?.sampleValues?.slice(0, 3).join(", ") || "-"}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt className={pageMutedTextClass}>Mapping reason</dt>
                                            <dd className="mt-1 break-words leading-5 text-[color:var(--text-primary)]">
                                                {item.reason || "Manual mapping."}
                                            </dd>
                                        </div>
                                    </dl>
                                </article>
                            );
                        })}
                    </div>

                    <AccessibleTableScroll
                        label="Column mappings"
                        className="hidden rounded-[8px] border border-[color:var(--ui-table-border)] md:block"
                    >
                        <table className="w-full min-w-[760px] text-left text-sm">
                            <caption className="sr-only">Source columns mapped to Lab Lords ERP fields</caption>
                            <thead className={pageTableHeadClass}>
                                <tr className="text-xs uppercase tracking-wide text-[color:var(--text-muted)]">
                                    <th scope="col" className="p-3">Source column</th>
                                    <th scope="col" className="p-3">ERP field</th>
                                    <th scope="col" className="p-3">Confidence</th>
                                    <th scope="col" className="p-3">Sample</th>
                                    <th scope="col" className="p-3">Why</th>
                                </tr>
                            </thead>
                            <tbody className={pageTableBodyDividerClass}>
                                {draft.map((item, index) => {
                                    const profile = sourceColumns.get(item.sourceColumn);
                                    const displayLabel = sourceColumnLabel(item.sourceColumn);
                                    return (
                                        <tr key={item.sourceColumn} className={pageTableRowClass}>
                                            <th scope="row" className="p-3 text-left">
                                                <div className="font-semibold text-[color:var(--text-primary)]">{displayLabel}</div>
                                                {item.needsReview ? <Badge className="mt-2" variant="warning">Review</Badge> : item.targetField === "ignore" ? <Badge className="mt-2" variant="default">Ignored</Badge> : null}
                                            </th>
                                            <td className="p-3">
                                                <AppSelect
                                                    aria-label={`ERP field for ${displayLabel}`}
                                                    value={item.targetField}
                                                    disabled={mutationsDisabled}
                                                    aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                                                    onValueChange={value => updateTargetField(index, value as ImportColumnMapping["targetField"])}
                                                    options={targetOptions(goal)}
                                                />
                                            </td>
                                            <td className="p-3">
                                                <Badge variant={item.confidence >= 85 ? "success" : item.confidence >= 60 ? "warning" : "default"}>
                                                    {Math.round(item.confidence)}%
                                                </Badge>
                                            </td>
                                            <td className={cn("max-w-[220px] p-3 text-xs", pageMutedTextClass)}>
                                                {profile?.sampleValues?.slice(0, 3).join(", ") || "-"}
                                            </td>
                                            <td className={cn("max-w-[260px] p-3 text-xs leading-5", pageMutedTextClass)}>
                                                {item.reason || "Manual mapping."}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </AccessibleTableScroll>
                </div>
            </AppPanel>

            <AppPanel title="Manual-first fallback" description="The import does not depend on AI being available.">
                <div className="grid gap-3 md:grid-cols-3">
                    {[
                        ["AI suggests", "Column meanings and likely payment words are only suggestions."],
                        ["Checks decide", "Required fields, duplicates, conflicts, and payments are validated deterministically."],
                        ["You confirm", "Business records are created only from the final reviewed preview."],
                    ].map(([title, text]) => (
                        <div key={title} className={cn("p-3", pageInsetSurfaceClass)}>
                            <div className="flex items-center gap-2">
                                <Brain className="h-4 w-4 text-cyan-300" />
                                <p className="text-sm font-semibold text-[color:var(--text-primary)]">{title}</p>
                            </div>
                            <p className={cn("mt-2 text-xs leading-5", pageMutedTextClass)}>{text}</p>
                        </div>
                    ))}
                </div>
            </AppPanel>
        </div>
    );
}
