import { AccessPolicy } from "@/services/accessPolicy.service";
import { prisma as db } from "@/lib/prisma";
import { StaffRole } from "@/types";
import { StaffService } from "@/services/staff.service";
import { EntitlementService } from "@/services/entitlement.service";
import {
    createStaffInviteToken,
    getStaffInviteEmailHash,
    lockStaffInviteBranch,
    staffInviteEmailMatchesHash,
} from "@/services/staffInviteSecurity";

const DEFAULT_INVITE_TTL_DAYS = 7;

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

        const invites = await db.staffInvite.findMany({
            where: {
                branchId,
                acceptedAt: null,
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: "desc" },
        });

        return invites.filter(invite => getStaffInviteEmailHash(invite.token));
    }

    static async createInvite(
        actorId: string,
        branchId: string,
        role: StaffRole,
        invitedEmail: string,
        ttlDays = DEFAULT_INVITE_TTL_DAYS
    ) {
        await AccessPolicy.authorizeAction(actorId, branchId, "staff_management", undefined, true);

        if (ttlDays < 1 || ttlDays > 30) {
            throw new Error("Invite expiry must be between 1 and 30 days.");
        }

        const token = createStaffInviteToken(invitedEmail);
        const expiresAt = addDays(new Date(), ttlDays);

        return db.$transaction(async (tx) => {
            await lockStaffInviteBranch(tx, branchId);
            return tx.staffInvite.create({
                data: {
                    branchId,
                    role,
                    token,
                    expiresAt,
                },
            });
        });
    }

    static async revokeInvite(actorId: string, branchId: string, inviteId: string) {
        await AccessPolicy.authorizeAction(actorId, branchId, "staff_management", undefined, true);

        return db.$transaction(async (tx) => {
            await lockStaffInviteBranch(tx, branchId);

            const invite = await tx.staffInvite.findUnique({
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

            return tx.staffInvite.update({
                where: { id: invite.id },
                data: { expiresAt: now },
            });
        });
    }

    static async getInvitePreview(token: string) {
        const normalizedToken = normalizeToken(token);
        if (!getStaffInviteEmailHash(normalizedToken)) {
            throw new Error("This invite link is no longer supported. Ask the branch owner for a fresh invite.");
        }

        const invite = await db.staffInvite.findUnique({
            where: { token: normalizedToken },
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
            isAccountRestricted: true,
        };
    }

    static async acceptInvite(userId: string, token: string) {
        const normalizedToken = normalizeToken(token);
        const invitedEmailHash = getStaffInviteEmailHash(normalizedToken);
        if (!invitedEmailHash) {
            throw new Error("This invite link is no longer supported. Ask the branch owner for a fresh invite.");
        }

        return db.$transaction(async (tx) => {
            const inviteBranch = await tx.staffInvite.findUnique({
                where: { token: normalizedToken },
                select: { branchId: true },
            });
            if (!inviteBranch) {
                throw new Error("Invite not found");
            }

            await lockStaffInviteBranch(tx, inviteBranch.branchId);

            const [invite, user] = await Promise.all([
                tx.staffInvite.findUnique({
                    where: { token: normalizedToken },
                    include: {
                        branch: { select: { id: true, name: true } },
                    },
                }),
                tx.user.findUnique({
                    where: { id: userId },
                    select: { email: true },
                }),
            ]);

            if (!invite) {
                throw new Error("Invite not found");
            }

            if (invite.acceptedAt) {
                throw new Error("Invite has already been accepted");
            }

            if (invite.expiresAt.getTime() <= Date.now()) {
                throw new Error("Invite has expired");
            }

            if (!user || !staffInviteEmailMatchesHash(user.email, invitedEmailHash)) {
                throw new Error("This invite was issued to a different email address.");
            }

            await EntitlementService.assertBranchWritable(invite.branchId);
            await EntitlementService.assertBranchEntitlement(invite.branchId, "STAFF_MANAGEMENT");

            const now = new Date();
            const claimed = await tx.staffInvite.updateMany({
                where: {
                    id: invite.id,
                    acceptedAt: null,
                    expiresAt: { gt: now },
                },
                data: { acceptedAt: now },
            });

            if (claimed.count !== 1) {
                throw new Error("Invite has already been accepted or has expired");
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

            return {
                branchId: invite.branchId,
                branchName: invite.branch.name,
                staff,
            };
        });
    }
}
