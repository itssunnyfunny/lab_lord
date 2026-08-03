import { randomBytes } from "crypto";
import { prisma as db } from "@/lib/prisma";
import { StaffRole } from "@/types";
import { StaffService } from "@/services/staff.service";
import { EntitlementService } from "@/services/entitlement.service";

const DEFAULT_INVITE_TTL_DAYS = 7;

function createInviteToken() {
    return randomBytes(32).toString("base64url");
}

function addDays(date: Date, days: number) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

function normalizeToken(token: string) {
    return token.trim();
}

export class StaffInviteService {
    static async listActiveInvites(actorId: string, branchId: string) {
        await StaffService.authorize(actorId, branchId, "staff_management");

        return db.staffInvite.findMany({
            where: {
                branchId,
                acceptedAt: null,
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: "desc" },
        });
    }

    static async createInvite(
        actorId: string,
        branchId: string,
        role: StaffRole,
        ttlDays = DEFAULT_INVITE_TTL_DAYS
    ) {
        await StaffService.authorize(actorId, branchId, "staff_management");
        await EntitlementService.assertBranchWritable(branchId);

        if (ttlDays < 1 || ttlDays > 30) {
            throw new Error("Invite expiry must be between 1 and 30 days.");
        }

        return db.staffInvite.create({
            data: {
                branchId,
                role,
                token: createInviteToken(),
                expiresAt: addDays(new Date(), ttlDays),
            },
        });
    }

    static async revokeInvite(actorId: string, branchId: string, inviteId: string) {
        await StaffService.authorize(actorId, branchId, "staff_management");
        await EntitlementService.assertBranchWritable(branchId);

        const invite = await db.staffInvite.findUnique({
            where: { id: inviteId },
        });

        if (!invite || invite.branchId !== branchId) {
            throw new Error("Invite not found");
        }

        if (invite.acceptedAt) {
            throw new Error("Accepted invites cannot be revoked");
        }

        const now = new Date();
        if (invite.expiresAt.getTime() <= now.getTime()) {
            return invite;
        }

        return db.staffInvite.update({
            where: { id: invite.id },
            data: { expiresAt: now },
        });
    }

    static async getInvitePreview(token: string) {
        const invite = await db.staffInvite.findUnique({
            where: { token: normalizeToken(token) },
            include: {
                branch: {
                    select: {
                        id: true,
                        name: true,
                        city: true,
                        organization: { select: { name: true } },
                    },
                },
            },
        });

        if (!invite) {
            throw new Error("Invite not found");
        }

        return {
            ...invite,
            isExpired: invite.expiresAt.getTime() <= Date.now(),
        };
    }

    static async acceptInvite(userId: string, token: string) {
        return db.$transaction(async (tx) => {
            const invite = await tx.staffInvite.findUnique({
                where: { token: normalizeToken(token) },
                include: {
                    branch: { select: { id: true, name: true } },
                },
            });

            if (!invite) {
                throw new Error("Invite not found");
            }

            await EntitlementService.assertBranchWritable(invite.branchId);

            if (invite.acceptedAt) {
                throw new Error("Invite has already been accepted");
            }

            if (invite.expiresAt.getTime() <= Date.now()) {
                throw new Error("Invite has expired");
            }

            const existingStaff = await tx.staff.findUnique({
                where: {
                    userId_branchId: {
                        userId,
                        branchId: invite.branchId,
                    },
                },
            });

            const staff = existingStaff ?? (await tx.staff.create({
                data: {
                    userId,
                    branchId: invite.branchId,
                    role: invite.role,
                },
            }));

            await tx.staffInvite.update({
                where: { id: invite.id },
                data: { acceptedAt: new Date() },
            });

            return {
                branchId: invite.branchId,
                branchName: invite.branch.name,
                staff,
            };
        });
    }
}
