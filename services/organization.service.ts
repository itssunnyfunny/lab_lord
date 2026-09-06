import { prisma } from "@/lib/prisma";
import { AccessPolicy } from "@/services/accessPolicy.service";
import {
    assertKnownFields,
    assertPlainObject,
    optionalChoice,
    optionalEmail,
    optionalNumber,
    optionalText,
    requiredPhone,
} from "@/lib/settingsValidation";
import { UpdateOrganizationSettingsDto, WEEK_STARTS_ON } from "@/types";
import { EntitlementService } from "@/services/entitlement.service";
import type { Prisma } from "@/app/generated/prisma/client";
import {
    OrganizationAccessNotFoundError,
    OrganizationValidationError,
} from "@/lib/organizationErrors";

const ORG_SETTINGS_FIELDS = [
    "name",
    "businessType",
    "legalName",
    "contactEmail",
    "contactPhone",
    "address",
    "timezone",
    "currency",
    "weekStartsOn",
    "paymentGraceDays",
] as const;

const ORGANIZATION_OWNER_VIEW = {
    owner: {
        select: { id: true, name: true, email: true },
    },
    branches: {
        select: { id: true, name: true, city: true, createdAt: true },
        orderBy: { createdAt: "desc" },
    },
    subscription: true,
    ownerTrialGrant: true,
    _count: { select: { branches: true } },
} satisfies Prisma.OrganizationInclude;

export class OrganizationService {
    static async getOrganizationsByUserId(userId: string) {
        return await prisma.organization.findMany({
            where: { ownerId: userId },
            include: { _count: { select: { branches: true } } },
            orderBy: { createdAt: "desc" },
        });
    }

    static async getOrganizationForOwner(id: string, userId: string) {
        const org = await this.getOrganizationForOwnerAccess(id, userId);
        await EntitlementService.assertOrganizationWritable(id);
        return org;
    }

    static async getOrganizationForOwnerAccess(id: string, userId: string) {
        return AccessPolicy.readOwnerOrganization(userId, id, ORGANIZATION_OWNER_VIEW);
    }

    static parseSettingsPayload(body: unknown): UpdateOrganizationSettingsDto {
        assertPlainObject(body);
        assertKnownFields(body, ORG_SETTINGS_FIELDS);

        const settings: UpdateOrganizationSettingsDto = {};
        const name = optionalText(body.name, "Organization name", { required: true, max: 120 });
        const businessType = optionalText(body.businessType, "Business type", { max: 80 });
        const legalName = optionalText(body.legalName, "Legal name", { max: 160 });
        const contactEmail = optionalEmail(body.contactEmail, "Contact email");
        const contactPhone = requiredPhone(body.contactPhone, "Contact phone");
        const address = optionalText(body.address, "Address", { max: 240 });
        const timezone = optionalText(body.timezone, "Timezone", { required: true, max: 80 });
        const currency = optionalText(body.currency, "Currency", { required: true, max: 3 });
        const weekStartsOn = optionalChoice(body.weekStartsOn, "Week starts on", WEEK_STARTS_ON);
        const paymentGraceDays = optionalNumber(body.paymentGraceDays, "Payment grace days", { min: 0, max: 60 });

        if (name != null) settings.name = name;
        if (businessType !== undefined) settings.businessType = businessType;
        if (legalName !== undefined) settings.legalName = legalName;
        if (contactEmail !== undefined) settings.contactEmail = contactEmail;
        if (contactPhone !== undefined) settings.contactPhone = contactPhone;
        if (address !== undefined) settings.address = address;
        if (timezone != null) settings.timezone = timezone;
        if (currency != null) settings.currency = currency.toUpperCase();
        if (weekStartsOn !== undefined) settings.weekStartsOn = weekStartsOn;
        if (paymentGraceDays !== undefined) settings.paymentGraceDays = paymentGraceDays;

        return settings;
    }

    static async updateOrganization(
        id: string,
        userId: string,
        data: UpdateOrganizationSettingsDto
    ) {
        await this.assertOwnerCanWrite(id, userId);

        return await prisma.organization.update({
            where: { id },
            data: {
                ...data,
            },
        });
    }

    static async updateSettings(id: string, userId: string, body: unknown) {
        await this.assertOwnerCanWrite(id, userId);
        let data: UpdateOrganizationSettingsDto;
        try {
            data = this.parseSettingsPayload(body);
        } catch (error) {
            throw new OrganizationValidationError(
                error instanceof Error ? error.message : "Invalid organization settings"
            );
        }
        return prisma.organization.update({ where: { id }, data });
    }

    private static async assertOwnerCanWrite(id: string, userId: string) {
        await AccessPolicy.authorizeOrganization(userId, id, { write: true });
    }

    static async isOwner(organizationId: string, userId: string): Promise<boolean> {
        try { await AccessPolicy.authorizeOrganization(userId, organizationId); return true; }
        catch (error) { if (error instanceof OrganizationAccessNotFoundError) return false; throw error; }
    }
}

