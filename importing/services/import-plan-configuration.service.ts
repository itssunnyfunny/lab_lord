import type { Prisma } from "@/app/generated/prisma/client";
import type {
    ImportPlanSnapshot,
    ImportPreviouslySucceededMutation,
} from "../contracts/import-v2.contract";
import { validateRequiredText, validateSeatLabel } from "@/lib/formValidation";
import { parseNullableTime, timesOverlap } from "@/utils/shiftTime";

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function optionalString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function key(value: string) {
    return value.trim().toLocaleLowerCase("en-IN");
}

function validatePlannedConfigurationIdentity(type: string, identity: string) {
    const result = type === "seat"
        ? validateSeatLabel(identity)
        : type === "shift"
            ? validateRequiredText(identity, "Shift name", 50)
            : type === "multi-shift"
                ? validateRequiredText(identity, "Multi-shift name", 50)
                : null;
    if (!result) throw new Error("Import plan configuration is invalid: Configuration type is unsupported.");
    if (!result.ok) throw new Error(`Import plan configuration is invalid: ${result.error}`);
    return result.value;
}

function optionalInteger(value: unknown) {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function shiftDefinitionMatches(
    existing: { startTime: string | null; endTime: string | null; price: number; isReserved: boolean },
    payload: Record<string, unknown>
) {
    return existing.startTime === (optionalString(payload.startTime) ?? null)
        && existing.endTime === (optionalString(payload.endTime) ?? null)
        && existing.price === (optionalInteger(payload.price) ?? 0)
        && !existing.isReserved;
}

type ShiftTimeWindow = {
    name: string;
    startTime: string | null;
    endTime: string | null;
};

function shiftTimeWindowsOverlap(left: ShiftTimeWindow, right: ShiftTimeWindow) {
    return timesOverlap(
        parseNullableTime(left.startTime),
        parseNullableTime(left.endTime),
        parseNullableTime(right.startTime),
        parseNullableTime(right.endTime)
    );
}

function reviewedShiftWindow(payload: Record<string, unknown>): ShiftTimeWindow {
    const name = optionalString(payload.name);
    if (!name) throw new Error("Import plan configuration is invalid");
    return {
        name,
        startTime: optionalString(payload.startTime) ?? null,
        endTime: optionalString(payload.endTime) ?? null,
    };
}

function multiShiftDefinitionMatches(
    existing: { price: number; components: Array<{ shift: { name: string } }> },
    payload: Record<string, unknown>
) {
    const expectedNames = Array.isArray(payload.componentShiftNames)
        ? payload.componentShiftNames
            .map(value => optionalString(value))
            .filter((value): value is string => Boolean(value))
            .map(key)
        : [];
    const existingNames = existing.components.map(component => key(component.shift.name));
    return existing.price === (optionalInteger(payload.price) ?? 0)
        && existingNames.length === expectedNames.length
        && existingNames.every((name, index) => name === expectedNames[index]);
}

function multiShiftComponentsAreCurrent(
    existing: { components: Array<{ shift: { branchId: string; status: string } }> },
    branchId: string
) {
    return existing.components.length > 0
        && existing.components.every(component =>
            component.shift.branchId === branchId && component.shift.status === "ACTIVE"
        );
}

function reviewedMultiShiftComponentNames(name: string, payload: Record<string, unknown>) {
    const rawComponents = payload.componentShiftNames;
    if (!Array.isArray(rawComponents) || rawComponents.length < 2) {
        throw new Error(
            `Import plan cannot create multi-shift "${name}" because it must contain at least 2 distinct primary shifts`
        );
    }
    const componentNames = rawComponents.map(value => optionalString(value));
    if (componentNames.some(componentName => !componentName)) {
        throw new Error(
            `Import plan cannot create multi-shift "${name}" because every component shift must be valid`
        );
    }
    const names = componentNames as string[];
    const distinctNames = new Set(names.map(key));
    if (distinctNames.size !== names.length) {
        throw new Error(
            `Import plan cannot create multi-shift "${name}" because component shifts must be distinct`
        );
    }
    return names;
}

function multiShiftCombinationKey(componentNames: string[]) {
    return componentNames.map(key).sort().join("\u0000");
}

export async function reusableSucceededConfigurationItemKeys(
    tx: Prisma.TransactionClient,
    branchId: string,
    snapshot: Pick<ImportPlanSnapshot, "items">,
    succeededItems: ImportPreviouslySucceededMutation[]
) {
    const configPayloadByKey = new Map(snapshot.items
        .filter(item => item.kind === "CONFIG")
        .map(item => [item.itemKey, asRecord(item.payload)]));
    const candidates = succeededItems.filter(item =>
        item.kind === "CONFIG"
        && item.entityIds[0]
        && configPayloadByKey.has(item.itemKey)
    );
    const seatIds = candidates
        .filter(item => configPayloadByKey.get(item.itemKey)?.type === "seat")
        .map(item => item.entityIds[0]);
    const shiftIds = candidates
        .filter(item => configPayloadByKey.get(item.itemKey)?.type === "shift")
        .map(item => item.entityIds[0]);
    const multiShiftIds = candidates
        .filter(item => configPayloadByKey.get(item.itemKey)?.type === "multi-shift")
        .map(item => item.entityIds[0]);
    const [seats, shifts, multiShifts] = await Promise.all([
        seatIds.length > 0
            ? tx.seat.findMany({ where: { id: { in: seatIds }, branchId }, select: { id: true, label: true } })
            : [],
        shiftIds.length > 0
            ? tx.shift.findMany({
                where: { id: { in: shiftIds }, branchId, status: "ACTIVE" },
                select: { id: true, name: true, startTime: true, endTime: true, price: true, isReserved: true },
            })
            : [],
        multiShiftIds.length > 0
            ? tx.multiShift.findMany({
                where: { id: { in: multiShiftIds }, branchId },
                select: {
                    id: true,
                    name: true,
                    price: true,
                    components: {
                        orderBy: { order: "asc" },
                        select: { shift: { select: { name: true, branchId: true, status: true } } },
                    },
                },
            })
            : [],
    ]);
    const seatsById = new Map(seats.map(seat => [seat.id, seat]));
    const shiftsById = new Map(shifts.map(shift => [shift.id, shift]));
    const multiShiftsById = new Map(multiShifts.map(multiShift => [multiShift.id, multiShift]));

    return candidates.flatMap(item => {
        const payload = configPayloadByKey.get(item.itemKey)!;
        const entityId = item.entityIds[0];
        const type = optionalString(payload.type);
        const matches = type === "seat"
            ? key(seatsById.get(entityId)?.label ?? "") === key(optionalString(payload.label) ?? "")
            : type === "shift"
                ? Boolean(shiftsById.get(entityId) && shiftDefinitionMatches(shiftsById.get(entityId)!, payload))
                : type === "multi-shift"
                    ? Boolean(
                        multiShiftsById.get(entityId)
                        && multiShiftComponentsAreCurrent(multiShiftsById.get(entityId)!, branchId)
                        && multiShiftDefinitionMatches(multiShiftsById.get(entityId)!, payload)
                    )
                    : false;
        return matches ? [item.itemKey] : [];
    });
}

/**
 * Revalidates every branch-owned object named by an immutable plan snapshot.
 * The executor repeats object checks in its mutation transaction; this guard
 * rejects stale plans before work is enqueued.
 */
export async function assertImportPlanConfigurationCurrent(
    tx: Prisma.TransactionClient,
    branchId: string,
    snapshot: ImportPlanSnapshot,
    options: { allowUnapprovedConfiguration?: boolean } = {}
) {
    const [seats, shifts, multiShifts] = await Promise.all([
        tx.seat.findMany({
            where: { branchId },
            select: { label: true },
        }),
        tx.shift.findMany({
            where: { branchId, status: "ACTIVE" },
            select: { name: true, startTime: true, endTime: true, price: true, isReserved: true },
        }),
        tx.multiShift.findMany({
            where: { branchId },
            select: {
                name: true,
                price: true,
                components: {
                    orderBy: { order: "asc" },
                    select: { shift: { select: { name: true, branchId: true, status: true } } },
                },
            },
        }),
    ]);
    const seatsByLabel = new Map(seats.map(seat => [key(seat.label), seat]));
    const shiftsByName = new Map(shifts.map(shift => [key(shift.name), shift]));
    const multiShiftsByName = new Map(multiShifts.map(multiShift => [key(multiShift.name), multiShift]));
    const plannedSeats = new Map<string, Record<string, unknown>>();
    const plannedShifts = new Map<string, Record<string, unknown>>();
    const plannedMultiShifts = new Map<string, Record<string, unknown>>();

    for (const item of snapshot.items.filter(candidate => candidate.kind === "CONFIG")) {
        const payload = asRecord(item.payload);
        const type = optionalString(payload.type);
        const identity = optionalString(type === "seat" ? payload.label : payload.name);
        if (!type || !identity) throw new Error("Import plan configuration is invalid");
        const normalizedIdentity = validatePlannedConfigurationIdentity(type, identity);
        const target = type === "seat"
            ? plannedSeats
            : type === "shift"
                ? plannedShifts
                : type === "multi-shift"
                    ? plannedMultiShifts
                    : null;
        if (!target) throw new Error("Import plan configuration is invalid");
        target.set(key(normalizedIdentity), payload);
    }

    const configurationMayBeCreated = snapshot.configurationApproval.approved
        || options.allowUnapprovedConfiguration === true;
    const requireSeat = (label: string) => {
        if (seatsByLabel.has(key(label))) return;
        if (configurationMayBeCreated && plannedSeats.has(key(label))) return;
        throw new Error(`Import plan is stale because seat "${label}" is unavailable`);
    };
    const requireShift = (name: string, expectedFee?: number) => {
        const existing = shiftsByName.get(key(name));
        if (existing) {
            if (expectedFee !== undefined && existing.price !== expectedFee) {
                throw new Error(`Import plan is stale because linked shift "${name}" changed price`);
            }
            return;
        }
        if (configurationMayBeCreated && plannedShifts.has(key(name))) return;
        throw new Error(`Import plan is stale because shift "${name}" is unavailable`);
    };
    const requireMultiShift = (name: string, expectedFee?: number, expectedComponents?: string[]) => {
        const existing = multiShiftsByName.get(key(name));
        if (existing) {
            if (expectedFee !== undefined && existing.price !== expectedFee) {
                throw new Error(`Import plan is stale because linked multi-shift "${name}" changed price`);
            }
            if (!multiShiftComponentsAreCurrent(existing, branchId)) {
                throw new Error(`Import plan is stale because multi-shift "${name}" has unavailable components`);
            }
            if (expectedComponents) {
                const currentComponents = existing.components.map(component => key(component.shift.name));
                const reviewedComponents = expectedComponents.map(key);
                if (
                    currentComponents.length !== reviewedComponents.length
                    || currentComponents.some((component, index) => component !== reviewedComponents[index])
                ) {
                    throw new Error(`Import plan is stale because multi-shift "${name}" changed components`);
                }
            }
            return;
        }
        if (configurationMayBeCreated && plannedMultiShifts.has(key(name))) return;
        throw new Error(`Import plan is stale because multi-shift "${name}" is unavailable`);
    };

    for (const [nameKey, payload] of plannedShifts) {
        const existing = shiftsByName.get(nameKey);
        if (!existing) continue;
        if (!shiftDefinitionMatches(existing, payload)) {
            throw new Error("Import plan is stale because a reviewed shift definition changed");
        }
    }
    if (snapshot.configurationApproval.approved) {
        // Match ShiftService.createShiftInTransaction: only missing shifts will
        // be created, null/equal endpoints are full-day, overnight windows are
        // supported, and touching boundaries do not overlap.
        const missingPlannedShifts = [...plannedShifts]
            .filter(([nameKey]) => !shiftsByName.has(nameKey))
            .map(([, payload]) => reviewedShiftWindow(payload));
        for (const planned of missingPlannedShifts) {
            for (const existing of shifts) {
                if (shiftTimeWindowsOverlap(planned, existing)) {
                    throw new Error(
                        `Import plan cannot create shift "${planned.name}" because it overlaps active shift "${existing.name}"`
                    );
                }
            }
        }
        for (let leftIndex = 0; leftIndex < missingPlannedShifts.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < missingPlannedShifts.length; rightIndex += 1) {
                const left = missingPlannedShifts[leftIndex];
                const right = missingPlannedShifts[rightIndex];
                if (shiftTimeWindowsOverlap(left, right)) {
                    throw new Error(
                        `Import plan cannot create shifts "${left.name}" and "${right.name}" because their times overlap`
                    );
                }
            }
        }
    }
    const activeExistingMultiShiftByCombination = new Map<string, string>();
    for (const existing of multiShifts) {
        if (!multiShiftComponentsAreCurrent(existing, branchId) || existing.components.length < 2) continue;
        const combination = multiShiftCombinationKey(
            existing.components.map(component => component.shift.name)
        );
        if (!activeExistingMultiShiftByCombination.has(combination)) {
            activeExistingMultiShiftByCombination.set(combination, existing.name);
        }
    }
    const plannedNewMultiShiftByCombination = new Map<string, string>();
    for (const [nameKey, payload] of plannedMultiShifts) {
        const existing = multiShiftsByName.get(nameKey);
        const reviewedName = optionalString(payload.name) ?? nameKey;
        const componentNames = snapshot.configurationApproval.approved && !existing
            ? reviewedMultiShiftComponentNames(reviewedName, payload)
            : Array.isArray(payload.componentShiftNames)
                ? payload.componentShiftNames
                    .map(value => optionalString(value))
                    .filter((value): value is string => Boolean(value))
                : [];
        for (const componentName of componentNames) requireShift(componentName);
        if (!existing) {
            if (snapshot.configurationApproval.approved) {
                const combination = multiShiftCombinationKey(componentNames);
                const existingCombinationName = activeExistingMultiShiftByCombination.get(combination);
                if (existingCombinationName) {
                    throw new Error(
                        `Import plan cannot create multi-shift "${reviewedName}" because existing multi-shift "${existingCombinationName}" uses the same primary shifts`
                    );
                }
                const plannedCombinationName = plannedNewMultiShiftByCombination.get(combination);
                if (plannedCombinationName) {
                    throw new Error(
                        `Import plan cannot create multi-shift "${reviewedName}" because planned multi-shift "${plannedCombinationName}" uses the same primary shifts`
                    );
                }
                plannedNewMultiShiftByCombination.set(combination, reviewedName);
            }
            continue;
        }
        if (
            !multiShiftComponentsAreCurrent(existing, branchId)
            || !multiShiftDefinitionMatches(existing, payload)
        ) {
            throw new Error("Import plan is stale because a reviewed multi-shift definition changed");
        }
    }

    for (const item of snapshot.items) {
        const payload = asRecord(item.payload);
        if (item.kind === "STUDENT") {
            const student = asRecord(payload.student);
            const nameResult = validateRequiredText(student.name, "Student name");
            if (!nameResult.ok) {
                throw new Error(`Import plan student is invalid: ${nameResult.error}`);
            }
            const expectedFee = optionalInteger(student.monthlyFee);
            const feeLinkedShiftName = optionalString(student.feeLinkedShiftName);
            const feeLinkedMultiShiftName = optionalString(student.feeLinkedMultiShiftName);
            if (feeLinkedShiftName) requireShift(feeLinkedShiftName, expectedFee);
            if (feeLinkedMultiShiftName) requireMultiShift(feeLinkedMultiShiftName, expectedFee);
        }
        if (item.kind === "ALLOCATION") {
            const allocation = asRecord(payload.allocation);
            const seatLabel = optionalString(allocation.seatLabel);
            const shiftName = optionalString(allocation.shiftName);
            const multiShiftName = optionalString(allocation.multiShiftName);
            if (seatLabel) requireSeat(seatLabel);
            if (shiftName) requireShift(shiftName);
            if (multiShiftName) {
                const componentShiftNames = Array.isArray(allocation.componentShiftNames)
                    ? allocation.componentShiftNames
                        .map(value => optionalString(value))
                        .filter((value): value is string => Boolean(value))
                    : null;
                if (!componentShiftNames?.length) {
                    throw new Error("Import plan is stale because reviewed multi-shift components are missing");
                }
                requireMultiShift(multiShiftName, undefined, componentShiftNames);
            }
        }
    }
}
