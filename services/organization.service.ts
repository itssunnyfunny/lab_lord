import { prisma } from "@/lib/prisma";

export class OrganizationService {
    static async createOrganization(data: { name: string; ownerId: string }) {
        return await prisma.organization.create({
            data: {
                name: data.name,
                ownerId: data.ownerId,
            },
        });
    }

    static async getOrganizationsByUserId(userId: string) {
        return await prisma.organization.findMany({
            where: {
                ownerId: userId,
            },
            include: {
                _count: {
                    select: { branches: true },
                },
            },
            orderBy: {
                createdAt: "desc",
            },
        });
    }

    static async getOrganizationById(id: string) {
        return await prisma.organization.findUnique({
            where: { id },
        });
    }

    static async isOwner(organizationId: string, userId: string): Promise<boolean> {
        const org = await prisma.organization.findUnique({
            where: { id: organizationId },
            select: { ownerId: true },
        });
        return org?.ownerId === userId;
    }
}
