import { prisma } from "@/lib/prisma";
import { StudentStatus } from "@prisma/client";

export type CreateStudentDto = {
    name: string;
    phone?: string;
};

export class StudentService {
    /**
     * Helper to verify that the user owns the branch via its organization.
     */
    private static async verifyBranchOwnership(userId: string, branchId: string) {
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

    /**
     * Helper to verify that the user owns the student via branch -> organization.
     */
    private static async verifyStudentOwnership(userId: string, studentId: string) {
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                branch: {
                    include: {
                        organization: true,
                    },
                },
            },
        });

        if (!student) {
            throw new Error("Student not found");
        }

        if (student.branch.organization.ownerId !== userId) {
            throw new Error("Unauthorized: User does not own this student");
        }

        return student;
    }

    static async createStudent(
        userId: string,
        branchId: string,
        data: CreateStudentDto
    ) {
        await this.verifyBranchOwnership(userId, branchId);

        return prisma.student.create({
            data: {
                branchId,
                name: data.name,
                phone: data.phone,
                status: StudentStatus.ACTIVE,
            },
        });
    }

    static async getStudentsByBranch(userId: string, branchId: string) {
        await this.verifyBranchOwnership(userId, branchId);

        return prisma.student.findMany({
            where: {
                branchId,
            },
            orderBy: {
                name: "asc",
            },
        });
    }

    static async updateStudentStatus(
        userId: string,
        studentId: string,
        status: StudentStatus
    ) {
        await this.verifyStudentOwnership(userId, studentId);

        return prisma.student.update({
            where: { id: studentId },
            data: {
                status,
            },
        });
    }
}
