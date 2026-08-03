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
import { CreateBranchDto, MESSAGE_LANGUAGES, REMINDER_TONES, UpdateBranchSettingsDto } from "@/types";
import { ShiftService } from "./shift.service";
import { StaffService } from "./staff.service";
import {
    DEFAULT_PRIMARY_SHIFTS,
    ensureDefaultFullTimeMultiShift,
    includesDefaultPrimaryShiftNames,
} from "@/services/defaultShifts";
import { generateSeatLabelsForSeatCount, type SeatNumberingConfig } from "@/lib/seatNumbering";
import { EntitlementService } from "@/services/entitlement.service";
import { BillingMutationService } from "@/services/billingMutation.service";
import crypto from "node:crypto";

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
    idempotencyKey?: string;
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

        const org = await prisma.organization.findUnique({
            where: { id: organizationId },
            select: {
                ownerId: true,
                billingModelVersion: true,
                ownerTrialGrant: { select: { status: true, trialEndsAt: true } },
                subscription: { select: { id: true, status: true, quantity: true } },
            },
        });
        if (!org) throw new Error("Organization not found");
        if (org.ownerId !== userId) throw new Error("Unauthorized");
        await EntitlementService.assertCanCreateBranch(organizationId);
        const trialActive = org.ownerTrialGrant?.status === "ACTIVE"
            && org.ownerTrialGrant.trialEndsAt != null
            && org.ownerTrialGrant.trialEndsAt > new Date();
        const pendingPaidActivation = org.billingModelVersion === "WORKSPACE_V2"
            && Boolean(org.subscription)
            && !trialActive;

        const createdBranch = await prisma.$transaction(async (tx) => {
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

            return branch;
        });

        if (org.billingModelVersion === "WORKSPACE_V2" && org.subscription) {
            await BillingMutationService.enqueue({
                organizationId,
                subscriptionId: org.subscription.id,
                branchId: createdBranch.id,
                idempotencyKey: params.idempotencyKey ?? `branch-add:${createdBranch.id}:${crypto.randomUUID()}`,
                type: trialActive ? "TRIAL_SUBSCRIPTION_UPDATE" : "QUANTITY_INCREASE",
                fromQuantity: org.subscription.quantity,
                effectiveAt: trialActive ? org.ownerTrialGrant?.trialEndsAt : new Date(),
                createdByUserId: userId,
            });
            await BillingMutationService.processNext(organizationId);
        }

        return createdBranch;
    }

    static async createBranch(data: CreateBranchDto) {
        const nameResult = validateRequiredText(data.name, "Branch name", 120);
        if (!nameResult.ok) throw new Error(nameResult.error);
        const contactPhoneResult = validateRequiredPhone(data.contactPhone, "Contact phone");
        if (!contactPhoneResult.ok) throw new Error(contactPhoneResult.error);
        await EntitlementService.assertCanCreateBranch(data.organizationId);

        const branch = await prisma.branch.create({
            data: {
                name: nameResult.value,
                organizationId: data.organizationId,
                contactPhone: contactPhoneResult.value,
            },
        });

        await ShiftService.ensureDefaultShifts(branch.id);

        return branch;
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
            access.permissions.manage_branch ||
            access.permissions.analytics ||
            access.permissions.view_payments;

        if (!canViewDetails) {
            throw new Error("Unauthorized: Branch details are not enabled for this staff member");
        }

        const canViewStaff = access.permissions.manage_branch;

        return prisma.branch.findUnique({
            where: { id: branchId },
            include: {
                organization: true,
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
                staff: canViewStaff
                    ? {
                        include: {
                            user: { select: { id: true, name: true, email: true } },
                        },
                        orderBy: { createdAt: "asc" },
                    }
                    : false,
            },
        });
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

        return prisma.branch.update({
            where: { id: branchId },
            data: {
                ...data,
                lastDataChange: new Date(),
            },
            include: {
                organization: true,
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
                    include: {
                        user: { select: { id: true, name: true, email: true } },
                    },
                    orderBy: { createdAt: "asc" },
                },
            },
        });
    }

    static async scheduleBillingRemoval(
        userId: string,
        branchId: string,
        idempotencyKey: string
    ) {
        const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            include: { organization: { include: { subscription: true, ownerTrialGrant: true } } },
        });
        if (!branch) throw new Error("Branch not found");
        if (branch.organization.ownerId !== userId) throw new Error("Unauthorized");
        await EntitlementService.assertBranchWritable(branchId);
        const remaining = await prisma.branch.count({
            where: {
                organizationId: branch.organizationId,
                id: { not: branchId },
                billingStatus: { in: ["ACTIVE", "PENDING_ACTIVATION", "REMOVAL_SCHEDULED"] },
            },
        });
        if (remaining < 1) throw new Error("The final billable branch cannot be removed");
        if (branch.billingStatus !== "ACTIVE") throw new Error("Only an active branch can be removed");

        const trialEndsAt = branch.organization.ownerTrialGrant?.status === "ACTIVE"
            ? branch.organization.ownerTrialGrant.trialEndsAt
            : null;
        const effectiveAt = trialEndsAt
            ?? branch.organization.subscription?.paidThrough
            ?? branch.organization.subscription?.currentEnd;
        if (!effectiveAt) throw new Error("A billing-cycle boundary is not available");

        const updated = await prisma.branch.update({
            where: { id: branchId },
            data: { billingStatus: "REMOVAL_SCHEDULED" },
        });
        const change = await BillingMutationService.enqueue({
            organizationId: branch.organizationId,
            subscriptionId: branch.organization.subscription?.id,
            branchId,
            idempotencyKey,
            type: "BRANCH_REMOVAL",
            fromQuantity: branch.organization.subscription?.quantity,
            effectiveAt,
            createdByUserId: userId,
        });
        if (branch.organization.subscription) {
            await BillingMutationService.processNext(branch.organizationId);
        } else {
            await prisma.organizationBillingChange.update({
                where: { id: change.id },
                data: { status: "SCHEDULED" },
            });
        }
        return { branch: updated, change };
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
                status: { in: ["QUEUED", "PROCESSING", "SCHEDULED", "FAILED"] },
            },
            orderBy: { sequence: "desc" },
        });
        if (!change) throw new Error("Scheduled branch removal not found");
        if (change.effectiveAt && change.effectiveAt <= new Date()) {
            throw new Error("The branch removal can no longer be undone");
        }
        if (change.status === "SCHEDULED" && branch.organization.subscription?.providerPaymentMethod === "CARD") {
            const { getRazorpayClient } = await import("@/lib/razorpay");
            await getRazorpayClient().cancelScheduledChanges(
                branch.organization.subscription.razorpaySubscriptionId
            );
        }
        await prisma.$transaction([
            prisma.organizationBillingChange.update({
                where: { id: change.id },
                data: { status: "UNDONE", undoneAt: new Date() },
            }),
            prisma.branch.update({
                where: { id: branchId },
                data: { billingStatus: "ACTIVE" },
            }),
        ]);
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
                    data: { status: "APPLIED", appliedAt: now },
                }),
            ]);
            archived += 1;
        }
        return { archived };
    }
}

