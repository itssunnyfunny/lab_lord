import { parseNullableTime, timesOverlap } from "@/utils/shiftTime";

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const FORM_LIMITS = {
    nameMax: 80,
    cityMax: 80,
    phoneDigitsMin: 7,
    phoneDigitsMax: 15,
    seatLabelMax: 32,
    seatsMax: 5000,
    moneyMax: 10000000,
    shiftsMax: 12,
    multiShiftsMax: 12,
} as const;

export type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: string };

export interface ShiftDraftInput {
    name: unknown;
    startTime?: unknown;
    endTime?: unknown;
    price?: unknown;
}

export interface NormalizedShiftDraft {
    name: string;
    startTime: string | null;
    endTime: string | null;
    price: number;
}

export interface MultiShiftDraftInput {
    name: unknown;
    price?: unknown;
    componentShiftNames?: unknown;
}

export interface NormalizedMultiShiftDraft {
    name: string;
    price: number;
    componentShiftNames: string[];
}

export function compactText(value: unknown) {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function validateRequiredText(
    value: unknown,
    label: string,
    maxLength: number = FORM_LIMITS.nameMax
): ValidationResult<string> {
    const text = compactText(value);
    if (!text) return { ok: false, error: `${label} is required.` };
    if (text.length > maxLength) {
        return { ok: false, error: `${label} must be ${maxLength} characters or less.` };
    }
    return { ok: true, value: text };
}

export function validateOptionalText(
    value: unknown,
    label: string,
    maxLength: number = FORM_LIMITS.nameMax
): ValidationResult<string | undefined> {
    const text = compactText(value);
    if (!text) return { ok: true, value: undefined };
    if (text.length > maxLength) {
        return { ok: false, error: `${label} must be ${maxLength} characters or less.` };
    }
    return { ok: true, value: text };
}

export function validatePhone(value: unknown): ValidationResult<string | undefined> {
    if (value !== undefined && value !== null && typeof value !== "string") {
        return { ok: false, error: "Phone number must be text." };
    }
    const phone = compactText(value);
    if (!phone) return { ok: true, value: undefined };
    if (!/^\+?[\d\s]+$/.test(phone) || (phone.match(/\+/g)?.length ?? 0) > 1) {
        return { ok: false, error: "Phone number must be a valid Indian mobile number." };
    }
    const digits = phone.replace(/\D/g, "");
    const nationalNumber =
        digits.length === 10
            ? digits
            : digits.length === 11 && digits.startsWith("0")
                ? digits.slice(1)
                : digits.length === 12 && digits.startsWith("91")
                    ? digits.slice(2)
                    : "";

    if (!/^[6-9]\d{9}$/.test(nationalNumber)) {
        return { ok: false, error: "Phone number must be a valid Indian mobile number." };
    }

    return { ok: true, value: `+91 ${nationalNumber.slice(0, 5)} ${nationalNumber.slice(5)}` };
}

export function validateRequiredPhone(value: unknown, label = "Phone number"): ValidationResult<string> {
    if (value !== undefined && value !== null && typeof value !== "string") {
        const result = validatePhone(value);
        if (!result.ok) return result;
    }
    const phone = compactText(value);
    if (!phone) return { ok: false, error: `${label} is required.` };

    const result = validatePhone(value);
    if (!result.ok) return result;
    return { ok: true, value: result.value ?? phone };
}

export function validateOptionalEmail(value: unknown, label: string): ValidationResult<string | undefined> {
    const text = compactText(value);
    if (!text) return { ok: true, value: undefined };
    if (text.length > 160) return { ok: false, error: `${label} must be 160 characters or less.` };
    if (!EMAIL_PATTERN.test(text)) return { ok: false, error: `${label} must be a valid email.` };
    return { ok: true, value: text };
}

export function parseIntegerField(
    value: unknown,
    label: string,
    options: { required?: boolean; min?: number; max?: number } = {}
): ValidationResult<number | undefined> {
    const { required = false, min = 0, max = FORM_LIMITS.moneyMax } = options;
    if (value !== undefined && value !== null && typeof value !== "string" && typeof value !== "number") {
        return { ok: false, error: `${label} must be a whole number.` };
    }
    const raw = typeof value === "number" ? String(value) : compactText(value);

    if (!raw) {
        if (required) return { ok: false, error: `${label} is required.` };
        return { ok: true, value: undefined };
    }

    if (!/^\d+$/.test(raw)) {
        return { ok: false, error: `${label} must be a whole number.` };
    }

    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) return { ok: false, error: `${label} is too large.` };
    if (parsed < min) return { ok: false, error: `${label} must be at least ${min}.` };
    if (parsed > max) return { ok: false, error: `${label} must be ${max} or less.` };

    return { ok: true, value: parsed };
}

export function validateSeatLabel(value: unknown): ValidationResult<string> {
    const label = compactText(value);
    if (!label) return { ok: false, error: "Seat label is required." };
    if (label.length > FORM_LIMITS.seatLabelMax) {
        return { ok: false, error: `Seat label must be ${FORM_LIMITS.seatLabelMax} characters or less.` };
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(label)) {
        return {
            ok: false,
            error: "Seat label can use letters, numbers, spaces, dot, underscore, slash, or hyphen.",
        };
    }
    return { ok: true, value: label };
}

export function validateOptionalId(value: unknown, label: string): ValidationResult<string | null | undefined> {
    if (value === undefined) return { ok: true, value: undefined };
    if (value === null || value === "") return { ok: true, value: null };
    if (typeof value !== "string") return { ok: false, error: `${label} is invalid.` };
    const id = compactText(value);
    if (!id) return { ok: true, value: null };
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return { ok: false, error: `${label} is invalid.` };
    return { ok: true, value: id };
}

export function validateOptionalTime(value: unknown, label: string): ValidationResult<string | null> {
    const time = compactText(value);
    if (!time) return { ok: true, value: null };
    if (!TIME_PATTERN.test(time)) return { ok: false, error: `${label} must use HH:mm format.` };
    return { ok: true, value: time };
}

export function validateShiftDrafts(
    input: ShiftDraftInput[],
    options: { allowEmpty?: boolean } = {}
): ValidationResult<NormalizedShiftDraft[]> {
    const allowEmpty = options.allowEmpty ?? true;
    const activeRows = input
        .map((shift, index) => ({ shift, index }))
        .filter(({ shift }) => {
            if (!allowEmpty) return true;
            return (
                !!compactText(shift.name) ||
                !!compactText(shift.startTime) ||
                !!compactText(shift.endTime) ||
                compactText(shift.price) !== ""
            );
        });

    if (activeRows.length > FORM_LIMITS.shiftsMax) {
        return { ok: false, error: `Create ${FORM_LIMITS.shiftsMax} shifts or fewer at once.` };
    }

    const seenNames = new Set<string>();
    const normalized: NormalizedShiftDraft[] = [];

    for (const { shift, index } of activeRows) {
        const rowLabel = `Shift ${index + 1}`;
        const nameResult = validateRequiredText(shift.name, `${rowLabel} name`, 50);
        if (!nameResult.ok) return nameResult;

        const nameKey = nameResult.value.toLowerCase();
        if (seenNames.has(nameKey)) return { ok: false, error: `Duplicate shift name: ${nameResult.value}.` };
        seenNames.add(nameKey);

        const startResult = validateOptionalTime(shift.startTime, `${rowLabel} start time`);
        if (!startResult.ok) return startResult;
        const endResult = validateOptionalTime(shift.endTime, `${rowLabel} end time`);
        if (!endResult.ok) return endResult;
        const startTime = startResult.value;
        const endTime = endResult.value;
        if ((startTime && !endTime) || (!startTime && endTime)) {
            return { ok: false, error: `${rowLabel} must have both start and end time, or neither.` };
        }

        const priceResult = parseIntegerField(shift.price, `${rowLabel} price`, {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        if (!priceResult.ok) return priceResult;

        normalized.push({
            name: nameResult.value,
            startTime,
            endTime,
            price: priceResult.value ?? 0,
        });
    }

    for (let i = 0; i < normalized.length; i++) {
        for (let j = i + 1; j < normalized.length; j++) {
            const a = normalized[i];
            const b = normalized[j];
            if (
                timesOverlap(
                    parseNullableTime(a.startTime),
                    parseNullableTime(a.endTime),
                    parseNullableTime(b.startTime),
                    parseNullableTime(b.endTime)
                )
            ) {
                return { ok: false, error: `"${b.name}" overlaps with "${a.name}".` };
            }
        }
    }

    return { ok: true, value: normalized };
}

export function validateMultiShiftDrafts(
    input: MultiShiftDraftInput[],
    primaryShifts: ReadonlyArray<{ name: string }>,
    options: { allowEmpty?: boolean } = {}
): ValidationResult<NormalizedMultiShiftDraft[]> {
    const allowEmpty = options.allowEmpty ?? true;
    const primaryByName = new Map<string, string>();

    for (const shift of primaryShifts) {
        const name = compactText(shift.name);
        if (name) primaryByName.set(name.toLowerCase(), name);
    }

    const activeRows = input
        .map((multiShift, index) => ({ multiShift, index }))
        .filter(({ multiShift }) => {
            if (!allowEmpty) return true;
            const components = Array.isArray(multiShift.componentShiftNames)
                ? multiShift.componentShiftNames
                : [];
            return (
                !!compactText(multiShift.name) ||
                compactText(multiShift.price) !== "" ||
                components.some(component => !!compactText(component))
            );
        });

    if (activeRows.length > FORM_LIMITS.multiShiftsMax) {
        return { ok: false, error: `Create ${FORM_LIMITS.multiShiftsMax} multi-shifts or fewer at once.` };
    }

    const seenNames = new Set<string>();
    const seenCombinations = new Map<string, string>();
    const normalized: NormalizedMultiShiftDraft[] = [];

    for (const { multiShift, index } of activeRows) {
        const rowLabel = `Multi-shift ${index + 1}`;
        const nameResult = validateRequiredText(multiShift.name, `${rowLabel} name`, 50);
        if (!nameResult.ok) return nameResult;

        const nameKey = nameResult.value.toLowerCase();
        if (seenNames.has(nameKey)) {
            return { ok: false, error: `Duplicate multi-shift name: ${nameResult.value}.` };
        }
        seenNames.add(nameKey);

        const priceResult = parseIntegerField(multiShift.price, `${rowLabel} price`, {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        if (!priceResult.ok) return priceResult;

        if (!Array.isArray(multiShift.componentShiftNames)) {
            return { ok: false, error: `${rowLabel} must select at least 2 primary shifts.` };
        }

        const componentNames: string[] = [];
        const componentKeys = new Set<string>();

        for (const rawName of multiShift.componentShiftNames) {
            const componentName = compactText(rawName);
            if (!componentName) continue;

            const componentKey = componentName.toLowerCase();
            const primaryName = primaryByName.get(componentKey);
            if (!primaryName) {
                return { ok: false, error: `${rowLabel} includes an unknown primary shift: ${componentName}.` };
            }
            if (componentKeys.has(componentKey)) {
                return { ok: false, error: `${rowLabel} includes the same primary shift more than once.` };
            }

            componentKeys.add(componentKey);
            componentNames.push(primaryName);
        }

        if (componentNames.length < 2) {
            return { ok: false, error: `${rowLabel} must select at least 2 primary shifts.` };
        }

        const combinationKey = [...componentKeys].sort().join(",");
        const duplicateCombinationName = seenCombinations.get(combinationKey);
        if (duplicateCombinationName) {
            return {
                ok: false,
                error: `${rowLabel} uses the same primary shifts as "${duplicateCombinationName}".`,
            };
        }
        seenCombinations.set(combinationKey, nameResult.value);

        normalized.push({
            name: nameResult.value,
            price: priceResult.value ?? 0,
            componentShiftNames: componentNames,
        });
    }

    return { ok: true, value: normalized };
}
