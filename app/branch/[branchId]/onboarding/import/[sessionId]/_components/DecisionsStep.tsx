import { CheckCircle2, HelpCircle, Link2Off, Save, UserRoundCheck } from "lucide-react";
import { AppButton, AppPanel } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { labelImportOption } from "@/importing/utils/import-wizard-view-model";
import { pageInsetSurfaceClass, pageMutedTextClass } from "@/components/ui/pageSurface";
import { importFieldClass, StepNotice } from "./shared";
import type { ImportQuestion } from "./types";

type DecisionsStepProps = {
    questions: ImportQuestion[];
    questionDrafts: Record<string, string>;
    saving: boolean;
    mutationsDisabled: boolean;
    onDraftChange: (questionId: string, value: string) => void;
    onAnswer: (questionId: string, answer: unknown) => void;
    onDeferAllocations: () => void;
    onStudentsOnly: () => void;
};

export function DecisionsStep({
    questions,
    questionDrafts,
    saving,
    mutationsDisabled,
    onDraftChange,
    onAnswer,
    onDeferAllocations,
    onStudentsOnly,
}: DecisionsStepProps) {
    const openQuestions = questions.filter(question => question.status === "OPEN");
    const answeredQuestions = questions.filter(question => question.status !== "OPEN");

    return (
        <div className="space-y-5">
            <AppPanel
                title="Decisions"
                description="Answer only the decisions needed for this import. Unclear seat, shift, and payment data can be deferred."
                action={
                    <AppButton
                        variant="secondary"
                        icon={Link2Off}
                        onClick={onDeferAllocations}
                        disabled={mutationsDisabled}
                        aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                        isLoading={saving}
                    >
                        Defer seat/shift mapping
                    </AppButton>
                }
            >
                <div className="space-y-4">
                    <StepNotice
                        tone={openQuestions.length > 0 ? "warning" : "success"}
                        title={openQuestions.length > 0 ? `${openQuestions.length} decision${openQuestions.length === 1 ? "" : "s"} open` : "No open decisions"}
                        message={openQuestions.length > 0
                            ? "Answers are saved to this staged import, then validation runs again. No branch records are created until the final preview is confirmed."
                            : "Saved decisions are already applied to the current validation plan."}
                    />

                    <div className={cn("flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between", pageInsetSurfaceClass)}>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <UserRoundCheck className="h-4 w-4 text-cyan-300" />
                                <p className="text-sm font-semibold text-[color:var(--text-primary)]">
                                    Import students now, finish setup later
                                </p>
                            </div>
                            <p className={cn("mt-1 text-xs leading-5", pageMutedTextClass)}>
                                Defers seat/shift mapping and skips payments for this import while keeping valid student rows importable.
                            </p>
                        </div>
                        <AppButton
                            variant="primary"
                            icon={UserRoundCheck}
                            onClick={onStudentsOnly}
                            disabled={mutationsDisabled}
                            aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                            isLoading={saving}
                        >
                            Use students-only mode
                        </AppButton>
                    </div>

                    <div className="space-y-3">
                        {openQuestions.length === 0 && (
                            <div className={cn("p-4 text-sm", pageInsetSurfaceClass, pageMutedTextClass)}>
                                No open decisions are waiting.
                            </div>
                        )}

                        {openQuestions.map(question => (
                            <div key={question.id} className={cn("p-4", pageInsetSurfaceClass)}>
                                <div className="flex items-start gap-3">
                                    <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <p className="font-medium text-[color:var(--text-primary)]">{question.question}</p>
                                            <Badge variant="warning">{question.status}</Badge>
                                        </div>
                                        {question.field && <p className={cn("mt-1 text-xs", pageMutedTextClass)}>{question.field}</p>}

                                        {(question.options ?? []).length > 0 && (
                                            <div className="mt-3 flex flex-wrap gap-2">
                                                {(question.options ?? []).map(option => (
                                                    <AppButton
                                                        key={option}
                                                        size="sm"
                                                        variant="secondary"
                                                        onClick={() => onAnswer(question.id, option)}
                                                        disabled={mutationsDisabled}
                                                        aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                                                        isLoading={saving}
                                                    >
                                                        {labelImportOption(option)}
                                                    </AppButton>
                                                ))}
                                            </div>
                                        )}
                                        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                                            <input
                                                value={questionDrafts[question.id] ?? ""}
                                                onChange={event => onDraftChange(question.id, event.target.value)}
                                                className={cn("min-w-0 flex-1", importFieldClass)}
                                                placeholder="Custom answer"
                                            />
                                            <AppButton
                                                variant="primary"
                                                size="sm"
                                                icon={Save}
                                                disabled={mutationsDisabled || !questionDrafts[question.id]?.trim()}
                                                aria-describedby={mutationsDisabled ? "import-session-mutation-blocker" : undefined}
                                                onClick={() => onAnswer(question.id, questionDrafts[question.id])}
                                                isLoading={saving}
                                            >
                                                Answer
                                            </AppButton>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}

                        {answeredQuestions.length > 0 && (
                            <details className={cn("rounded-[8px] border border-[color:var(--ui-form-surface-border)]", pageInsetSurfaceClass)}>
                                <summary className="cursor-pointer list-none text-sm font-semibold text-[color:var(--text-primary)]">
                                    Answered decisions ({answeredQuestions.length})
                                </summary>
                                <div className="mt-3 space-y-3">
                                    {answeredQuestions.map(question => (
                                        <div key={question.id} className="flex items-start gap-3 text-sm">
                                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
                                            <div className="min-w-0">
                                                <p className="font-medium text-[color:var(--text-primary)]">{question.question}</p>
                                                <p className={cn("mt-1 text-xs", pageMutedTextClass)}>
                                                    Answered: {typeof question.answer === "string" ? labelImportOption(question.answer) : JSON.stringify(question.answer)}
                                                </p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </details>
                        )}
                    </div>
                </div>
            </AppPanel>
        </div>
    );
}
