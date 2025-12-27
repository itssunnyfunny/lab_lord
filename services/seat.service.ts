import { prisma } from "@/lib/prisma";

export class SeatService {
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

    static async createSeat(userId: string, branchId: string, label: string) {
        await this.assertBranchOwnership(userId, branchId);

        // Check if seat label already exists for this branch to avoid unique constraint error
        const existingSeat = await prisma.seat.findUnique({
            where: {
                branchId_label: {
                    branchId,
                    label,
                },
            },
        });

        if (existingSeat) {
            throw new Error(`Seat with label "${label}" already exists in this branch.`);
        }

        return prisma.seat.create({
            data: {
                branchId,
                label,
            },
        });
    }

    static async listSeats(userId: string, branchId: string) {
        await this.assertBranchOwnership(userId, branchId);

        return prisma.seat.findMany({
            where: {
                branchId,
            },
            orderBy: {
                label: "asc",
            },
        });
    }
}
