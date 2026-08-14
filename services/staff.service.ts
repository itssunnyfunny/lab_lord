import { prisma as db } from "@/lib/prisma";
import {
    BranchAccess,
    EntityPermissionMatrix,
    OVERRIDABLE_STAFF_ACTIONS,
    OverridableStaffAction,
    STAFF_ACTIONS,
    StaffAction,
    StaffPermissionAction,
    StaffPermissionUpdate,
    StaffRole,
} from "@/types";
import { EntitlementService } from "@/services/entitlement.service";
import {
    type DateIdCursor,
    pageFromRows,
    parsePageLimit,
} from "@/lib/cursorPagination";
import {
    getStaffInviteTokenEmailPrefix,
    lockStaffInviteBranch,
} from "@/services/staffInviteSecurity";

// ==========================================
// 1. TYPES & PERMISSION MATRIX
// ==========================================

/**
 * Roles allowed to perform an action (IN ADDITION to Organization Owner).
 * If a role is listed here, it is allowed.
 * Owner is implicitly allowed for everything on their own org/branch.
 */
export const PERMISSION_MATRIX: EntityPermissionMatrix = {
    manage_org: [], // OWNER only
    manage_branch: [StaffRole.MANAGER],
    students: [StaffRole.MANAGER, StaffRole.STAFF],
    seat_allocation: [StaffRole.MANAGER, StaffRole.STAFF],
    view_payments: [StaffRole.MANAGER, StaffRole.STAFF],
    generate_payments: [StaffRole.MANAGER],
    mark_payment_paid: [StaffRole.MANAGER, StaffRole.STAFF],
    waive_payments: [StaffRole.MANAGER],
    analytics: [StaffRole.MANAGER],
    staff_management: [], // OWNER only
};

const ACTION_TO_PERMISSION_ACTION: Record<OverridableStaffAction, StaffPermissionAction> = {
    manage_branch: StaffPermissionAction.MANAGE_BRANCH,
    students: StaffPermissionAction.STUDENTS,
    seat_allocation: StaffPermissionAction.SEAT_ALLOCATION,
    view_payments: StaffPermissionAction.VIEW_PAYMENTS,
    generate_payments: StaffPermissionAction.GENERATE_PAYMENTS,
    mark_payment_paid: StaffPermissionAction.MARK_PAYMENT_PAID,
    waive_payments: StaffPermissionAction.WAIVE_PAYMENTS,
    analytics: StaffPermissionAction.ANALYTICS,
};

const OVERRIDABLE_ACTION_SET = new Set<string>(OVERRIDABLE_STAFF_ACTIONS);

function isOverridableStaffAction(action: StaffAction): action is OverridableStaffAction {
    return OVERRIDABLE_ACTION_SET.has(action);
}

function normalizePermissionUpdate(permissions: StaffPermissionUpdate | undefined) {
    if (!permissions) return [];

    return Object.entries(permissions).map(([action, allowed]) => {
        if (!OVERRIDABLE_ACTION_SET.has(action)) {
            throw new Error(`Permission '${action}' cannot be overridden`);
        }
        if (allowed !== true && allowed !== false && allowed !== null) {
            throw new Error(`Permission '${action}' must be true, false, or null`);
        }

        return {
            action: action as OverridableStaffAction,
            permissionAction: ACTION_TO_PERMISSION_ACTION[action as OverridableStaffAction],
            allowed,
        };
    });
}

function buildOwnerPermissions() {
    return STAFF_ACTIONS.reduce<Record<StaffAction, boolean>>((permissions, action) => {
        permissions[action] = true;
        return permissions;
    }, {} as Record<StaffAction, boolean>);
}

function buildStaffPermissions(
    role: StaffRole,
    permissionOverrides: { action: StaffPermissionAction; allowed: boolean }[]
) {
    return STAFF_ACTIONS.reduce<Record<StaffAction, boolean>>((permissions, action) => {
        const permissionAction = isOverridableStaffAction(action)
            ? ACTION_TO_PERMISSION_ACTION[action]
            : null;
        const override = permissionAction
            ? permissionOverrides.find(item => item.action === permissionAction)
            : null;

        permissions[action] = override?.allowed ?? PERMISSION_MATRIX[action].includes(role);
        return permissions;
    }, {} as Record<StaffAction, boolean>);
}

async function applySubscriptionPermissions(
    organizationId: string,
    permissions: Record<StaffAction, boolean>
) {
    const profile = await EntitlementService.getOrganizationProfile(organizationId);
    return {
        permissions,
        effectivePlan: profile.effectivePlan,
        entitlements: profile.entitlements,
    };
}

export class StaffService {
    private static normalizeEmail(email: string) {
        return email.trim().toLowerCase();
    }

    private static async assertActionEntitlement(organizationId: string, action: StaffAction) {
        if (action === "staff_management") {
            await EntitlementService.assertOrganizationEntitlement(organizationId, "STAFF_MANAGEMENT");
        }
        if (action === "analytics") {
            await EntitlementService.assertOrganizationEntitlement(organizationId, "ADVANCED_ANALYTICS");
        }
    }

    // ==========================================
    // 2. AUTHORIZATION CHECK (The Core Logic)
    // ==========================================

    /**
     * Authorize a user to perform an action on a specific branch.
     * Logic:
     * 1. Check if user is Org OWNER -> Allow.
     * 2. If not, fetch Staff role for this branch.
     * 3. Match role against PERMISSION_MATRIX.
     * 4. Return true or throw Error.
     */
    static async authorizeRole(userId: string, branchId: string, action: StaffAction): Promise<boolean> {
        // 1. Check if User is the Org Owner of this branch
        const branch = await db.branch.findUnique({
            where: { id: branchId },
            include: { organization: true },
        });

        if (!branch) {
            throw new Error("Branch not found");
        }

        if (branch.organization.ownerId === userId) {
            return true; // ✅ Owner is always allowed
        }

        // 2. Not Owner? Check Staff Role
        const staffMember = await db.staff.findUnique({
            where: {
                userId_branchId: {
                    userId,
                    branchId,
                },
            },
            include: {
                permissionOverrides: {
                    select: {
                        action: true,
                        allowed: true,
                    },
                },
            },
        });

        if (!staffMember) {
            throw new Error("Unauthorized: Not a staff member of this branch");
        }

        if (isOverridableStaffAction(action)) {
            const permissionAction = ACTION_TO_PERMISSION_ACTION[action];
            const override = staffMember.permissionOverrides.find(item => item.action === permissionAction);
            if (override) {
                if (override.allowed) {
                    return true;
                }
                throw new Error(`Unauthorized: Permission '${action}' is disabled for this staff member`);
            }
        }

        // 3. Match Role against Matrix
        const allowedRoles = PERMISSION_MATRIX[action];
        if (allowedRoles.includes(staffMember.role)) {
            return true; // ✅ Role is allowed
        }

        // 4. Reject
        throw new Error(`Unauthorized: Role '${staffMember.role}' cannot perform '${action}'`);
    }

    static async authorize(userId: string, branchId: string, action: StaffAction): Promise<boolean> {
        await this.authorizeRole(userId, branchId, action);
        const branch = await db.branch.findUnique({
            where: { id: branchId },
            select: { organizationId: true },
        });
        if (!branch) throw new Error("Branch not found");
        await this.assertActionEntitlement(branch.organizationId, action);
        return true;
    }

    static async getBranchAccess(userId: string, branchId: string): Promise<BranchAccess> {
        const branch = await db.branch.findUnique({
            where: { id: branchId },
            include: { organization: true },
        });

        if (!branch) {
            throw new Error("Branch not found");
        }

        if (branch.organization.ownerId === userId) {
            const subscriptionAccess = await applySubscriptionPermissions(
                branch.organizationId,
                buildOwnerPermissions()
            );
            return {
                branchId,
                branchName: branch.name,
                organizationId: branch.organizationId,
                isOwner: true,
                role: "OWNER",
                ...subscriptionAccess,
            };
        }

        const staffMember = await db.staff.findUnique({
            where: {
                userId_branchId: {
                    userId,
                    branchId,
                },
            },
            include: {
                permissionOverrides: {
                    select: {
                        action: true,
                        allowed: true,
                    },
                },
            },
        });

        if (!staffMember) {
            throw new Error("Unauthorized: Not a staff member of this branch");
        }

        const subscriptionAccess = await applySubscriptionPermissions(
            branch.organizationId,
            buildStaffPermissions(staffMember.role, staffMember.permissionOverrides)
        );
        return {
            branchId,
            branchName: branch.name,
            organizationId: branch.organizationId,
            isOwner: false,
            role: staffMember.role,
            staffId: staffMember.id,
            ...subscriptionAccess,
        };
    }

    // ==========================================
    // 3. SERVICE METHODS
    // ==========================================

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
        await this.authorize(actorId, branchId, "staff_management");
        await EntitlementService.assertBranchWritable(branchId);
        return this.createStaffMembership(branchId, targetUserId, role);
    }

    static async addStaffByEmail(
        actorId: string,
        branchId: string,
        targetEmail: string,
        role: StaffRole
    ) {
        await this.authorize(actorId, branchId, "staff_management");
        await EntitlementService.assertBranchWritable(branchId);

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
        await this.authorize(actorId, branchId, "staff_management");
        await EntitlementService.assertBranchWritable(branchId);

        return db.$transaction(async (tx) => {
            await lockStaffInviteBranch(tx, branchId);

            const staffMember = await tx.staff.findUnique({
                where: { id: staffId },
                select: {
                    branchId: true,
                    user: { select: { email: true } },
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
        await this.authorize(actorId, branchId, "staff_management");
        await EntitlementService.assertBranchWritable(branchId);

        const permissionUpdates = normalizePermissionUpdate(data.permissions);
        if (!data.role && permissionUpdates.length === 0) {
            throw new Error("A role or at least one permission override is required");
        }

        const staffMember = await db.staff.findUnique({
            where: { id: staffId },
            select: { branchId: true },
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

            return tx.staff.findUniqueOrThrow({
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
        });
    }

    /**
     * List all staff in a branch.
     * Permission: manage_branch (Owner + Manager)
     * Note: Using 'manage_branch' to allow Managers to see their team.
     */
    static async listStaff(actorId: string, branchId: string) {
        await this.authorize(actorId, branchId, "manage_branch");
        await EntitlementService.assertBranchEntitlement(branchId, "STAFF_MANAGEMENT");

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
        await this.authorize(actorId, branchId, "manage_branch");
        await EntitlementService.assertBranchEntitlement(branchId, "STAFF_MANAGEMENT");

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
