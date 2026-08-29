import { prisma } from "@/lib/prisma";
import {
    assertKnownFields,
    assertPlainObject,
    optionalBoolean,
    optionalChoice,
    optionalNumber,
    optionalText,
    optionalTime,
    requiredPhone,
} from "@/lib/settingsValidation";
import {
    FORM_LIMITS,
    parseIntegerField,
    validateRequiredPhone,
    validateOptionalText,
    validateRequiredText,
    validateShiftDrafts,
} from "@/lib/formValidation";
import {
    MESSAGE_LANGUAGES,
    REMINDER_TONES,
    UpdateBranchSettingsDto,
    type StaffAction,
} from "@/types";
import { StaffService } from "./staff.service";
import {
    DEFAULT_PRIMARY_SHIFTS,
    ensureDefaultFullTimeMultiShift,
    includesDefaultPrimaryShiftNames,
} from "@/services/defaultShifts";
import { generateSeatLabelsForSeatCount, type SeatNumberingConfig } from "@/lib/seatNumbering";
import { EntitlementService } from "@/services/entitlement.service";
import { BillingMutationService } from "@/services/billingMutation.service";
import { BillingReplacementService } from "@/services/billingReplacement.service";
import { BillingReconciliationService } from "@/services/billingReconciliation.service";
import { isReplacementMutationEligible } from "@/services/billingReplacementPolicy";
import { assertRazorpayBillingWritesEnabled } from "@/lib/billingFeature";
import { BillingChangeInProgressError } from "@/lib/billingErrors";
import { resolveRazorpayMode } from "@/lib/razorpay";
import type {
    BillingChangeType,
    Branch,
    OrganizationBillingChange,
    Prisma,
} from "@/app/generated/prisma/client";

function assertCurrentRazorpayMode(subscription: { providerMode: "TEST" | "LIVE" } | null | undefined) {
    if (subscription && subscription.providerMode !== resolveRazorpayMode()) {
        throw new Error("Subscription provider mode does not match current Razorpay credentials");
    }
}

interface CreateBranchForOrgParams {
    organizationId: string;
    userId: string;
    name: string;
    contactPhone: string;
    city?: string;
    defaultFee?: number;
    seatCount?: number;
    seatNumbering?: SeatNumberingConfig;
    shifts?: {
        name: string;
        startTime: string | null;
        endTime: string | null;
        price: number;
    }[];
    idempotencyKey: string;
}

type BranchMutationReplay = {
    branch: Branch;
    change: OrganizationBillingChange;
};

type AtomicBranchChangeInput = {
    organizationId: string;
    organizationSubscriptionId?: string | null;
    branchId: string;
    idempotencyKey: string;
    type: BillingChangeType;
    status?: "QUEUED" | "SCHEDULED" | "APPLIED";
    operationStatus?: "AWAITING_PROVIDER_CONFIRMATION" | "SCHEDULED" | "APPLIED";
    fromQuantity?: number | null;
    toQuantity?: number | null;
    effectiveAt?: Date | null;
    createdByUserId: string;
};

const BRANCH_DETAILS_SELECT = {
    id: true,
    organizationId: true,
    name: true,
    city: true,
    address: true,
    contactPhone: true,
    openingTime: true,
    closingTime: true,
    defaultFee: true,
    defaultAdmissionFee: true,
    defaultMessageLanguage: true,
    reminderTone: true,
    aiEnabled: true,
    createdAt: true,
    lastDataChange: true,
    aiLastCalledAt: true,
    aiStatus: true,
    billingStatus: true,
    billingActivatedAt: true,
    billingArchivedAt: true,
    organization: { select: { id: true, name: true } },
    _count: {
        select: {
            seats: true,
            students: { where: { status: "ACTIVE" } },
            shifts: { where: { status: "ACTIVE" } },
            payments: { where: { status: "DUE" } },
            staff: true,
        },
    },
    shifts: {
        where: { status: "ACTIVE" },
        select: {
            id: true,
            name: true,
            startTime: true,
            endTime: true,
            price: true,
            isReserved: true,
        },
        orderBy: { createdAt: "asc" },
    },
    staff: {
        select: {
            id: true,
            role: true,
            user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "asc" },
    },
} satisfies Prisma.BranchSelect;

type BranchDetailsRecord = Prisma.BranchGetPayload<{ select: typeof BRANCH_DETAILS_SELECT }>;
type BranchDetailsCounts = Partial<Record<"seats" | "students" | "shifts" | "payments" | "staff", number>>;

export type BranchDetailsResponse = Pick<Branch, "id" | "organizationId" | "name"> &
    Partial<Pick<Branch,
        | "city"
        | "address"
        | "contactPhone"
        | "openingTime"
        | "closingTime"
        | "defaultFee"
        | "defaultAdmissionFee"
        | "defaultMessageLanguage"
        | "reminderTone"
        | "aiEnabled"
        | "createdAt"
        | "lastDataChange"
        | "aiLastCalledAt"
        | "aiStatus"
        | "billingStatus"
        | "billingActivatedAt"
        | "billingArchivedAt"
    >> & {
        organization: BranchDetailsRecord["organization"];
        _count?: BranchDetailsCounts;
        shifts?: BranchDetailsRecord["shifts"];
        staff?: BranchDetailsRecord["staff"];
    };

function projectBranchDetails(
    branch: BranchDetailsRecord,
    permissions: Record<StaffAction, boolean>
): BranchDetailsResponse {
    const canManageBranch = permissions.manage_branch;
    const canViewStudents = permissions.students;
    const canViewPayments = permissions.view_payments;
    const canViewSeatData = permissions.seat_allocation || canManageBranch;
    const result: BranchDetailsResponse = {
        id: branch.id,
        organizationId: branch.organizationId,
        name: branch.name,
        organization: {
            id: branch.organization.id,
            name: branch.organization.name,
        },
    };

    if (canManageBranch) {
        Object.assign(result, {
            city: branch.city,
            address: branch.address,
            contactPhone: branch.contactPhone,
            openingTime: branch.openingTime,
            closingTime: branch.closingTime,
            defaultFee: branch.defaultFee,
            defaultAdmissionFee: branch.defaultAdmissionFee,
            defaultMessageLanguage: branch.defaultMessageLanguage,
            reminderTone: branch.reminderTone,
            aiEnabled: branch.aiEnabled,
            createdAt: branch.createdAt,
            lastDataChange: branch.lastDataChange,
            aiLastCalledAt: branch.aiLastCalledAt,
            aiStatus: branch.aiStatus,
            billingStatus: branch.billingStatus,
            billingActivatedAt: branch.billingActivatedAt,
            billingArchivedAt: branch.billingArchivedAt,
        });
    } else {
        if (canViewStudents) {
            result.defaultFee = branch.defaultFee;
            result.defaultAdmissionFee = branch.defaultAdmissionFee;
        }
        if (canViewPayments) {
            result.defaultMessageLanguage = branch.defaultMessageLanguage;
            result.reminderTone = branch.reminderTone;
        }
    }

    const counts: BranchDetailsCounts = {};
    if (canViewSeatData) {
        counts.seats = branch._count.seats;
        counts.shifts = branch._count.shifts;
    }
    if (canViewStudents) counts.students = branch._count.students;
    if (canViewPayments) counts.payments = branch._count.payments;
    if (canManageBranch) counts.staff = branch._count.staff;
    if (Object.keys(counts).length > 0) result._count = counts;

    if (canViewSeatData) result.shifts = branch.shifts;
    if (canManageBranch) result.staff = branch.staff;

    return result;
}

const BRANCH_CREATE_CHANGE_TYPES: readonly BillingChangeType[] = [
    "TRIAL_SUBSCRIPTION_UPDATE",
    "QUANTITY_INCREASE",
    "LEGACY_TRANSITION",
];

async function lockOrganization(tx: Prisma.TransactionClient, organizationId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE
    `;
    if (locked.length === 0) throw new Error("Organization not found");
}

async function findBranchMutationReplay(
    tx: Prisma.TransactionClient,
    input: {
        organizationId: string;
        idempotencyKey: string;
        allowedTypes: readonly BillingChangeType[];
        branchId?: string;
        expectedBranch?: {
            name: string;
            contactPhone: string;
            city: string | null;
            defaultFee: number;
        };
    }
): Promise<BranchMutationReplay | null> {
    const duplicate = await tx.organizationBillingChange.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
    });
    if (!duplicate) return null;
    if (
        duplicate.organizationId !== input.organizationId
        || !input.allowedTypes.includes(duplicate.type)
        || (input.branchId != null && duplicate.branchId !== input.branchId)
        || !duplicate.branchId
    ) {
        throw new Error("Idempotency key was already used for another branch operation");
    }
    const branch = await tx.branch.findUnique({ where: { id: duplicate.branchId } });
    if (!branch) throw new Error("The branch for this idempotent operation no longer exists");
    if (
        input.expectedBranch
        && (
            branch.name !== input.expectedBranch.name
            || branch.contactPhone !== input.expectedBranch.contactPhone
            || (branch.city ?? null) !== input.expectedBranch.city
            || (branch.defaultFee ?? 0) !== input.expectedBranch.defaultFee
        )
    ) {
        throw new Error("Idempotency key was already used with different branch details");
    }
    return { branch, change: duplicate };
}

async function findLockedBranchMutationReplay(input: {
    organizationId: string;
    idempotencyKey: string;
    allowedTypes: readonly BillingChangeType[];
    branchId?: string;
    expectedBranch?: {
        name: string;
        contactPhone: string;
        city: string | null;
        defaultFee: number;
    };
}) {
    return prisma.$transaction(async tx => {
        await lockOrganization(tx, input.organizationId);
        return findBranchMutationReplay(tx, input);
    });
}

async function createAtomicBranchChange(
    tx: Prisma.TransactionClient,
    input: AtomicBranchChangeInput
) {
    if (input.organizationSubscriptionId) {
        // The idempotent replay check happens before this helper. Any remaining
        // pending candidate therefore belongs to a different billable intent.
        await BillingReplacementService.assertNoOpenReplacement(tx, input.organizationId);
    }
    const organization = await tx.organization.update({
        where: { id: input.organizationId },
        data: { billingMutationSequence: { increment: 1 } },
        select: { billingMutationSequence: true },
    });
    const now = new Date();
    const status = input.status ?? "QUEUED";
    return tx.organizationBillingChange.create({
        data: {
            organizationId: input.organizationId,
            organizationSubscriptionId: input.organizationSubscriptionId ?? null,
            branchId: input.branchId,
            sequence: organization.billingMutationSequence,
            idempotencyKey: input.idempotencyKey,
            type: input.type,
            status,
            operationStatus: input.operationStatus ?? "AWAITING_PROVIDER_CONFIRMATION",
            fromQuantity: input.fromQuantity ?? null,
            toQuantity: input.toQuantity ?? null,
            effectiveAt: input.effectiveAt ?? null,
            createdByUserId: input.createdByUserId,
            appliedAt: status === "APPLIED" ? now : null,
            resolvedAt: status === "APPLIED" ? now : null,
        },
    });
}

async function resumeQueuedBranchMutation(replay: BranchMutationReplay) {
    if (replay.change.status !== "QUEUED" || !replay.change.organizationSubscriptionId) return replay;
    try {
        const processed = await BillingMutationService.processNext(replay.change.organizationId);
        return processed ? { ...replay, change: processed } : replay;
    } catch {
        // The durable operation remains available to the normal retry/deadline flow.
        return replay;
    }
}

function branchCreationResult(replay: BranchMutationReplay) {
    const providerOperation = replay.change.organizationSubscriptionId != null;
    const action = !providerOperation
        ? "NONE" as const
        : replay.change.replacementSubscriptionId
          ? "CHECKOUT_REQUIRED" as const
          : "PROCESSING" as const;
    return {
        ...replay.branch,
        action,
        billingChangeId: replay.change.id,
        processingUrl: providerOperation
            ? `/org/${encodeURIComponent(replay.change.organizationId)}/billing/processing/${encodeURIComponent(replay.change.id)}`
            : null,
    };
}

const BRANCH_SETTINGS_FIELDS = [
    "name",
    "city",
    "address",
    "contactPhone",
    "openingTime",
    "closingTime",
    "defaultFee",
    "defaultAdmissionFee",
    "defaultMessageLanguage",
    "reminderTone",
    "aiEnabled",
] as const;

export class BranchService {
    /**
     * Shared branch creation logic used by both onboarding and the
     * "Add New Branch" flow. Creates branch + seats + shifts + staff
     * in a single atomic transaction.
     */
    static async createBranchForOrg(params: CreateBranchForOrgParams) {
        const { organizationId, userId, name, contactPhone, city, defaultFee, seatCount, shifts, seatNumbering } = params;
        const idempotencyKey = params.idempotencyKey.trim();
        if (!idempotencyKey) throw new Error("Idempotency-Key is required");
        const nameResult = validateRequiredText(name, "Branch name", 120);
        if (!nameResult.ok) throw new Error(nameResult.error);
        const contactPhoneResult = validateRequiredPhone(contactPhone, "Contact phone");
        if (!contactPhoneResult.ok) throw new Error(contactPhoneResult.error);
        const cityResult = validateOptionalText(city, "City", FORM_LIMITS.cityMax);
        if (!cityResult.ok) throw new Error(cityResult.error);
        const defaultFeeResult = parseIntegerField(defaultFee, "Default monthly fee", {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        if (!defaultFeeResult.ok) throw new Error(defaultFeeResult.error);
        const seatCountResult = parseIntegerField(seatCount, "Total seats", {
            min: 0,
            max: FORM_LIMITS.seatsMax,
        });
        if (!seatCountResult.ok) throw new Error(seatCountResult.error);
        const seatLabelsResult = generateSeatLabelsForSeatCount(seatCountResult.value, seatNumbering);
        if (!seatLabelsResult.ok) throw new Error(seatLabelsResult.error);
        const shiftsResult = shifts ? validateShiftDrafts(shifts, { allowEmpty: false }) : null;
        if (shiftsResult && !shiftsResult.ok) throw new Error(shiftsResult.error);
        const expectedBranch = {
            name: nameResult.value,
            contactPhone: contactPhoneResult.value,
            city: cityResult.value ?? null,
            defaultFee: defaultFeeResult.value ?? 0,
        };

        const org = await prisma.organization.findUnique({
            where: { id: organizationId },
            select: {
                ownerId: true,
                billingModelVersion: true,
                ownerTrialGrant: { select: { status: true, trialEndsAt: true } },
                subscription: { select: { id: true, status: true, quantity: true, providerMode: true } },
            },
        });
        if (!org) throw new Error("Organization not found");
        if (org.ownerId !== userId) throw new Error("Unauthorized");

        const existingReplay = await findLockedBranchMutationReplay({
            organizationId,
            idempotencyKey,
            allowedTypes: BRANCH_CREATE_CHANGE_TYPES,
            expectedBranch,
        });
        if (existingReplay) {
            const resumed = await resumeQueuedBranchMutation(existingReplay);
            return branchCreationResult(resumed);
        }

        await EntitlementService.assertCanCreateBranch(organizationId);
        if (org.billingModelVersion === "WORKSPACE_V2" && org.subscription) {
            assertRazorpayBillingWritesEnabled(organizationId);
            assertCurrentRazorpayMode(org.subscription);
        }

        const created = await prisma.$transaction(async (tx) => {
            await lockOrganization(tx, organizationId);
            const replay = await findBranchMutationReplay(tx, {
                organizationId,
                idempotencyKey,
                allowedTypes: BRANCH_CREATE_CHANGE_TYPES,
                expectedBranch,
            });
            if (replay) return replay;

            const lockedOrg = await tx.organization.findUnique({
                where: { id: organizationId },
                select: {
                    ownerId: true,
                    billingModelVersion: true,
                    ownerTrialGrant: { select: { status: true, trialEndsAt: true } },
                    subscription: {
                        select: { id: true, quantity: true, providerPaymentMethod: true },
                    },
                },
            });
            if (!lockedOrg) throw new Error("Organization not found");
            if (lockedOrg.ownerId !== userId) throw new Error("Unauthorized");
            const trialActive = lockedOrg.ownerTrialGrant?.status === "ACTIVE"
                && lockedOrg.ownerTrialGrant.trialEndsAt != null
                && lockedOrg.ownerTrialGrant.trialEndsAt > new Date();
            const providerOperation = lockedOrg.billingModelVersion === "WORKSPACE_V2"
                && lockedOrg.subscription != null;
            const trialReplacementRequired = providerOperation
                && trialActive
                && isReplacementMutationEligible({
                    sourcePaymentMethod: lockedOrg.subscription!.providerPaymentMethod,
                    mutationType: "TRIAL_SUBSCRIPTION_UPDATE",
                });
            const pendingPaidActivation = providerOperation
                && (!trialActive || trialReplacementRequired);

            // 1. Create the branch
            const branch = await tx.branch.create({
                data: {
                    name: nameResult.value,
                    city: cityResult.value,
                    contactPhone: contactPhoneResult.value,
                    defaultFee: defaultFeeResult.value ?? 0,
                    organizationId,
                    billingStatus: pendingPaidActivation ? "PENDING_ACTIVATION" : "ACTIVE",
                    billingActivatedAt: pendingPaidActivation ? null : new Date(),
                },
            });

            // 2. Create shifts (custom or defaults)
            const shiftsToCreate = shiftsResult?.ok && shiftsResult.value.length > 0
                ? shiftsResult.value
                : DEFAULT_PRIMARY_SHIFTS;
            const shouldCreateDefaultFullTime = includesDefaultPrimaryShiftNames(shiftsToCreate);


            // ⚡ Bolt: Replaced O(n) individual shift creations with single bulk insert
            // Expected Impact: Reduces DB roundtrips from N to 1 during branch creation
            if (shiftsToCreate.length > 0) {
                await tx.shift.createMany({
                    data: shiftsToCreate.map(shift => ({
                        branchId: branch.id,
                        name: shift.name,
                        startTime: shift.startTime,
                        endTime: shift.endTime,
                        price: shift.price,
                        isReserved: "isReserved" in shift ? shift.isReserved : false,
                    }))
                });
            }
            if (shouldCreateDefaultFullTime) {
                await ensureDefaultFullTimeMultiShift(tx, branch.id);
            }

            // 3. Create seats
            // ⚡ Bolt: Replaced O(n) individual seat creations with single bulk insert
            // Expected Impact: Reduces DB roundtrips from N to 1 during branch creation
            if (seatLabelsResult.value.length > 0) {
                const seatsData = seatLabelsResult.value.map(label => ({
                    branchId: branch.id,
                    label,
                }));
                await tx.seat.createMany({
                    data: seatsData,
                });
            }

            // 4. Add calling user as MANAGER on this branch
            await tx.staff.create({
                data: { userId, branchId: branch.id, role: "MANAGER" },
            });

            const toQuantity = await tx.branch.count({
                where: { organizationId, billingStatus: { not: "ARCHIVED" } },
            });
            const localChangeType: BillingChangeType = trialActive
                ? "TRIAL_SUBSCRIPTION_UPDATE"
                : "LEGACY_TRANSITION";
            const change = await createAtomicBranchChange(tx, {
                organizationId,
                organizationSubscriptionId: providerOperation ? lockedOrg.subscription!.id : null,
                branchId: branch.id,
                idempotencyKey,
                type: providerOperation
                    ? trialActive ? "TRIAL_SUBSCRIPTION_UPDATE" : "QUANTITY_INCREASE"
                    : localChangeType,
                status: providerOperation ? "QUEUED" : "APPLIED",
                operationStatus: providerOperation ? "AWAITING_PROVIDER_CONFIRMATION" : "APPLIED",
                fromQuantity: providerOperation ? lockedOrg.subscription!.quantity : Math.max(0, toQuantity - 1),
                toQuantity,
                effectiveAt: providerOperation && trialActive
                    ? lockedOrg.ownerTrialGrant?.trialEndsAt
                    : new Date(),
                createdByUserId: userId,
            });
            return { branch, change };
        });

        const resumed = await resumeQueuedBranchMutation(created);
        return branchCreationResult(resumed);
    }

    static async getBranchesByOrganizationId(organizationId: string) {
        return await prisma.branch.findMany({
            where: { organizationId },
            orderBy: { createdAt: "desc" },
            include: {
                _count: {
                    select: {
                        students: true,
                        seats: true,
                        shifts: true,
                    },
                },
            },
        });
    }

    static async getBranchById(id: string) {
        return await prisma.branch.findUnique({
            where: { id },
        });
    }

    static async getBranchDetails(userId: string, branchId: string) {
        const access = await StaffService.getBranchAccess(userId, branchId);
        const canViewDetails =
            access.permissions.students ||
            access.permissions.seat_allocation ||
            access.permissions.manage_branch ||
            access.permissions.analytics ||
            access.permissions.view_payments;

        if (!canViewDetails) {
            throw new Error("Unauthorized: Branch details are not enabled for this staff member");
        }

        const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            select: BRANCH_DETAILS_SELECT,
        });
        return branch ? projectBranchDetails(branch, access.permissions) : null;
    }

    static parseSettingsPayload(body: unknown): UpdateBranchSettingsDto {
        assertPlainObject(body);
        assertKnownFields(body, BRANCH_SETTINGS_FIELDS);

        const settings: UpdateBranchSettingsDto = {};
        const name = optionalText(body.name, "Branch name", { required: true, max: 120 });
        const city = optionalText(body.city, "City", { max: 80 });
        const address = optionalText(body.address, "Address", { max: 240 });
        const contactPhone = requiredPhone(body.contactPhone, "Contact phone");
        const openingTime = optionalTime(body.openingTime, "Opening time");
        const closingTime = optionalTime(body.closingTime, "Closing time");
        const defaultFee = optionalNumber(body.defaultFee, "Default monthly fee", { min: 0, max: 1000000 });
        const defaultAdmissionFee = optionalNumber(body.defaultAdmissionFee, "Default admission fee", { min: 0, max: 1000000 });
        const defaultMessageLanguage = optionalChoice(body.defaultMessageLanguage, "Default message language", MESSAGE_LANGUAGES);
        const reminderTone = optionalChoice(body.reminderTone, "Reminder tone", REMINDER_TONES);
        const aiEnabled = optionalBoolean(body.aiEnabled, "AI enabled");

        if (name != null) settings.name = name;
        if (city !== undefined) settings.city = city;
        if (address !== undefined) settings.address = address;
        if (contactPhone !== undefined) settings.contactPhone = contactPhone;
        if (openingTime !== undefined) settings.openingTime = openingTime;
        if (closingTime !== undefined) settings.closingTime = closingTime;
        if (defaultFee !== undefined) settings.defaultFee = defaultFee;
        if (defaultAdmissionFee !== undefined) settings.defaultAdmissionFee = defaultAdmissionFee;
        if (defaultMessageLanguage !== undefined) settings.defaultMessageLanguage = defaultMessageLanguage;
        if (reminderTone !== undefined) settings.reminderTone = reminderTone;
        if (aiEnabled !== undefined) settings.aiEnabled = aiEnabled;

        return settings;
    }

    static async updateSettings(userId: string, branchId: string, body: unknown) {
        await StaffService.authorize(userId, branchId, "manage_branch");
        await EntitlementService.assertBranchWritable(branchId);
        const data = this.parseSettingsPayload(body);

        await prisma.branch.update({
            where: { id: branchId },
            data: {
                ...data,
                lastDataChange: new Date(),
            },
            select: { id: true },
        });
        const updated = await this.getBranchDetails(userId, branchId);
        if (!updated) throw new Error("Branch not found after update");
        return updated;
    }

    static async retryPendingActivation(userId: string, branchId: string) {
        const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            include: { organization: true },
        });
        if (!branch) throw new Error("Branch not found");
        if (branch.organization.ownerId !== userId) throw new Error("Unauthorized");
        if (branch.billingStatus !== "PENDING_ACTIVATION") throw new Error("Branch is not pending activation");
        assertRazorpayBillingWritesEnabled(branch.organizationId);
        const change = await prisma.organizationBillingChange.findFirst({
            where: {
                branchId,
                type: { in: ["QUANTITY_INCREASE", "BRANCH_REACTIVATION"] },
                status: { in: ["FAILED", "AWAITING_PAYMENT"] },
            },
            orderBy: { sequence: "desc" },
        });
        if (!change) throw new Error("Failed branch activation operation not found");
        if (change.replacementSubscriptionId) {
            return {
                action: "CHECKOUT_REQUIRED" as const,
                change,
                processingUrl: `/org/${encodeURIComponent(branch.organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
            };
        }
        const retried = await BillingMutationService.retry(change.id);
        return {
            action: "PROCESSING" as const,
            change: retried ?? change,
            processingUrl: `/org/${encodeURIComponent(branch.organizationId)}/billing/processing/${encodeURIComponent(change.id)}`,
        };
    }

    static async discardPendingActivation(userId: string, branchId: string) {
        const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            include: { organization: { include: { subscription: true } } },
        });
        if (!branch) throw new Error("Branch not found");
        if (branch.organization.ownerId !== userId) throw new Error("Unauthorized");
        if (branch.billingStatus !== "PENDING_ACTIVATION") throw new Error("Branch is not pending activation");

        await BillingReconciliationService.reconcileByOrganization(branch.organizationId);
        const refreshed = await prisma.branch.findUnique({ where: { id: branchId } });
        if (refreshed?.billingStatus === "ACTIVE") {
            throw new Error("Razorpay already confirmed this branch activation");
        }
        const change = await prisma.organizationBillingChange.findFirst({
            where: {
                branchId,
                type: { in: ["QUANTITY_INCREASE", "BRANCH_REACTIVATION"] },
                status: { in: ["QUEUED", "PROCESSING", "AWAITING_PAYMENT", "SCHEDULED", "FAILED"] },
            },
            orderBy: { sequence: "desc" },
        });
        if (!change) throw new Error("Branch activation is still awaiting provider confirmation");
        const now = new Date();
        if (change.replacementSubscriptionId) {
            await BillingReplacementService.undoReplacement(change.id, now, {
                branchDisposition: "ARCHIVE",
            });
            return { archived: true };
        }
        await prisma.$transaction(async tx => {
            await lockOrganization(tx, branch.organizationId);
            const organization = await tx.organization.findUniqueOrThrow({
                where: { id: branch.organizationId },
                select: { billingMutationLeaseToken: true, billingMutationLeaseUntil: true },
            });
            if (organization.billingMutationLeaseToken
                || (organization.billingMutationLeaseUntil && organization.billingMutationLeaseUntil > now)) {
                throw new Error("Another billing operation is still processing; retry shortly");
            }

            const currentBranch = await tx.branch.findUnique({ where: { id: branchId } });
            if (!currentBranch) throw new Error("Branch not found");
            if (currentBranch.billingStatus === "ACTIVE") {
                throw new Error("Razorpay already confirmed this branch activation");
            }
            if (currentBranch.billingStatus !== "PENDING_ACTIVATION") {
                throw new Error("Branch is not pending activation");
            }
            const currentChange = await tx.organizationBillingChange.findFirst({
                where: {
                    branchId,
                    type: { in: ["QUANTITY_INCREASE", "BRANCH_REACTIVATION"] },
                    status: { in: ["QUEUED", "PROCESSING", "AWAITING_PAYMENT", "SCHEDULED", "FAILED"] },
                },
                orderBy: { sequence: "desc" },
            });
            if (!currentChange) {
                throw new Error("Branch activation is still awaiting provider confirmation");
            }
            if (currentChange.replacementSubscriptionId) {
                throw new Error("Replacement branch activation must be discarded through its mandate operation");
            }
            await tx.organizationBillingChange.update({
                where: { id: currentChange.id },
                data: {
                    status: "SUPERSEDED",
                    operationStatus: "ABANDONED",
                    abandonedAt: now,
                    resolvedAt: now,
                    lastError: "Pending branch discarded by owner",
                },
            });
            await tx.branch.update({
                where: { id: branchId },
                data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
            });
        });
        return { archived: true };
    }

    static async reactivateArchivedBranch(userId: string, branchId: string, idempotencyKey: string) {
        const normalizedIdempotencyKey = idempotencyKey.trim();
        if (!normalizedIdempotencyKey) throw new Error("Idempotency-Key is required");
        const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            include: { organization: { include: { subscription: true } } },
        });
        if (!branch) throw new Error("Branch not found");
        if (branch.organization.ownerId !== userId) throw new Error("Unauthorized");

        const existingReplay = await findLockedBranchMutationReplay({
            organizationId: branch.organizationId,
            idempotencyKey: normalizedIdempotencyKey,
            allowedTypes: ["BRANCH_REACTIVATION"],
            branchId,
        });
        if (existingReplay) {
            const resumed = await resumeQueuedBranchMutation(existingReplay);
            return {
                action: resumed.change.replacementSubscriptionId ? "CHECKOUT_REQUIRED" as const : "PROCESSING" as const,
                change: resumed.change,
                processingUrl: `/org/${encodeURIComponent(branch.organizationId)}/billing/processing/${encodeURIComponent(existingReplay.change.id)}`,
            };
        }

        if (branch.billingStatus !== "ARCHIVED") throw new Error("Only an archived branch can be reactivated");
        assertRazorpayBillingWritesEnabled(branch.organizationId);
        await EntitlementService.assertOrganizationWritable(branch.organizationId);
        const subscription = branch.organization.subscription;
        if (!subscription) throw new Error("An authorized recurring subscription is required to reactivate this branch");
        assertCurrentRazorpayMode(subscription);

        const reactivation = await prisma.$transaction(async tx => {
            await lockOrganization(tx, branch.organizationId);
            const replay = await findBranchMutationReplay(tx, {
                organizationId: branch.organizationId,
                idempotencyKey: normalizedIdempotencyKey,
                allowedTypes: ["BRANCH_REACTIVATION"],
                branchId,
            });
            if (replay) return replay;

            const current = await tx.branch.findUnique({
                where: { id: branchId },
                include: { organization: { include: { subscription: true } } },
            });
            if (!current) throw new Error("Branch not found");
            if (current.organization.ownerId !== userId) throw new Error("Unauthorized");
            if (current.billingStatus !== "ARCHIVED") {
                throw new Error("Only an archived branch can be reactivated");
            }
            const currentSubscription = current.organization.subscription;
            if (!currentSubscription) {
                throw new Error("An authorized recurring subscription is required to reactivate this branch");
            }
            const updated = await tx.branch.update({
                where: { id: branchId },
                data: { billingStatus: "PENDING_ACTIVATION", billingArchivedAt: null },
            });
            const toQuantity = await tx.branch.count({
                where: { organizationId: branch.organizationId, billingStatus: { not: "ARCHIVED" } },
            });
            const change = await createAtomicBranchChange(tx, {
                organizationId: branch.organizationId,
                organizationSubscriptionId: currentSubscription.id,
                branchId,
                idempotencyKey: normalizedIdempotencyKey,
                type: "BRANCH_REACTIVATION",
                fromQuantity: currentSubscription.quantity,
                toQuantity,
                effectiveAt: new Date(),
                createdByUserId: userId,
            });
            return { branch: updated, change };
        });
        const resumed = await resumeQueuedBranchMutation(reactivation);
        return {
            action: resumed.change.replacementSubscriptionId ? "CHECKOUT_REQUIRED" as const : "PROCESSING" as const,
            change: resumed.change,
            processingUrl: `/org/${encodeURIComponent(branch.organizationId)}/billing/processing/${encodeURIComponent(reactivation.change.id)}`,
        };
    }

    static async scheduleBillingRemoval(
        userId: string,
        branchId: string,
        idempotencyKey: string
    ) {
        const normalizedIdempotencyKey = idempotencyKey.trim();
        if (!normalizedIdempotencyKey) throw new Error("Idempotency-Key is required");
        const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            include: { organization: { include: { subscription: true, ownerTrialGrant: true } } },
        });
        if (!branch) throw new Error("Branch not found");
        if (branch.organization.ownerId !== userId) throw new Error("Unauthorized");

        const existingReplay = await findLockedBranchMutationReplay({
            organizationId: branch.organizationId,
            idempotencyKey: normalizedIdempotencyKey,
            allowedTypes: ["BRANCH_REMOVAL"],
            branchId,
        });
        if (existingReplay) {
            const resumed = await resumeQueuedBranchMutation(existingReplay);
            return {
                action: resumed.change.replacementSubscriptionId ? "CHECKOUT_REQUIRED" as const : "PROCESSING" as const,
                branch: resumed.branch,
                change: resumed.change,
            };
        }

        await EntitlementService.assertBranchWritable(branchId);
        if (branch.organization.subscription) {
            assertRazorpayBillingWritesEnabled(branch.organizationId);
            assertCurrentRazorpayMode(branch.organization.subscription);
        }

        const removal = await prisma.$transaction(async tx => {
            await lockOrganization(tx, branch.organizationId);
            const replay = await findBranchMutationReplay(tx, {
                organizationId: branch.organizationId,
                idempotencyKey: normalizedIdempotencyKey,
                allowedTypes: ["BRANCH_REMOVAL"],
                branchId,
            });
            if (replay) return replay;

            const current = await tx.branch.findUnique({
                where: { id: branchId },
                include: { organization: { include: { subscription: true, ownerTrialGrant: true } } },
            });
            if (!current) throw new Error("Branch not found");
            if (current.organization.ownerId !== userId) throw new Error("Unauthorized");
            if (current.billingStatus !== "ACTIVE") throw new Error("Only an active branch can be removed");
            const remaining = await tx.branch.count({
                where: {
                    organizationId: branch.organizationId,
                    id: { not: branchId },
                    billingStatus: { in: ["ACTIVE", "PENDING_ACTIVATION", "REMOVAL_SCHEDULED"] },
                },
            });
            if (remaining < 1) throw new Error("The final billable branch cannot be removed");

            const trialEndsAt = current.organization.ownerTrialGrant?.status === "ACTIVE"
                ? current.organization.ownerTrialGrant.trialEndsAt
                : null;
            const effectiveAt = trialEndsAt
                ?? current.organization.subscription?.paidThrough
                ?? current.organization.subscription?.currentEnd;
            if (!effectiveAt) throw new Error("A billing-cycle boundary is not available");

            const updated = await tx.branch.update({
                where: { id: branchId },
                data: { billingStatus: "REMOVAL_SCHEDULED" },
            });
            const toQuantity = await tx.branch.count({
                where: {
                    organizationId: branch.organizationId,
                    billingStatus: { in: ["ACTIVE", "PENDING_ACTIVATION"] },
                },
            });
            const providerOperation = current.organization.subscription != null;
            const change = await createAtomicBranchChange(tx, {
                organizationId: branch.organizationId,
                organizationSubscriptionId: current.organization.subscription?.id,
                branchId,
                idempotencyKey: normalizedIdempotencyKey,
                type: "BRANCH_REMOVAL",
                status: providerOperation ? "QUEUED" : "SCHEDULED",
                operationStatus: providerOperation ? "AWAITING_PROVIDER_CONFIRMATION" : "SCHEDULED",
                fromQuantity: current.organization.subscription?.quantity ?? toQuantity + 1,
                toQuantity,
                effectiveAt,
                createdByUserId: userId,
            });
            return { branch: updated, change };
        });
        const resumed = await resumeQueuedBranchMutation(removal);
        return {
            ...resumed,
            action: resumed.change.organizationSubscriptionId == null
                ? "NONE" as const
                : resumed.change.replacementSubscriptionId
                  ? "CHECKOUT_REQUIRED" as const
                  : "PROCESSING" as const,
        };
    }

    static async undoBillingRemoval(userId: string, branchId: string) {
        const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            include: { organization: { include: { subscription: true } } },
        });
        if (!branch) throw new Error("Branch not found");
        if (branch.organization.ownerId !== userId) throw new Error("Unauthorized");
        const change = await prisma.organizationBillingChange.findFirst({
            where: {
                branchId,
                type: "BRANCH_REMOVAL",
                status: { in: ["QUEUED", "PROCESSING", "AWAITING_PAYMENT", "SCHEDULED", "FAILED"] },
            },
            orderBy: { sequence: "desc" },
        });
        if (!change) throw new Error("Scheduled branch removal not found");
        if (change.status === "PROCESSING") {
            throw new BillingChangeInProgressError(
                change.id,
                "The provider quantity mutation is still processing and cannot be undone"
            );
        }
        if (!change.replacementSubscriptionId
            && (change.status === "AWAITING_PAYMENT"
                || change.failureCategory === "MANUAL_REVIEW_REQUIRED")) {
            throw new BillingChangeInProgressError(
                change.id,
                "The provider quantity must be reconciled before the branch removal can be undone"
            );
        }
        if (change.replacementSubscriptionId) {
            await BillingReplacementService.undoReplacement(change.id);
            await prisma.branch.update({
                where: { id: branchId },
                data: { billingStatus: "ACTIVE" },
            });
            return { undone: true };
        }
        if (change.effectiveAt && change.effectiveAt <= new Date()) {
            throw new Error("The branch removal can no longer be undone");
        }
        if (change.status === "SCHEDULED" && branch.organization.subscription?.providerPaymentMethod === "CARD") {
            await BillingMutationService.undoScheduledProviderChange(change.id);
            await prisma.branch.update({
                where: { id: branchId },
                data: { billingStatus: "ACTIVE" },
            });
            return { undone: true };
        }
        await prisma.$transaction(async tx => {
            await lockOrganization(tx, branch.organizationId);
            const currentOrganization = await tx.organization.findUniqueOrThrow({
                where: { id: branch.organizationId },
                select: { ownerId: true, billingMutationLeaseToken: true },
            });
            if (currentOrganization.ownerId !== userId) throw new Error("Unauthorized");
            if (currentOrganization.billingMutationLeaseToken) {
                throw new BillingChangeInProgressError(
                    change.id,
                    "A provider quantity mutation is still processing and cannot be undone"
                );
            }
            const current = await tx.organizationBillingChange.findFirst({
                where: { id: change.id, organizationId: branch.organizationId, branchId },
            });
            if (!current || current.status !== change.status
                || current.updatedAt.getTime() !== change.updatedAt.getTime()) {
                throw new BillingChangeInProgressError(
                    change.id,
                    "The branch removal moved while the undo was being claimed"
                );
            }
            if (current.status === "PROCESSING"
                || current.status === "AWAITING_PAYMENT"
                || current.failureCategory === "MANUAL_REVIEW_REQUIRED") {
                throw new BillingChangeInProgressError(
                    change.id,
                    "The provider quantity must be reconciled before the branch removal can be undone"
                );
            }
            if (current.effectiveAt && current.effectiveAt <= new Date()) {
                throw new Error("The branch removal can no longer be undone");
            }
            const undoneAt = new Date();
            const undone = await tx.organizationBillingChange.updateMany({
                where: { id: current.id, status: current.status, updatedAt: current.updatedAt },
                data: {
                    status: "UNDONE",
                    operationStatus: "ABANDONED",
                    undoneAt,
                    resolvedAt: undoneAt,
                },
            });
            if (undone.count !== 1) {
                throw new BillingChangeInProgressError(
                    change.id,
                    "The branch removal moved while the undo was being finalized"
                );
            }
            const restored = await tx.branch.updateMany({
                where: {
                    id: branchId,
                    organizationId: branch.organizationId,
                    billingStatus: "REMOVAL_SCHEDULED",
                },
                data: { billingStatus: "ACTIVE" },
            });
            if (restored.count !== 1) {
                throw new BillingChangeInProgressError(
                    change.id,
                    "The branch state moved while the undo was being finalized"
                );
            }
        });
        return { undone: true };
    }

    static async archiveDueBillingRemovals(now = new Date()) {
        const due = await prisma.organizationBillingChange.findMany({
            where: { type: "BRANCH_REMOVAL", status: "SCHEDULED", effectiveAt: { lte: now } },
            include: { organizationSubscription: true },
        });
        let archived = 0;
        for (const change of due) {
            if (!change.branchId) continue;
            const providerConfirmed = !change.organizationSubscription
                || (change.toQuantity === change.organizationSubscription.quantity
                    && change.organizationSubscription.lastReconciledAt != null
                    && change.organizationSubscription.lastReconciledAt >= (change.effectiveAt ?? now));
            if (!providerConfirmed) continue;
            await prisma.$transaction([
                prisma.branch.update({
                    where: { id: change.branchId },
                    data: { billingStatus: "ARCHIVED", billingArchivedAt: now },
                }),
                prisma.organizationBillingChange.update({
                    where: { id: change.id },
                    data: {
                        status: "APPLIED",
                        operationStatus: "APPLIED",
                        appliedAt: now,
                        providerConfirmedAt: now,
                        resolvedAt: now,
                    },
                }),
            ]);
            archived += 1;
        }
        return { archived };
    }
}

