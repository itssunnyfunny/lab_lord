import { prisma } from "@/lib/prisma";

export class BranchService {
    static async createBranch(data: { name: string; organizationId: string }) {
        return await prisma.branch.create({
            data: {
                name: data.name,
                organizationId: data.organizationId,
            },
        });
    }

    static async getBranchesByOrganizationId(organizationId: string) {
        return await prisma.branch.findMany({
            where: {
                organizationId,
            },
            orderBy: {
                createdAt: "desc",
            },
        });
    }

    static async getBranchById(id: string) {
        return await prisma.branch.findUnique({
            where: { id },
        });
    }
}
