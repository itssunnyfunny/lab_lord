import { prisma } from "@/lib/prisma";
import {
    assertKnownFields,
    assertPlainObject,
    optionalChoice,
    optionalText,
    requiredPhone,
} from "@/lib/settingsValidation";
import {
    DEFAULT_LANDING_PAGES,
    DENSITY_PREFERENCES,
    MESSAGE_LANGUAGES,
    THEME_PREFERENCES,
    UpdateUserSettingsDto,
    type WorkspaceDirectory,
} from "@/types";
import { StaffService } from "@/services/staff.service";
import { resolveWorkspacePath } from "@/lib/workspaceRouting";

const USER_SETTINGS_FIELDS = [
    "name",
    "phone",
    "timezone",
    "locale",
    "dateFormat",
    "themePreference",
    "densityPreference",
    "defaultMessageLanguage",
    "defaultLandingPage",
] as const;

export class UserService {
    static async getWorkspaceRoutingState(userId: string) {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                organizations: {
                    select: {
                        id: true,
                        createdAt: true,
                        branches: {
                            select: {
                                id: true,
                                createdAt: true,
                            },
                            orderBy: { createdAt: "desc" },
                        },
                    },
                    orderBy: { createdAt: "desc" },
                },
                staff: {
                    select: {
                        createdAt: true,
                        branch: {
                            select: {
                                id: true,
                                createdAt: true,
                            },
                        },
                    },
                    orderBy: { createdAt: "desc" },
                },
            },
        });

        return {
            ownedOrganizations: user?.organizations ?? [],
            staffBranches: user?.staff.map(member => ({
                id: member.branch.id,
                createdAt: member.createdAt,
            })) ?? [],
        };
    }

    static async getUserProfile(userId: string) {
        return prisma.user.findUnique({
            where: { id: userId },
            include: {
                organizations: {
                    include: {
                        branches: { select: { id: true } },
                    },
                },
                staff: {
                    include: {
                        branch: { select: { id: true, name: true } },
                    },
                },
            },
        });
    }

    static async getWorkspaceDirectory(
        userId: string,
        lastBranchId?: string | null
    ): Promise<WorkspaceDirectory> {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                defaultLandingPage: true,
                organizations: {
                    select: {
                        id: true,
                        name: true,
                        createdAt: true,
                        branches: {
                            select: { id: true, name: true, createdAt: true },
                            orderBy: { createdAt: "desc" },
                        },
                    },
                    orderBy: { createdAt: "desc" },
                },
                staff: {
                    select: {
                        createdAt: true,
                        branch: {
                            select: {
                                id: true,
                                name: true,
                                organizationId: true,
                                organization: { select: { name: true } },
                            },
                        },
                    },
                    orderBy: { createdAt: "desc" },
                },
            },
        });

        if (!user) {
            throw new Error("User not found");
        }

        const allBranchIds = new Set<string>();
        for (const organization of user.organizations) {
            for (const branch of organization.branches) allBranchIds.add(branch.id);
        }
        for (const membership of user.staff) allBranchIds.add(membership.branch.id);

        const branchAccess = await Promise.all(
            [...allBranchIds].map(branchId => StaffService.getBranchAccess(userId, branchId))
        );
        const accessByBranchId = new Map(branchAccess.map(access => [access.branchId, access]));

        const organizations = user.organizations.map(organization => ({
            id: organization.id,
            name: organization.name,
            role: "OWNER" as const,
            href: `/org/${organization.id}`,
            branches: organization.branches.map(branch => {
                const access = accessByBranchId.get(branch.id)!;
                return {
                    id: branch.id,
                    name: branch.name,
                    organizationId: organization.id,
                    organizationName: organization.name,
                    role: access.role,
                    permissions: access.permissions,
                    entitlements: access.entitlements,
                    href: `/branch/${branch.id}`,
                };
            }),
        }));

        const ownedBranchIds = new Set(
            organizations.flatMap(organization => organization.branches.map(branch => branch.id))
        );
        const staffBranches = user.staff
            .filter(membership => !ownedBranchIds.has(membership.branch.id))
            .map(membership => {
                const access = accessByBranchId.get(membership.branch.id)!;
                return {
                    id: membership.branch.id,
                    name: membership.branch.name,
                    organizationId: membership.branch.organizationId,
                    organizationName: membership.branch.organization.name,
                    role: access.role,
                    permissions: access.permissions,
                    entitlements: access.entitlements,
                    href: `/branch/${membership.branch.id}`,
                };
            });

        const routingState = {
            ownedOrganizations: user.organizations,
            staffBranches: user.staff.map(membership => ({
                id: membership.branch.id,
                createdAt: membership.createdAt,
            })),
            lastBranchId,
        };

        return {
            organizations,
            staffBranches,
            defaultHref: user.defaultLandingPage === "account"
                ? "/account"
                : resolveWorkspacePath(routingState),
        };
    }

    static parseSettingsPayload(body: unknown): UpdateUserSettingsDto {
        assertPlainObject(body);
        assertKnownFields(body, USER_SETTINGS_FIELDS);

        const settings: UpdateUserSettingsDto = {};
        const name = optionalText(body.name, "Name", { required: true, max: 120 });
        const phone = requiredPhone(body.phone, "Phone");
        const timezone = optionalText(body.timezone, "Timezone", { required: true, max: 80 });
        const locale = optionalText(body.locale, "Locale", { required: true, max: 24 });
        const dateFormat = optionalText(body.dateFormat, "Date format", { required: true, max: 40 });
        const themePreference = optionalChoice(body.themePreference, "Theme preference", THEME_PREFERENCES);
        const densityPreference = optionalChoice(body.densityPreference, "Density preference", DENSITY_PREFERENCES);
        const defaultMessageLanguage = optionalChoice(body.defaultMessageLanguage, "Default message language", MESSAGE_LANGUAGES);
        const defaultLandingPage = optionalChoice(body.defaultLandingPage, "Default landing page", DEFAULT_LANDING_PAGES);

        if (name != null) settings.name = name;
        if (phone !== undefined) settings.phone = phone;
        if (timezone != null) settings.timezone = timezone;
        if (locale != null) settings.locale = locale;
        if (dateFormat != null) settings.dateFormat = dateFormat;
        if (themePreference !== undefined) settings.themePreference = themePreference;
        if (densityPreference !== undefined) settings.densityPreference = densityPreference;
        if (defaultMessageLanguage !== undefined) settings.defaultMessageLanguage = defaultMessageLanguage;
        if (defaultLandingPage !== undefined) settings.defaultLandingPage = defaultLandingPage;

        return settings;
    }

    static async updateSettings(userId: string, body: unknown) {
        const data = this.parseSettingsPayload(body);
        return prisma.user.update({
            where: { id: userId },
            data,
        });
    }
}
