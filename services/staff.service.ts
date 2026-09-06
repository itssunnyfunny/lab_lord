import { prisma as db } from "@/lib/prisma";
import {
    BranchAccess,
    StaffAction,
    StaffPermissionUpdate,
    StaffRole,
} from "@/types";
import type { Prisma } from "@/app/generated/prisma/client";
import {
    type DateIdCursor,
    pageFromRows,
    parsePageLimit,
} from "@/lib/cursorPagination";
import {
    getStaffInviteTokenEmailPrefix,
    lockStaffInviteBranch,
} from "@/services/staffInviteSecurity";

import { AccessPolicy } from "@/services/accessPolicy.service";
import { normalizePermissionUpdate, buildStaffPermissions } from "@/services/branchActionPolicy";
export { PERMISSION_MATRIX } from "@/services/branchActionPolicy";

export class StaffService {
    private static normalizeEmail(email: string) { return email.trim().toLowerCase(); }

    // Compatibility facades delegate every policy decision to the canonical boundary.
    static async authorizeRole(userId: string, branchId: string, action: StaffAction, client: Prisma.TransactionClient | typeof db = db): Promise<boolean> {
        await AccessPolicy.authorizeRole(userId, branchId, action, client); return true;
    }
    static async authorize(userId: string, branchId: string, action: StaffAction, client: Prisma.TransactionClient | typeof db = db): Promise<boolean> {
        await AccessPolicy.authorizeAction(userId, branchId, action, client); return true;
    }
    static async getBranchAccess(userId: string, branchId: string): Promise<BranchAccess> {
        return AccessPolicy.branchProjection(userId, branchId);
    }

    /**
     * Add a new staff member to a branch.
     * Permission: staff_management (Owner Only)
     */
    static async addStaff(
        actorId: string,
        branchId: string,
        targetUserId: string,
        role: StaffRole
    ) {
        await AccessPolicy.authorizeCapability(actorId, branchId, "staffManage");
        return this.createStaffMembership(branchId, targetUserId, role);
    }

    static async addStaffByEmail(
        actorId: string,
        branchId: string,
        targetEmail: string,
        role: StaffRole
    ) {
        await AccessPolicy.authorizeCapability(actorId, branchId, "staffManage");

        const email = this.normalizeEmail(targetEmail);
        if (!email) {
            throw new Error("Email is required");
        }

        const user = await db.user.findUnique({ where: { email } });
        if (!user) {
            throw new Error("User must sign in once before being added");
        }

        return this.createStaffMembership(branchId, user.id, role);
    }

    private static async createStaffMembership(
        branchId: string,
        targetUserId: string,
        role: StaffRole
    ) {
        // Check if target user exists
        const user = await db.user.findUnique({ where: { id: targetUserId } });
        if (!user) {
            throw new Error("Target user not found");
        }

        // Check if already staff
        const existingStaff = await db.staff.findUnique({
            where: {
                userId_branchId: {
                    userId: targetUserId,
                    branchId,
                },
            },
        });

        if (existingStaff) {
            throw new Error("User is already a staff member of this branch");
        }

        return db.staff.create({
            data: {
                userId: targetUserId,
                branchId,
                role,
            },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        name: true,
                    },
                },
                permissionOverrides: true,
            },
        });
    }

    /**
     * Remove a staff member.
     * Permission: staff_management (Owner Only)
     */
    static async removeStaff(actorId: string, branchId: string, staffId: string) {
        await AccessPolicy.authorizeCapability(actorId, branchId, "staffManage");

        return db.$transaction(async (tx) => {
            await lockStaffInviteBranch(tx, branchId);

            const staffMember = await tx.staff.findUnique({
                where: { id: staffId },
                select: {
                    branchId: true,
                    user: { select: { id: true, email: true } },
                },
            });
            if (!staffMember || staffMember.branchId !== branchId) {
                throw new Error("Staff member not found");
            }

            const now = new Date();
            await tx.staffInvite.updateMany({
                where: {
                    branchId,
                    acceptedAt: null,
                    expiresAt: { gt: now },
                    token: {
                        startsWith: getStaffInviteTokenEmailPrefix(staffMember.user.email),
                    },
                },
                data: { expiresAt: now },
            });

            const deleted = await tx.staff.deleteMany({
                where: {
                    id: staffId,
                    branchId,
                },
            });

            if (deleted.count !== 1) {
                throw new Error("Staff member not found");
            }

            const { WhatsAppReportService } = await import(
                "@/services/whatsappReport.service"
            );
            await WhatsAppReportService.staleBranchSubscriptionsForUserInTransaction({
                tx,
                branchId,
                userId: staffMember.user.id,
                reason: "STAFF_REMOVED",
                now,
            });

            return deleted;
        });
    }

    /**
     * Update a staff member's role.
     * Permission: staff_management (Owner Only)
     */
    static async updateStaffRole(
        actorId: string,
        branchId: string,
        staffId: string,
        newRole: StaffRole
    ) {
        return this.updateStaffAccess(actorId, branchId, staffId, { role: newRole });
    }

    static async updateStaffPermissions(
        actorId: string,
        branchId: string,
        staffId: string,
        permissions: StaffPermissionUpdate
    ) {
        return this.updateStaffAccess(actorId, branchId, staffId, { permissions });
    }

    static async updateStaffAccess(
        actorId: string,
        branchId: string,
        staffId: string,
        data: {
            role?: StaffRole;
            permissions?: StaffPermissionUpdate;
        }
    ) {
        await AccessPolicy.authorizeCapability(actorId, branchId, "staffManage");

        const permissionUpdates = normalizePermissionUpdate(data.permissions);
        if (!data.role && permissionUpdates.length === 0) {
            throw new Error("A role or at least one permission override is required");
        }

        const staffMember = await db.staff.findUnique({
            where: { id: staffId },
            select: { branchId: true, userId: true },
        });
        if (!staffMember || staffMember.branchId !== branchId) {
            throw new Error("Staff member not found");
        }

        return db.$transaction(async (tx) => {
            if (data.role) {
                await tx.staff.update({
                    where: { id: staffId },
                    data: { role: data.role },
                });
            }

            for (const update of permissionUpdates) {
                if (update.allowed === null) {
                    await tx.staffPermissionOverride.deleteMany({
                        where: {
                            staffId,
                            action: update.permissionAction,
                        },
                    });
                    continue;
                }

                await tx.staffPermissionOverride.upsert({
                    where: {
                        staffId_action: {
                            staffId,
                            action: update.permissionAction,
                        },
                    },
                    create: {
                        staffId,
                        action: update.permissionAction,
                        allowed: update.allowed,
                    },
                    update: {
                        allowed: update.allowed,
                    },
                });
            }

            const updated = await tx.staff.findUniqueOrThrow({
                where: { id: staffId },
                include: {
                    user: {
                        select: {
                            id: true,
                            email: true,
                            name: true,
                        },
                    },
                    permissionOverrides: true,
                },
            });
            const effective = buildStaffPermissions(
                updated.role,
                updated.permissionOverrides
            );
            if (
                !effective.view_whatsapp
                || !effective.receive_whatsapp_reports
                || !effective.view_payments
                || !effective.analytics
            ) {
                const { WhatsAppReportService } = await import(
                    "@/services/whatsappReport.service"
                );
                await WhatsAppReportService.staleBranchSubscriptionsForUserInTransaction({
                    tx,
                    branchId,
                    userId: staffMember.userId,
                    reason: "STAFF_ACCESS_LOST",
                });
            }
            return updated;
        });
    }

    /**
     * List all staff in a branch.
     * Permission: manage_branch (Owner + Manager)
     * Note: Using 'manage_branch' to allow Managers to see their team.
     */
    static async listStaff(actorId: string, branchId: string) {
        await AccessPolicy.authorizeCapability(actorId, branchId, "staffView");

        return db.staff.findMany({
            where: { branchId },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        name: true,
                    },
                },
                permissionOverrides: true,
            },
            orderBy: [
                { createdAt: "asc" },
                { id: "asc" },
            ],
        });
    }

    static async listStaffPage(
        actorId: string,
        branchId: string,
        options: { cursor?: DateIdCursor | null; limit?: number } = {}
    ) {
        await AccessPolicy.authorizeCapability(actorId, branchId, "staffView");

        const limit = parsePageLimit(
            options.limit == null ? undefined : String(options.limit)
        );
        const cursor = options.cursor ?? null;
        const cursorWhere = cursor
            ? {
                OR: [
                    { createdAt: { gt: cursor.sort } },
                    { createdAt: cursor.sort, id: { gt: cursor.id } },
                ],
            }
            : {};

        const [rows, total] = await Promise.all([
            db.staff.findMany({
                where: { branchId, ...cursorWhere },
                include: {
                    user: {
                        select: {
                            id: true,
                            email: true,
                            name: true,
                        },
                    },
                    permissionOverrides: true,
                },
                orderBy: [
                    { createdAt: "asc" },
                    { id: "asc" },
                ],
                take: limit + 1,
            }),
            db.staff.count({ where: { branchId } }),
        ]);

        return pageFromRows(rows, limit, total, row => ({
            sort: row.createdAt,
            id: row.id,
        }));
    }
}
