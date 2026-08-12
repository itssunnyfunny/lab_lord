import { useEffect, useMemo, useState } from "react";
import { Brain, Save } from "lucide-react";
import { AppButton, AppPanel, AppSelect } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { IMPORT_TARGET_FIELDS, type ImportColumnMapping } from "@/importing/contracts/import-session.contract";
import { aiAssistanceState } from "@/importing/utils/import-wizard-view-model";
import { pageInsetSurfaceClass, pageMutedTextClass, pageTableBodyDividerClass, pageTableHeadClass, pageTableRowClass } from "@/components/ui/pageSurface";
import { AccessibleTableScroll, StepNotice } from "./shared";
import type { ImportDetail } from "./types";

type ColumnsStepProps = {
    detail: ImportDetail;
    saving: boolean;
    mutationsDisabled: boolean;
    onSave: (columnMappings: ImportColumnMapping[]) => Promise<void>;
};

export function ColumnsStep({ detail, saving, mutationsDisabled, onSave }: ColumnsStepProps) {
    const mapping = useMemo(() => detail.mapping?.columnMappings ?? [], [detail.mapping?.columnMappings]);
    const [draft, setDraft] = useState<ImportColumnMapping[]>(mapping);

    useEffect(() => {
        setDraft(mapping);
    }, [mapping]);

    const sourceColumns = useMemo(
        () => new Map((detail.mapping?.analysis?.sourceProfile?.columns ?? []).map(column => [column.column, column])),
        [detail.mapping?.analysis?.sourceProfile?.columns]
    );
    const mappingNeedsReview = draft.some(item => item.needsReview || item.targetField === "ignore");
    const aiState = aiAssistanceState({
        ai: detail.mapping?.analysis?.ai,
        usedFallback: detail.mapping?.usedFallback,
        mappingNeedsReview,
    });
    const changed = JSON.stringify(draft) !== JSON.stringify(mapping);
    const mappedCount = draft.filter(item => item.targetField !== "ignore").length;
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

    return (
        <div className="space-y-5">
            <AppPanel
                title="Column meanings"
                description="Confirm how each source column maps into the ERP. AI is only a suggestion layer."
                action={
                    <AppButton
                        variant="primary"
                        icon={Save}
                        onClick={() => onSave(draft)}
                        disabled={mutationsDisabled || !changed}
                        aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                        isLoading={saving}
                    >
                        Save columns
                    </AppButton>
                }
            >
                <div className="space-y-4">
                    <StepNotice tone={aiState.tone} title={aiState.title} message={aiState.message} />

                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className={cn("p-3", pageInsetSurfaceClass)}>
                            <p className={cn("text-xs", pageMutedTextClass)}>Mapped columns</p>
                            <p className="mt-1 text-xl font-semibold text-[color:var(--text-primary)]">{mappedCount}</p>
                        </div>
                        <div className={cn("p-3", pageInsetSurfaceClass)}>
                            <p className={cn("text-xs", pageMutedTextClass)}>Needs review</p>
                            <p className="mt-1 text-xl font-semibold text-[color:var(--text-primary)]">
                                {draft.filter(item => item.needsReview || item.targetField === "ignore").length}
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
                                            {item.sourceColumn}
                                        </h3>
                                        {item.needsReview && <Badge variant="warning">review</Badge>}
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
                                        options={IMPORT_TARGET_FIELDS.map(field => ({ value: field, label: field }))}
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
                                    return (
                                        <tr key={item.sourceColumn} className={pageTableRowClass}>
                                            <th scope="row" className="p-3 text-left">
                                                <div className="font-semibold text-[color:var(--text-primary)]">{item.sourceColumn}</div>
                                                {item.needsReview && <Badge className="mt-2" variant="warning">review</Badge>}
                                            </th>
                                            <td className="p-3">
                                                <AppSelect
                                                    aria-label={`ERP field for ${item.sourceColumn}`}
                                                    value={item.targetField}
                                                    disabled={mutationsDisabled}
                                                    aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                                                    onValueChange={value => updateTargetField(index, value as ImportColumnMapping["targetField"])}
                                                    options={IMPORT_TARGET_FIELDS.map(field => ({ value: field, label: field }))}
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
