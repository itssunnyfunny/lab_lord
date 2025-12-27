
import { prisma } from "@/lib/prisma";

export interface CreateShiftDto {
    name: string;
    startTime?: string;
    endTime?: string;
}

export class ShiftService {
    /**
     * Helper to verify that the user owns the branch via its organization.
     */
    private static async assertBranchOwnership(userId: string, branchId: string) {
        const branch = await prisma.branch.findUnique({
            where: { id: branchId },
            include: {
                organization: true,
            },
        });

        if (!branch) {
            throw new Error("Branch not found");
        }

        if (branch.organization.ownerId !== userId) {
            throw new Error("Unauthorized: User does not own this branch");
        }

        return branch;
    }

    static async createShift(userId: string, branchId: string, data: CreateShiftDto) {
        await this.assertBranchOwnership(userId, branchId);

        // Check if shift name already exists for this branch
        const existingShift = await prisma.shift.findUnique({
            where: {
                branchId_name: {
                    branchId,
                    name: data.name,
                },
            },
        });

        if (existingShift) {
            throw new Error(`Shift with name "${data.name}" already exists in this branch.`);
        }

        return prisma.shift.create({
            data: {
                branchId,
                name: data.name,
                startTime: data.startTime,
                endTime: data.endTime,
            },
        });
    }

    static async ensureDefaultShifts(branchId: string) {
        const defaults = [
            { name: "Morning", startTime: "06:00", endTime: "12:00" },
            { name: "Evening", startTime: "16:00", endTime: "22:00" },
            { name: "Reserved", startTime: null, endTime: null },
        ];

        for (const def of defaults) {
            const existing = await prisma.shift.findUnique({
                where: {
                    branchId_name: {
                        branchId,
                        name: def.name,
                    },
                },
            });

            if (!existing) {
                await prisma.shift.create({
                    data: {
                        branchId,
                        name: def.name,
                        startTime: def.startTime,
                        endTime: def.endTime,
                    },
                });
            }
        }
    }

    static async listShifts(userId: string, branchId: string) {
        await this.assertBranchOwnership(userId, branchId);

        await this.ensureDefaultShifts(branchId);

        return prisma.shift.findMany({
            where: {
                branchId,
            },
            orderBy: {
                name: "asc",
            },
        });
    }
}
