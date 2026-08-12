"use client";

import { ReactNode, createContext, useContext, useEffect, useId, useRef } from "react";
import { CheckCircle2, AlertCircle, LucideIcon } from "lucide-react";
import { AppButton, AppSelect, PageShell, type AppSelectProps } from "@/components/ui";
import {
    formControlClass,
    formHelpTextClass,
    formLabelClass,
} from "@/components/ui/formSurface";
import { FieldError, fieldErrorClass, fieldErrorProps } from "@/components/ui/InlineFieldError";
import {
    pageFilterShellClass,
    pageGridCardClass,
    pageGridCardHoverClass,
    pageMutedTextClass,
    pageSubtleTextClass,
} from "@/components/ui/pageSurface";
import { cn } from "@/lib/utils";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Toggle } from "@/components/ui/Toggle";

export interface SettingsSection {
    id: string;
    label: string;
    icon: LucideIcon;
}

export function SettingsWorkspace({
    title,
    subtitle,
    sections,
    activeSection,
    onSectionChange,
    actions,
    children,
}: {
    title: string;
    subtitle: string;
    sections: SettingsSection[];
    activeSection: string;
    onSectionChange: (section: string) => void;
    actions?: ReactNode;
    children: ReactNode;
}) {
    const clickedSectionRef = useRef<string | null>(null);

    useEffect(() => {
        const panels = sections
            .map(section => document.getElementById(section.id))
            .filter((panel): panel is HTMLElement => Boolean(panel));

        if (panels.length === 0) return;

        const observer = new IntersectionObserver(
            entries => {
                const visible = entries
                    .filter(entry => entry.isIntersecting)
                    .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

                if (!visible?.target.id) return;
                if (clickedSectionRef.current === visible.target.id) {
                    clickedSectionRef.current = null;
                }
                onSectionChange(visible.target.id);
            },
            {
                root: null,
                rootMargin: "-20% 0px -55% 0px",
                threshold: [0.15, 0.3, 0.6],
            }
        );

        panels.forEach(panel => observer.observe(panel));
        return () => observer.disconnect();
    }, [onSectionChange, sections]);

    const handleSectionClick = (sectionId: string) => {
        clickedSectionRef.current = sectionId;
        onSectionChange(sectionId);
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        document.getElementById(sectionId)?.scrollIntoView({
            behavior: reduceMotion ? "auto" : "smooth",
            block: "start",
        });
    };

    return (
        <div>
            <PageShell>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <h1 className="text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">{title}</h1>
                    <p className={cn("mt-1 max-w-2xl text-sm leading-6", pageMutedTextClass)}>{subtitle}</p>
                </div>
                {actions ? <div className="shrink-0">{actions}</div> : null}
            </div>

            <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
                <nav className={cn("h-max p-1.5 lg:sticky lg:top-6", pageFilterShellClass)}>
                    {sections.map(section => {
                        const Icon = section.icon;
                        const active = activeSection === section.id;
                        return (
                            <button
                                key={section.id}
                                type="button"
                                onClick={() => handleSectionClick(section.id)}
                                aria-current={active ? "location" : undefined}
                                className={cn(
                                    "flex w-full items-center gap-3 rounded-[var(--ui-radius-control)] border px-3 py-2.5 text-left text-sm transition-colors",
                                    active
                                        ? "border-[color:var(--ui-form-input-focus-border)] bg-[color:var(--ui-form-input-bg)] text-[color:var(--text-primary)]"
                                        : "border-transparent text-[color:var(--text-secondary)] hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--text-primary)]"
                                )}
                            >
                                <Icon size={15} />
                                <span className="font-medium">{section.label}</span>
                            </button>
                        );
                    })}
                </nav>
                <div className="min-w-0 space-y-5 pb-24">{children}</div>
            </div>
            </PageShell>
        </div>
    );
}

type SettingsFieldContextValue = {
    controlId: string;
    labelId: string;
    describedBy?: string;
};

const SettingsFieldContext = createContext<SettingsFieldContextValue | null>(null);

function mergeDescribedBy(...values: Array<string | undefined>) {
    const ids = values.flatMap(value => value?.split(/\s+/).filter(Boolean) ?? []);
    return ids.length > 0 ? [...new Set(ids)].join(" ") : undefined;
}

export function SettingsPanel({
    id,
    title,
    description,
    icon: Icon,
    children,
}: {
    id: string;
    title: string;
    description?: string;
    icon: LucideIcon;
    children: ReactNode;
}) {
    return (
        <section id={id} className="scroll-mt-6 overflow-hidden rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-panel-border)] bg-[color:var(--ui-panel-bg)] shadow-[var(--ui-panel-shadow)]">
            <div className="flex items-start gap-3 border-b border-[color:var(--ui-panel-header-border)] bg-[color:var(--ui-form-muted-surface-bg)] px-5 py-4">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] text-[color:var(--ui-form-accent)]">
                    <Icon size={16} />
                </div>
                <div className="min-w-0">
                    <h2 className="text-base font-semibold text-[color:var(--ui-panel-title)]">{title}</h2>
                    {description && <p className={cn("mt-0.5 text-xs leading-5", pageMutedTextClass)}>{description}</p>}
                </div>
            </div>
            <div className="divide-y divide-[color:var(--ui-form-section-divider)]">{children}</div>
        </section>
    );
}

export function SettingsField({
    label,
    description,
    error,
    errorId,
    children,
}: {
    label: string;
    description?: string;
    error?: string | null;
    errorId?: string;
    children: ReactNode;
}) {
    const generatedId = useId();
    const controlId = `settings-field-${generatedId.replace(/:/g, "")}`;
    const labelId = `${controlId}-label`;
    const descriptionId = description ? `${controlId}-description` : undefined;
    const resolvedErrorId = errorId ?? (error ? `${controlId}-error` : undefined);
    const describedBy = mergeDescribedBy(descriptionId, error ? resolvedErrorId : undefined);

    return (
        <div className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(170px,220px)_minmax(0,1fr)] md:items-center">
            <div>
                <label id={labelId} htmlFor={controlId} className={formLabelClass}>{label}</label>
                {description && <p id={descriptionId} className={cn("mt-1 text-xs leading-relaxed", formHelpTextClass)}>{description}</p>}
            </div>
            <div className="min-w-0">
                <SettingsFieldContext.Provider value={{ controlId, labelId, describedBy }}>
                    {children}
                </SettingsFieldContext.Provider>
                <FieldError id={resolvedErrorId} error={error} />
            </div>
        </div>
    );
}

export function SettingsInput({
    error,
    errorId,
    className,
    ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { error?: string | null; errorId?: string }) {
    const field = useContext(SettingsFieldContext);
    const describedBy = mergeDescribedBy(props["aria-describedby"], field?.describedBy, error ? errorId : undefined);
    return (
        <input
            {...props}
            {...(errorId ? fieldErrorProps(errorId, error) : {})}
            id={props.id ?? field?.controlId}
            aria-describedby={describedBy}
            className={cn(
                formControlClass,
                "px-3 py-2 text-sm",
                fieldErrorClass(error),
                className
            )}
        />
    );
}

export function SettingsTextArea({
    error,
    errorId,
    className,
    ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { error?: string | null; errorId?: string }) {
    const field = useContext(SettingsFieldContext);
    const describedBy = mergeDescribedBy(props["aria-describedby"], field?.describedBy, error ? errorId : undefined);
    return (
        <textarea
            {...props}
            {...(errorId ? fieldErrorProps(errorId, error) : {})}
            id={props.id ?? field?.controlId}
            aria-describedby={describedBy}
            className={cn(
                formControlClass,
                "min-h-24 resize-y px-3 py-2 text-sm",
                fieldErrorClass(error),
                className
            )}
        />
    );
}

export function SettingsSelect({
    error,
    errorId,
    className,
    ...props
}: AppSelectProps) {
    const field = useContext(SettingsFieldContext);
    const describedBy = mergeDescribedBy(props["aria-describedby"], field?.describedBy, error ? errorId : undefined);
    return (
        <AppSelect
            {...props}
            id={props.id ?? field?.controlId}
            aria-labelledby={props["aria-labelledby"] ?? field?.labelId}
            aria-describedby={describedBy}
            aria-invalid={Boolean(error)}
            className={cn(
                fieldErrorClass(error),
                className
            )}
        />
    );
}

export function SettingsToggle({
    checked,
    onChange,
    label,
    description,
    disabled = false,
}: {
    checked: boolean;
    onChange: (value: boolean) => void;
    label: string;
    description?: string;
    disabled?: boolean;
}) {
    const field = useContext(SettingsFieldContext);
    return <Toggle
        id={field?.controlId}
        checked={checked}
        onCheckedChange={onChange}
        label={label}
        description={description}
        labelledBy={field?.labelId}
        describedBy={field?.describedBy}
        disabled={disabled}
    />;
}

export function SegmentedControl<T extends string>({
    value,
    options,
    onChange,
    disabled = false,
}: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (value: T) => void;
    disabled?: boolean;
}) {
    const field = useContext(SettingsFieldContext);
    return (
        <RadioGroup
            id={field?.controlId}
            value={value}
            options={options.map(option => ({ ...option, disabled }))}
            onChange={onChange}
            labelledBy={field?.labelId}
            describedBy={field?.describedBy}
        />
    );
}

export function ReadOnlyRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="flex flex-col items-start justify-between gap-2 px-5 py-3 text-sm sm:flex-row sm:gap-4">
            <span className={formHelpTextClass}>{label}</span>
            <span className="min-w-0 max-w-full break-words text-left font-medium text-[color:var(--ui-form-label)] sm:text-right">{value}</span>
        </div>
    );
}

export function SettingsCard({
    children,
    className,
    onClick,
}: {
    children: ReactNode;
    className?: string;
    onClick?: () => void;
}) {
    if (onClick) {
        return (
            <button
                type="button"
                onClick={onClick}
                className={cn("w-full text-left", pageGridCardClass, pageGridCardHoverClass, className)}
            >
                {children}
            </button>
        );
    }

    return <div className={cn(pageGridCardClass, className)}>{children}</div>;
}

export function SettingsEmptyState({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center rounded-[var(--ui-table-radius)] border border-dashed border-[color:var(--ui-table-empty-border)] bg-[color:var(--ui-table-bg)] px-4 py-6 text-center text-sm text-[color:var(--ui-table-subtle)]",
                className
            )}
        >
            {children}
        </div>
    );
}

export function SettingsText({ children, className }: { children: ReactNode; className?: string }) {
    return <p className={cn("text-sm leading-6", pageMutedTextClass, className)}>{children}</p>;
}

export function SettingsSubtleText({ children, className }: { children: ReactNode; className?: string }) {
    return <p className={cn("text-xs leading-5", pageSubtleTextClass, className)}>{children}</p>;
}

export function SettingsSaveBar({
    visible,
    hasChanges,
    saving,
    status,
    error,
    onSave,
    onCancel,
}: {
    visible: boolean;
    hasChanges: boolean;
    saving: boolean;
    status: "idle" | "success" | "error";
    error?: string;
    onSave: () => void;
    onCancel: () => void;
}) {
    if (!visible && status === "idle") return null;

    return (
        <div
            className="fixed left-1/2 z-50 w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-savebar-bg)] p-3 [bottom:max(1.25rem,env(safe-area-inset-bottom))] shadow-[var(--ui-form-dialog-shadow)] backdrop-blur"
            role={status === "error" ? "alert" : "status"}
            aria-live={status === "error" ? "assertive" : "polite"}
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                    {status === "success" ? (
                        <span className="flex items-center gap-2 text-[color:var(--ui-tone-success-text)]"><CheckCircle2 size={15} /> Settings saved.</span>
                    ) : status === "error" ? (
                        <span className="flex items-center gap-2 text-[color:var(--ui-form-error-text)]"><AlertCircle size={15} /> {error || "Save failed."}</span>
                    ) : hasChanges ? (
                        <span className="text-[color:var(--ui-form-label)]">You have unsaved settings changes.</span>
                    ) : (
                        <span className="text-[color:var(--ui-form-label)]">Editing settings.</span>
                    )}
                </div>
                {visible ? (
                    <div className="flex justify-end gap-2">
                        <AppButton variant="quiet" size="sm" onClick={onCancel} disabled={saving} className="min-h-11 lg:min-h-9">
                            Cancel
                        </AppButton>
                        <AppButton variant="primary" size="sm" onClick={onSave} disabled={!hasChanges || saving} isLoading={saving} className="min-h-11 min-w-[110px] lg:min-h-9">
                            {saving ? "Saving" : "Save changes"}
                        </AppButton>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
