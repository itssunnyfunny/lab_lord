import { prisma } from "@/lib/prisma";
import { runAllocationTransaction } from "@/lib/allocationTransaction";
import { FORM_LIMITS, parseIntegerField, validateRequiredText } from "@/lib/formValidation";
import { StaffService } from "@/services/staff.service";
import type { StaffAction } from "@/types";
import { EntitlementService } from "@/services/entitlement.service";
import type { Prisma } from "@/app/generated/prisma/client";

export interface CreateMultiShiftDto {
    name: string;
    price?: number;
    shiftIds: string[];
}

export interface UpdateMultiShiftDto {
    name?: string;
    price?: number;
    shiftIds?: string[];
}

export interface MultiShiftItem {
    id: string;
    name: string;
    price: number;
    createdAt: Date;
    components: {
        shiftId: string;
        shiftName: string;
        startTime: string | null;
        endTime: string | null;
        order: number;
    }[];
}

type MultiShiftWithComponents = {
    id: string;
    name: string;
    price: number;
    createdAt: Date;
    components: {
        shiftId: string;
        order: number;
        shift: {
            name: string;
            startTime: string | null;
            endTime: string | null;
        };
    }[];
};

export class MultiShiftService {
    private static async assertBranchAccess(userId: string, branchId: string, action: StaffAction,
        client: Prisma.TransactionClient | typeof prisma = prisma) {
        await StaffService.authorize(userId, branchId, action, client);

        const branch = await client.branch.findUnique({ where: { id: branchId } });
        if (!branch) throw new Error("Branch not found");
        return branch;
    }

    /**
     * Validate and normalize shiftIds for a multi-shift:
     * - At least 2 shifts
     * - All shifts must be ACTIVE primary shifts of this branch
     * - Exact combination must not already exist (sorted set comparison)
     */
    private static async validateComponents(
        branchId: string,
        shiftIds: string[],
        excludeMultiShiftId?: string,
        client: Prisma.TransactionClient | typeof prisma = prisma
    ) {
        if (!shiftIds || shiftIds.length < 2) {
            throw new Error("A multi-shift must contain at least 2 primary shifts.");
        }

        const uniqueIds = [...new Set(shiftIds.filter(id => typeof id === "string" && id.trim()).map(id => id.trim()))];
        if (uniqueIds.length !== shiftIds.length) {
            throw new Error("Component shifts must be valid shift IDs.");
        }

        // Validate all shifts exist, are ACTIVE, and belong to this branch
        const shifts = await client.shift.findMany({
            where: { id: { in: uniqueIds } },
            select: { id: true, name: true, branchId: true, status: true },
        });

        if (shifts.length !== uniqueIds.length) {
            throw new Error("One or more shifts were not found.");
        }
        for (const s of shifts) {
            if (s.branchId !== branchId)
                throw new Error(`Shift "${s.name}" does not belong to this branch.`);
            if (s.status !== "ACTIVE")
                throw new Error(`Shift "${s.name}" is not active.`);
        }

        // Check for duplicate combination (order-independent)
        const sortedNew = [...uniqueIds].sort().join(",");
        const existingMultiShifts = await client.multiShift.findMany({
            where: {
                branchId,
                ...(excludeMultiShiftId ? { id: { not: excludeMultiShiftId } } : {}),
            },
            include: {
                components: { select: { shiftId: true } },
            },
        });

        for (const ms of existingMultiShifts) {
            const sortedExisting = ms.components.map((c) => c.shiftId).sort().join(",");
            if (sortedExisting === sortedNew) {
                throw new Error(
                    `A multi-shift with this exact combination already exists: "${ms.name}"`
                );
            }
        }

        return uniqueIds;
    }

    static async createMultiShift(
        userId: string,
        branchId: string,
        data: CreateMultiShiftDto
    ): Promise<MultiShiftItem> {
        return prisma.$transaction(tx =>
            this.createMultiShiftInTransaction(userId, branchId, data, tx)
        );
    }

    static async createMultiShiftInTransaction(
        userId: string,
        branchId: string,
        data: CreateMultiShiftDto,
        tx: Prisma.TransactionClient
    ): Promise<MultiShiftItem> {
        await StaffService.authorize(userId, branchId, "manage_branch", tx);
        await EntitlementService.assertBranchWritable(branchId, tx);
        const nameResult = validateRequiredText(data.name, "Multi-shift name", 50);
        if (!nameResult.ok) throw new Error(nameResult.error);
        const priceResult = parseIntegerField(data.price, "Bundle monthly price", {
            min: 0,
            max: FORM_LIMITS.moneyMax,
        });
        if (!priceResult.ok) throw new Error(priceResult.error);
        const uniqueIds = await this.validateComponents(branchId, data.shiftIds, undefined, tx);

        const ms = await tx.multiShift.create({
            data: {
                branchId,
                name: nameResult.value,
                price: priceResult.value ?? 0,
                components: {
                    create: uniqueIds.map((shiftId, i) => ({ shiftId, order: i })),
                },
            },
            include: {
                components: {
                    include: { shift: { select: { name: true, startTime: true, endTime: true } } },
                    orderBy: { order: "asc" },
                },
            },
        });

        return this.toDto(ms);
    }

    static async updateMultiShift(
        userId: string,
        multiShiftId: string,
        data: UpdateMultiShiftDto
    ): Promise<MultiShiftItem> {
        return runAllocationTransaction(async tx => {
            const ms = await tx.multiShift.findUnique({ where: { id: multiShiftId }, include: { components: { orderBy: { order: "asc" } } } });
            if (!ms) throw new Error("Multi-shift not found");
            await this.assertBranchAccess(userId, ms.branchId, "manage_branch", tx);
            await EntitlementService.assertBranchWritable(ms.branchId, tx);
            const nameResult = data.name !== undefined
                ? validateRequiredText(data.name, "Multi-shift name", 50)
                : null;
            if (nameResult && !nameResult.ok) throw new Error(nameResult.error);
            const priceResult = data.price !== undefined
                ? parseIntegerField(data.price, "Bundle monthly price", { min: 0, max: FORM_LIMITS.moneyMax })
                : null;
            if (priceResult && !priceResult.ok) throw new Error(priceResult.error);

            let uniqueIds: string[] | undefined;
            if (data.shiftIds) {
                uniqueIds = await this.validateComponents(ms.branchId, data.shiftIds, multiShiftId, tx);
            }

            if (uniqueIds && (uniqueIds.some(id => !ms.components.some(component => component.shiftId === id))
                || uniqueIds.length !== ms.components.length)) {
                if (await tx.seatAllocation.count({ where: { multiShiftId, branchId: ms.branchId, endDate: null } })) {
                    throw new Error("End active bundle allocations before changing component shifts");
                }
            }
            const normalizedPrice = priceResult?.ok ? priceResult.value : undefined;
            const priceChanged = normalizedPrice !== undefined && normalizedPrice !== ms.price;


            const saved = await tx.multiShift.update({
                where: { id: multiShiftId },
                data: {
                    ...(nameResult?.ok ? { name: nameResult.value } : {}),
                    ...(normalizedPrice !== undefined ? { price: normalizedPrice } : {}),
                    ...(uniqueIds
                        ? {
                              components: {
                                  deleteMany: {},
                                  create: uniqueIds.map((shiftId, i) => ({ shiftId, order: i })),
                              },
                          }
                        : {}),
                },
                include: {
                    components: {
                        include: { shift: { select: { name: true, startTime: true, endTime: true } } },
                        orderBy: { order: "asc" },
                    },
                },
            });

            if (priceChanged) {
                await tx.student.updateMany({
                    where: {
                        branchId: ms.branchId,
                        feeLinkedMultiShiftId: multiShiftId,
                    },
                    data: {
                        monthlyFee: normalizedPrice,
                    },
                });
            }

            await tx.branch.update({
                where: { id: ms.branchId },
                data: { lastDataChange: new Date() },
            });

            return this.toDto(saved);
        });
    }

    static async deleteMultiShift(userId: string, multiShiftId: string) {
        const ms = await prisma.multiShift.findUnique({ where: { id: multiShiftId } });
        if (!ms) throw new Error("Multi-shift not found");
        await this.assertBranchAccess(userId, ms.branchId, "manage_branch");
        await EntitlementService.assertBranchWritable(ms.branchId);

        await prisma.$transaction(async (tx) => {
            // Null out the multiShiftId on existing allocations (keep history intact)
            await tx.seatAllocation.updateMany({
                where: { multiShiftId },
                data: { multiShiftId: null },
            });
            await tx.student.updateMany({
                where: { branchId: ms.branchId, feeLinkedMultiShiftId: multiShiftId },
                data: { feeLinkedMultiShiftId: null },
            });
            await tx.multiShift.delete({ where: { id: multiShiftId } });
        });

        return { success: true };
    }

    static async listMultiShifts(userId: string, branchId: string): Promise<MultiShiftItem[]> {
        await this.assertBranchAccess(userId, branchId, "seat_allocation");

        const list = await prisma.multiShift.findMany({
            where: { branchId },
            include: {
                components: {
                    include: { shift: { select: { name: true, startTime: true, endTime: true } } },
                    orderBy: { order: "asc" },
                },
            },
            orderBy: { name: "asc" },
        });

        return list.map(this.toDto);
    }

    private static toDto(ms: MultiShiftWithComponents): MultiShiftItem {
        return {
            id: ms.id,
            name: ms.name,
            price: ms.price,
            createdAt: ms.createdAt,
            components: ms.components.map((c) => ({
                shiftId: c.shiftId,
                shiftName: c.shift.name,
                startTime: c.shift.startTime,
                endTime: c.shift.endTime,
                order: c.order,
            })),
        };
    }
}
