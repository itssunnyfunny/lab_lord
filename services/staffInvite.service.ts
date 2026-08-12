import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma as db } from "@/lib/prisma";
import { StaffRole } from "@/types";
import { StaffService } from "@/services/staff.service";
import { EntitlementService } from "@/services/entitlement.service";

const DEFAULT_INVITE_TTL_DAYS = 7;
const INVITE_TOKEN_VERSION = "v2";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    if (!normalized || normalized.length > 160 || !EMAIL_PATTERN.test(normalized)) {
        throw new Error("Invite email must be a valid email address.");
    }
    return normalized;
}

function hashEmail(email: string) {
    return createHash("sha256").update(email).digest("base64url");
}

function createInviteToken(invitedEmail: string) {
    const emailHash = hashEmail(normalizeEmail(invitedEmail));
    return `${INVITE_TOKEN_VERSION}.${emailHash}.${randomBytes(32).toString("base64url")}`;
}

function getInviteEmailHash(token: string) {
    const [version, emailHash, secret, ...extra] = token.split(".");
    if (
        version !== INVITE_TOKEN_VERSION
        || !emailHash
        || !secret
        || extra.length > 0
        || emailHash.length !== 43
        || secret.length !== 43
        || !/^[A-Za-z0-9_-]+$/.test(emailHash)
        || !/^[A-Za-z0-9_-]+$/.test(secret)
    ) {
        return null;
    }
    return emailHash;
}

function emailMatchesHash(email: string, expectedHash: string) {
    const actual = Buffer.from(hashEmail(normalizeEmail(email)));
    const expected = Buffer.from(expectedHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
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

        const invites = await db.staffInvite.findMany({
            where: {
                branchId,
                acceptedAt: null,
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: "desc" },
        });

        return invites.filter(invite => getInviteEmailHash(invite.token));
    }

    static async createInvite(
        actorId: string,
        branchId: string,
        role: StaffRole,
        invitedEmail: string,
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
                token: createInviteToken(invitedEmail),
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
        const normalizedToken = normalizeToken(token);
        if (!getInviteEmailHash(normalizedToken)) {
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
        const invitedEmailHash = getInviteEmailHash(normalizedToken);
        if (!invitedEmailHash) {
            throw new Error("This invite link is no longer supported. Ask the branch owner for a fresh invite.");
        }

        return db.$transaction(async (tx) => {
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

            if (!user || !emailMatchesHash(user.email, invitedEmailHash)) {
                throw new Error("This invite was issued to a different email address.");
            }

            await EntitlementService.assertBranchWritable(invite.branchId);
            await EntitlementService.assertBranchEntitlement(invite.branchId, "STAFF_MANAGEMENT");

            const claimed = await tx.staffInvite.updateMany({
                where: {
                    id: invite.id,
                    acceptedAt: null,
                    expiresAt: { gt: new Date() },
                },
                data: { acceptedAt: new Date() },
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
