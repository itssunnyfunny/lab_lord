import { prisma } from "@/lib/prisma";
import {
    FORM_LIMITS,
    parseIntegerField,
    validateOptionalText,
    validateRequiredPhone,
    validateRequiredText,
    validateMultiShiftDrafts,
    validateShiftDrafts,
} from "@/lib/formValidation";
import {
    DEFAULT_PRIMARY_SHIFTS,
    ensureDefaultFullTimeMultiShift,
    includesDefaultPrimaryShiftNames,
} from "@/services/defaultShifts";
import { generateSeatLabelsForSeatCount, type SeatNumberingConfig } from "@/lib/seatNumbering";
import { isWorkspaceBillingEnabled } from "@/lib/billingFeature";
import { OwnerTrialService } from "@/services/ownerTrial.service";
import { isCheckoutBillingPlanId, type CheckoutBillingPlanId } from "@/lib/billingPlans";

interface CreateNetworkParams {
    userId: string;
    selectedPostTrialPlan: CheckoutBillingPlanId;
    ownerPhone: string;
    orgData: {
        name: string;
        businessType?: string;
    };
    branchData: {
        name: string;
        city?: string;
        defaultFee?: number;
    };
    seatCount?: number;
    seatNumbering?: SeatNumberingConfig;
    includeFullTimeMultiShift?: boolean;
    shifts?: {
        name: string;
        startTime: string | null;
        endTime: string | null;
        price: number;
    }[];
    multiShifts?: {
        name: string;
        price: number;
        componentShiftNames: string[];
    }[];
}

export class OnboardingService {
    static async createNetwork(params: CreateNetworkParams) {
        if (!isWorkspaceBillingEnabled()) {
            throw new Error("Workspace creation is temporarily unavailable.");
        }
        const { userId, orgData, branchData } = params;
        if (!isCheckoutBillingPlanId(params.selectedPostTrialPlan)) {
            throw new Error("Choose Basic or Standard as the post-trial plan.");
        }
        const ownerPhoneResult = validateRequiredPhone(params.ownerPhone, "Owner phone");
        if (!ownerPhoneResult.ok) throw new Error(ownerPhoneResult.error);
        const orgNameResult = validateRequiredText(orgData.name, "Organization name", 120);
        if (!orgNameResult.ok) throw new Error(orgNameResult.error);
        const businessTypeResult = validateOptionalText(orgData.businessType, "Business type", 80);
        if (!businessTypeResult.ok) throw new Error(businessTypeResult.error);
        const branchNameResult = validateRequiredText(branchData.name, "Branch name", 120);
        if (!branchNameResult.ok) throw new Error(branchNameResult.error);
        const cityResult = validateOptionalText(branchData.city, "City", FORM_LIMITS.cityMax);
        if (!cityResult.ok) throw new Error(cityResult.error);
        const defaultFeeResult = parseIntegerField(branchData.defaultFee, "Default monthly fee", {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        if (!defaultFeeResult.ok) throw new Error(defaultFeeResult.error);
        const seatCountResult = parseIntegerField(params.seatCount, "Total seats", {
            min: 0,
            max: FORM_LIMITS.seatsMax,
        });
        if (!seatCountResult.ok) throw new Error(seatCountResult.error);
        const seatLabelsResult = generateSeatLabelsForSeatCount(seatCountResult.value, params.seatNumbering);
        if (!seatLabelsResult.ok) throw new Error(seatLabelsResult.error);
        const shiftsResult = params.shifts ? validateShiftDrafts(params.shifts, { allowEmpty: false }) : null;
        if (shiftsResult && !shiftsResult.ok) throw new Error(shiftsResult.error);
        const shiftsToCreate = shiftsResult?.ok && shiftsResult.value.length > 0
            ? shiftsResult.value
            : DEFAULT_PRIMARY_SHIFTS;
        const multiShiftsResult = params.multiShifts
            ? validateMultiShiftDrafts(params.multiShifts, shiftsToCreate, { allowEmpty: false })
            : null;
        if (multiShiftsResult && !multiShiftsResult.ok) throw new Error(multiShiftsResult.error);

        // Use interactive transaction for atomicity
        return await prisma.$transaction(async (tx) => {
            await tx.user.update({
                where: { id: userId },
                data: { phone: ownerPhoneResult.value },
            });

            // 1. Create Organization
            const org = await tx.organization.create({
                data: {
                    name: orgNameResult.value,
                    businessType: businessTypeResult.value,
                    contactPhone: ownerPhoneResult.value,
                    ownerId: userId,
                    selectedPostTrialPlan: params.selectedPostTrialPlan,
                    billingModelVersion: "WORKSPACE_V2",
                },
            });

            // 2. Create First Branch linked to Org
            const branch = await tx.branch.create({
                data: {
                    name: branchNameResult.value,
                    city: cityResult.value,
                    contactPhone: ownerPhoneResult.value,
                    defaultFee: defaultFeeResult.value,
                    organizationId: org.id,
                },
            });

            // 3. Create Default Shifts for the branch (manually reusing logic or calling service if compatible with tx)
            // Since service methods might use global `prisma`, we should replicate crucial logic or pass tx if refactored.
            // For safety in transaction, we'll implement the creation directly here to ensure it uses `tx`.

            // 3. Create Custom Shifts (or defaults if not provided, though generic defaults lack price context)
            const shouldCreateDefaultFullTime = params.multiShifts === undefined
                && params.includeFullTimeMultiShift !== false
                && includesDefaultPrimaryShiftNames(shiftsToCreate);

            // ⚡ Bolt: Bulk shift creation to prevent N+1 query problem during network setup
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
            if (multiShiftsResult?.ok && multiShiftsResult.value.length > 0) {
                const createdShifts = await tx.shift.findMany({
                    where: {
                        branchId: branch.id,
                        status: "ACTIVE",
                    },
                    select: { id: true, name: true },
                });
                const shiftByName = new Map(createdShifts.map(shift => [shift.name.toLowerCase(), shift]));

                for (const multiShift of multiShiftsResult.value) {
                    const componentShifts = multiShift.componentShiftNames.map(name => {
                        const shift = shiftByName.get(name.toLowerCase());
                        if (!shift) throw new Error(`Primary shift "${name}" was not created.`);
                        return shift;
                    });

                    await tx.multiShift.create({
                        data: {
                            branchId: branch.id,
                            name: multiShift.name,
                            price: multiShift.price,
                            components: {
                                create: componentShifts.map((shift, order) => ({
                                    shiftId: shift.id,
                                    order,
                                })),
                            },
                        },
                    });
                }
            } else if (shouldCreateDefaultFullTime) {
                await ensureDefaultFullTimeMultiShift(tx, branch.id);
            }

            // 4. Create Seats
            // Generate seats based on seatCount (e.g. "1", "2", ...)
            // ⚡ Bolt: Bulk seat creation. Reduces DB roundtrips from N to 1
            if (seatLabelsResult.value.length > 0) {
                const seatsData = seatLabelsResult.value.map(label => ({
                    branchId: branch.id,
                    label,
                }));
                await tx.seat.createMany({
                    data: seatsData,
                });
            }

            // 4. (Optional) Assign User as STAFF/MANAGER to this branch?
            // The schema says `Staff` table links User to Branch with Role.
            // Owner is implicitly owner via Org, but for consistency in "Staff List", we often add them.
            // Requirement says: "AssignUserAsOwner" -> typically implied by Org.ownerId, 
            // but let's add them as MANAGER in Staff table to be explicit and appear in lists.

            await tx.staff.create({
                data: {
                    userId,
                    branchId: branch.id,
                    role: "MANAGER",
                },
            });

            await OwnerTrialService.startOnboardingTrial(tx, userId, org.id, new Date());

            return { org, branch };
        });
    }
}
