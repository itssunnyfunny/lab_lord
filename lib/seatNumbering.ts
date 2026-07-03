import { FORM_LIMITS, parseIntegerField, validateSeatLabel, type ValidationResult } from "@/lib/formValidation";

export type SeatNumberingSeparator = "" | "-" | " " | "/";

export type SeatNumberingRange = {
    prefix: string;
    start: number;
    end: number;
    padTo?: number;
    separator?: SeatNumberingSeparator;
};

export type SeatNumberingConfig =
    | { mode: "SIMPLE"; count: number }
    | { mode: "RANGE"; ranges: SeatNumberingRange[] };

const SEPARATORS = new Set<SeatNumberingSeparator>(["", "-", " ", "/"]);
const MAX_RANGES = 50;
const MAX_PAD_TO = FORM_LIMITS.seatLabelMax;
const NATURAL_LABEL_COLLATOR = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePrefix(value: unknown, label: string): ValidationResult<string> {
    if (value === undefined || value === null) return { ok: true, value: "" };
    if (typeof value !== "string") return { ok: false, error: `${label} prefix must be text.` };

    const prefix = value.trim().replace(/\s+/g, " ");
    if (prefix.length > 16) return { ok: false, error: `${label} prefix must be 16 characters or less.` };
    if (prefix && !/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(prefix)) {
        return {
            ok: false,
            error: `${label} prefix can use letters, numbers, spaces, dot, underscore, slash, or hyphen.`,
        };
    }
    return { ok: true, value: prefix };
}

function normalizeSeparator(value: unknown, label: string): ValidationResult<SeatNumberingSeparator> {
    if (value === undefined || value === null) return { ok: true, value: "" };
    if (typeof value !== "string" || !SEPARATORS.has(value as SeatNumberingSeparator)) {
        return { ok: false, error: `${label} separator is invalid.` };
    }
    return { ok: true, value: value as SeatNumberingSeparator };
}

function normalizePadTo(value: unknown, label: string): ValidationResult<number | undefined> {
    const result = parseIntegerField(value, `${label} zero padding`, {
        min: 0,
        max: MAX_PAD_TO,
    });
    if (!result.ok) return result;
    return { ok: true, value: result.value && result.value > 0 ? result.value : undefined };
}

function labelKey(label: string) {
    return label.toLowerCase();
}

export function compareSeatLabels(a: string, b: string) {
    return NATURAL_LABEL_COLLATOR.compare(a, b);
}

export function sortSeatsByLabel<T extends { label: string }>(seats: readonly T[]) {
    return [...seats].sort((a, b) => compareSeatLabels(a.label, b.label));
}

export function validateSeatNumberingConfig(
    input: unknown,
    fallbackCount?: number
): ValidationResult<SeatNumberingConfig> {
    if (input === undefined || input === null) {
        const count = fallbackCount ?? 0;
        return { ok: true, value: { mode: "SIMPLE", count } };
    }

    if (!isRecord(input)) return { ok: false, error: "Seat numbering setup is invalid." };

    const mode = typeof input.mode === "string" ? input.mode.toUpperCase() : "";
    if (mode === "SIMPLE") {
        const countResult = parseIntegerField(input.count, "Seat count", {
            required: true,
            min: 0,
            max: FORM_LIMITS.seatsMax,
        });
        if (!countResult.ok) return countResult;
        return { ok: true, value: { mode: "SIMPLE", count: countResult.value ?? 0 } };
    }

    if (mode !== "RANGE") {
        return { ok: false, error: "Seat numbering mode is invalid." };
    }

    if (!Array.isArray(input.ranges) || input.ranges.length === 0) {
        return { ok: false, error: "Add at least one seat numbering range." };
    }
    if (input.ranges.length > MAX_RANGES) {
        return { ok: false, error: `Create ${MAX_RANGES} seat numbering ranges or fewer at once.` };
    }

    const ranges: SeatNumberingRange[] = [];
    for (const [index, rawRange] of input.ranges.entries()) {
        const rangeLabel = `Range ${index + 1}`;
        if (!isRecord(rawRange)) return { ok: false, error: `${rangeLabel} is invalid.` };

        const prefixResult = normalizePrefix(rawRange.prefix, rangeLabel);
        if (!prefixResult.ok) return prefixResult;

        const startResult = parseIntegerField(rawRange.start, `${rangeLabel} start`, {
            required: true,
            min: 0,
            max: FORM_LIMITS.seatsMax,
        });
        if (!startResult.ok) return startResult;

        const endResult = parseIntegerField(rawRange.end, `${rangeLabel} end`, {
            required: true,
            min: 0,
            max: FORM_LIMITS.seatsMax,
        });
        if (!endResult.ok) return endResult;

        const start = startResult.value ?? 0;
        const end = endResult.value ?? 0;
        if (end < start) return { ok: false, error: `${rangeLabel} end must be greater than or equal to start.` };

        const padToResult = normalizePadTo(rawRange.padTo, rangeLabel);
        if (!padToResult.ok) return padToResult;

        const separatorResult = normalizeSeparator(rawRange.separator, rangeLabel);
        if (!separatorResult.ok) return separatorResult;

        ranges.push({
            prefix: prefixResult.value,
            start,
            end,
            ...(padToResult.value ? { padTo: padToResult.value } : {}),
            separator: separatorResult.value,
        });
    }

    return { ok: true, value: { mode: "RANGE", ranges } };
}

export function generateSeatLabels(config: SeatNumberingConfig): ValidationResult<string[]> {
    const rawLabels = config.mode === "SIMPLE"
        ? Array.from({ length: config.count }, (_, index) => `${index + 1}`)
        : config.ranges.flatMap(range => {
            const labels: string[] = [];
            for (let number = range.start; number <= range.end; number++) {
                const numericPart = String(number).padStart(range.padTo ?? 0, "0");
                labels.push(`${range.prefix}${range.prefix ? range.separator ?? "" : ""}${numericPart}`);
            }
            return labels;
        });

    if (rawLabels.length > FORM_LIMITS.seatsMax) {
        return { ok: false, error: `Create ${FORM_LIMITS.seatsMax} seats or fewer at once.` };
    }

    const seen = new Map<string, string>();
    const labels: string[] = [];
    for (const rawLabel of rawLabels) {
        const labelResult = validateSeatLabel(rawLabel);
        if (!labelResult.ok) return labelResult;

        const label = labelResult.value;
        const key = labelKey(label);
        const duplicate = seen.get(key);
        if (duplicate) {
            return { ok: false, error: `Seat numbering creates duplicate labels: "${duplicate}" and "${label}".` };
        }
        seen.set(key, label);
        labels.push(label);
    }

    return { ok: true, value: labels };
}

export function generateSeatLabelsForSeatCount(
    seatCount: number | undefined,
    seatNumbering?: unknown
): ValidationResult<string[]> {
    const configResult = validateSeatNumberingConfig(seatNumbering, seatCount ?? 0);
    if (!configResult.ok) return configResult;

    const labelsResult = generateSeatLabels(configResult.value);
    if (!labelsResult.ok) return labelsResult;

    if ((seatCount ?? 0) !== labelsResult.value.length) {
        return {
            ok: false,
            error: `Seat numbering creates ${labelsResult.value.length} labels, but total seats is ${seatCount ?? 0}.`,
        };
    }

    return labelsResult;
}
