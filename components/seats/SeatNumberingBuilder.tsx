"use client";

import { Hash, Plus, Trash2 } from "lucide-react";
import { AppSelect } from "@/components/ui";
import {
    formControlClass,
    formHelpTextClass,
    formInlineControlClass,
    formLabelClass,
    formSurfaceClass,
} from "@/components/ui/formSurface";
import {
    FORM_LIMITS,
    parseIntegerField,
} from "@/lib/formValidation";
import {
    generateSeatLabels,
    type SeatNumberingConfig,
    type SeatNumberingRange,
    type SeatNumberingSeparator,
} from "@/lib/seatNumbering";
import { cn } from "@/lib/utils";

interface SeatNumberingBuilderProps {
    value: SeatNumberingConfig;
    onChange: (value: SeatNumberingConfig) => void;
    expectedCount?: number;
    disabled?: boolean;
    className?: string;
}

const SEPARATOR_OPTIONS: Array<{ value: SeatNumberingSeparator; label: string }> = [
    { value: "", label: "None" },
    { value: "-", label: "-" },
    { value: " ", label: "Space" },
    { value: "/", label: "/" },
];

export function createSimpleSeatNumbering(count = 0): SeatNumberingConfig {
    return { mode: "SIMPLE", count };
}

export function createRangeSeatNumbering(count = 10): SeatNumberingConfig {
    return {
        mode: "RANGE",
        ranges: [{
            prefix: "A",
            start: 1,
            end: Math.max(1, count),
            separator: "",
        }],
    };
}

export function resolveSeatNumberingForCount(value: SeatNumberingConfig, count: number): SeatNumberingConfig {
    return value.mode === "SIMPLE" ? { mode: "SIMPLE", count } : value;
}

function createNextRange(existingCount: number): SeatNumberingRange {
    const prefixIndex = existingCount % 26;
    return {
        prefix: String.fromCharCode(65 + prefixIndex),
        start: 1,
        end: 10,
        separator: "",
    };
}

function rangeCount(range: SeatNumberingRange) {
    return Math.max(0, range.end - range.start + 1);
}

function formatPreview(labels: string[]) {
    const sample = labels.slice(0, 12);
    return labels.length > sample.length ? [...sample, "..."] : sample;
}

export function SeatNumberingBuilder({
    value,
    onChange,
    expectedCount,
    disabled = false,
    className,
}: SeatNumberingBuilderProps) {
    const effectiveValue = expectedCount !== undefined
        ? resolveSeatNumberingForCount(value, expectedCount)
        : value;
    const labelsResult = generateSeatLabels(effectiveValue);
    const labels = labelsResult.ok ? labelsResult.value : [];
    const previewError = !labelsResult.ok
        ? labelsResult.error
        : expectedCount !== undefined && labels.length !== expectedCount
            ? `Custom ranges create ${labels.length} labels, but total seats is ${expectedCount}.`
            : null;

    const switchMode = (mode: SeatNumberingConfig["mode"]) => {
        if (mode === value.mode) return;
        if (mode === "SIMPLE") {
            onChange(createSimpleSeatNumbering(expectedCount ?? 0));
            return;
        }
        onChange(createRangeSeatNumbering(expectedCount ?? 10));
    };

    const updateSimpleCount = (rawValue: string) => {
        const countResult = parseIntegerField(rawValue, "Seat count", {
            min: 0,
            max: FORM_LIMITS.seatsMax,
        });
        onChange(createSimpleSeatNumbering(countResult.ok ? countResult.value ?? 0 : 0));
    };

    const updateRange = (index: number, patch: Partial<SeatNumberingRange>) => {
        if (value.mode !== "RANGE") return;
        onChange({
            mode: "RANGE",
            ranges: value.ranges.map((range, rangeIndex) => rangeIndex === index ? { ...range, ...patch } : range),
        });
    };

    const addRange = () => {
        if (value.mode !== "RANGE") return;
        onChange({
            mode: "RANGE",
            ranges: [...value.ranges, createNextRange(value.ranges.length)],
        });
    };

    const removeRange = (index: number) => {
        if (value.mode !== "RANGE" || value.ranges.length <= 1) return;
        onChange({
            mode: "RANGE",
            ranges: value.ranges.filter((_, rangeIndex) => rangeIndex !== index),
        });
    };

    return (
        <div className={cn("space-y-3", className)}>
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => switchMode("SIMPLE")}
                    className={cn(
                        "inline-flex items-center gap-2 rounded-[var(--ui-radius-control)] border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]",
                        value.mode === "SIMPLE"
                            ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]"
                            : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] text-[color:var(--ui-form-help)] hover:border-[color:var(--ui-form-input-border)]"
                    )}
                    aria-pressed={value.mode === "SIMPLE"}
                >
                    <Hash size={15} />
                    Default
                </button>
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => switchMode("RANGE")}
                    className={cn(
                        "inline-flex items-center gap-2 rounded-[var(--ui-radius-control)] border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]",
                        value.mode === "RANGE"
                            ? "border-[color:var(--ui-badge-cyan-border)] bg-[color:var(--ui-badge-cyan-bg)] text-[color:var(--ui-badge-cyan-text)]"
                            : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] text-[color:var(--ui-form-help)] hover:border-[color:var(--ui-form-input-border)]"
                    )}
                    aria-pressed={value.mode === "RANGE"}
                >
                    <Hash size={15} />
                    Custom ranges
                </button>
            </div>

            {value.mode === "SIMPLE" && expectedCount === undefined && (
                <div className="max-w-xs space-y-1.5">
                    <label className={formLabelClass}>Seat count</label>
                    <input
                        aria-label="Seat count"
                        type="number"
                        min="1"
                        max={FORM_LIMITS.seatsMax}
                        step="1"
                        inputMode="numeric"
                        disabled={disabled}
                        value={value.count}
                        onChange={(event) => updateSimpleCount(event.target.value)}
                        className={cn(formControlClass, "px-3 py-2 text-sm")}
                    />
                </div>
            )}

            {value.mode === "RANGE" && (
                <div className="space-y-3">
                    {value.ranges.map((range, index) => (
                        <div key={index} className={cn("space-y-3 p-3", formSurfaceClass)}>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-12">
                                <div className="col-span-2 sm:col-span-3">
                                    <label className={cn("mb-1 block text-[10px] uppercase", formHelpTextClass)}>Prefix</label>
                                    <input
                                        aria-label={`Range ${index + 1} prefix`}
                                        type="text"
                                        disabled={disabled}
                                        value={range.prefix}
                                        maxLength={16}
                                        onChange={(event) => updateRange(index, { prefix: event.target.value })}
                                        className={cn(formInlineControlClass, "py-1 text-xs")}
                                        placeholder="A"
                                    />
                                </div>
                                <div className="sm:col-span-2">
                                    <label className={cn("mb-1 block text-[10px] uppercase", formHelpTextClass)}>Start</label>
                                    <input
                                        aria-label={`Range ${index + 1} start`}
                                        type="number"
                                        disabled={disabled}
                                        value={range.start}
                                        min={0}
                                        max={FORM_LIMITS.seatsMax}
                                        step={1}
                                        onChange={(event) => updateRange(index, { start: Number(event.target.value) || 0 })}
                                        className={cn(formInlineControlClass, "py-1 text-xs")}
                                    />
                                </div>
                                <div className="sm:col-span-2">
                                    <label className={cn("mb-1 block text-[10px] uppercase", formHelpTextClass)}>End</label>
                                    <input
                                        aria-label={`Range ${index + 1} end`}
                                        type="number"
                                        disabled={disabled}
                                        value={range.end}
                                        min={0}
                                        max={FORM_LIMITS.seatsMax}
                                        step={1}
                                        onChange={(event) => updateRange(index, { end: Number(event.target.value) || 0 })}
                                        className={cn(formInlineControlClass, "py-1 text-xs")}
                                    />
                                </div>
                                <div className="sm:col-span-2">
                                    <label className={cn("mb-1 block text-[10px] uppercase", formHelpTextClass)}>Padding</label>
                                    <input
                                        aria-label={`Range ${index + 1} padding`}
                                        type="number"
                                        disabled={disabled}
                                        value={range.padTo ?? 0}
                                        min={0}
                                        max={FORM_LIMITS.seatLabelMax}
                                        step={1}
                                        onChange={(event) => updateRange(index, { padTo: Number(event.target.value) || undefined })}
                                        className={cn(formInlineControlClass, "py-1 text-xs")}
                                    />
                                </div>
                                <div className="sm:col-span-2">
                                    <label htmlFor={`seat-range-${index}-separator`} className={cn("mb-1 block text-[10px] uppercase", formHelpTextClass)}>Separator</label>
                                    <AppSelect
                                        id={`seat-range-${index}-separator`}
                                        aria-label={`Range ${index + 1} separator`}
                                        disabled={disabled}
                                        value={range.separator ?? ""}
                                        onValueChange={value => updateRange(index, { separator: value as SeatNumberingSeparator })}
                                        options={SEPARATOR_OPTIONS}
                                        className={cn(formInlineControlClass, "rounded-none border-x-0 border-t-0 bg-transparent px-0 py-1 text-xs lg:min-h-9")}
                                    />
                                </div>
                                <div className="flex items-end justify-end sm:col-span-1">
                                    <button
                                        type="button"
                                        disabled={disabled || value.ranges.length <= 1}
                                        onClick={() => removeRange(index)}
                                        className={cn("rounded-[var(--ui-radius-control)] p-2 transition-colors hover:text-[color:var(--ui-form-error-text)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]", formHelpTextClass)}
                                        aria-label="Remove range"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </div>
                            <div className={cn("text-xs", formHelpTextClass)}>
                                {rangeCount(range)} seats
                            </div>
                        </div>
                    ))}
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={addRange}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[color:var(--ui-form-accent)] transition-colors hover:text-[color:var(--ui-form-accent-hover)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]"
                    >
                        <Plus size={13} />
                        Add range
                    </button>
                </div>
            )}

            <div className={cn("space-y-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] p-3")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className={cn("text-xs font-semibold uppercase", formHelpTextClass)}>Preview</span>
                    <span className={cn("text-xs", previewError ? "text-[color:var(--ui-form-error-text)]" : formHelpTextClass)}>
                        {labels.length} seat{labels.length === 1 ? "" : "s"}
                    </span>
                </div>
                {previewError ? (
                    <p className="text-xs text-[color:var(--ui-form-error-text)]">{previewError}</p>
                ) : (
                    <div className="flex flex-wrap gap-1.5">
                        {formatPreview(labels).map((label, index) => (
                            <span
                                key={`${label}-${index}`}
                                className="rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-bg)] px-2 py-1 font-mono text-xs text-[color:var(--text-primary)]"
                            >
                                {label}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
