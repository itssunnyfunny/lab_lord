import { prisma } from "@/lib/prisma";
import { validateRequiredPhone, validateRequiredText } from "@/lib/formValidation";
import {
    assertKnownFields,
    assertPlainObject,
    optionalChoice,
    optionalEmail,
    optionalNumber,
    optionalText,
    requiredPhone,
} from "@/lib/settingsValidation";
import { CreateOrganizationDto, UpdateOrganizationSettingsDto, WEEK_STARTS_ON } from "@/types";
import { EntitlementService } from "@/services/entitlement.service";

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

export class OrganizationService {
    static async createOrganization(data: CreateOrganizationDto) {
        const nameResult = validateRequiredText(data.name, "Organization name", 120);
        if (!nameResult.ok) throw new Error(nameResult.error);
        const contactPhoneResult = validateRequiredPhone(data.contactPhone, "Contact phone");
        if (!contactPhoneResult.ok) throw new Error(contactPhoneResult.error);

        return await prisma.organization.create({
            data: {
                name: nameResult.value,
                ownerId: data.ownerId,
                contactPhone: contactPhoneResult.value,
            },
        });
    }

    static async getOrganizationsByUserId(userId: string) {
        return await prisma.organization.findMany({
            where: { ownerId: userId },
            include: { _count: { select: { branches: true } } },
            orderBy: { createdAt: "desc" },
        });
    }

    static async getOrganizationById(id: string) {
        return await prisma.organization.findUnique({
            where: { id },
            include: {
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
            },
        });
    }

    static async getOrganizationForOwner(id: string, userId: string) {
        const org = await this.getOrganizationForOwnerAccess(id, userId);
        await EntitlementService.assertOrganizationWritable(id);
        return org;
    }

    static async getOrganizationForOwnerAccess(id: string, userId: string) {
        const org = await this.getOrganizationById(id);
        if (!org) throw new Error("Organization not found");
        if (org.ownerId !== userId) throw new Error("Unauthorized");
        return org;
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
        const data = this.parseSettingsPayload(body);
        return prisma.organization.update({ where: { id }, data });
    }

    private static async assertOwnerCanWrite(id: string, userId: string) {
        const org = await prisma.organization.findUnique({ where: { id }, select: { ownerId: true } });
        if (!org) throw new Error("Organization not found");
        if (org.ownerId !== userId) throw new Error("Unauthorized");
        await EntitlementService.assertOrganizationWritable(id);
    }

    static async isOwner(organizationId: string, userId: string): Promise<boolean> {
        const org = await prisma.organization.findUnique({
            where: { id: organizationId },
            select: { ownerId: true },
        });
        return org?.ownerId === userId;
    }
}

