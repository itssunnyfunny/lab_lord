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
            select: { ownerId: true },
        });
        if (!org) throw new Error("Organization not found");
        if (org.ownerId !== userId) throw new Error("Unauthorized");

        return await prisma.$transaction(async (tx) => {
            // 1. Create the branch
            const branch = await tx.branch.create({
                data: {
                    name: nameResult.value,
                    city: cityResult.value,
                    contactPhone: contactPhoneResult.value,
                    defaultFee: defaultFeeResult.value ?? 0,
                    organizationId,
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
    }

    static async createBranch(data: CreateBranchDto) {
        const nameResult = validateRequiredText(data.name, "Branch name", 120);
        if (!nameResult.ok) throw new Error(nameResult.error);
        const contactPhoneResult = validateRequiredPhone(data.contactPhone, "Contact phone");
        if (!contactPhoneResult.ok) throw new Error(contactPhoneResult.error);

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
}

