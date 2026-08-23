import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { WhatsAppResourceNotFoundError } from "@/lib/whatsappHttp";
import { EntitlementService } from "@/services/entitlement.service";

type PrismaClient = Prisma.TransactionClient | typeof prisma;

export class WhatsAppAuthorizationService {
  static async assertOwner(
    actorUserId: string,
    organizationId: string,
    client: PrismaClient = prisma
  ) {
    const organization = await client.organization.findFirst({
      where: { id: organizationId, ownerId: actorUserId },
      select: { id: true },
    });
    if (!organization) throw new WhatsAppResourceNotFoundError();
    return organization;
  }

  static async assertOwnerEntitled(
    actorUserId: string,
    organizationId: string,
    client: PrismaClient = prisma
  ) {
    const organization = await this.assertOwner(actorUserId, organizationId, client);
    await EntitlementService.assertOrganizationEntitlement(
      organizationId,
      "WHATSAPP_AUTOMATION",
      client
    );
    return organization;
  }

  static async assertOwnerCanWrite(
    actorUserId: string,
    organizationId: string,
    client: PrismaClient = prisma
  ) {
    const organization = await this.assertOwnerEntitled(actorUserId, organizationId, client);
    await EntitlementService.assertOrganizationWritable(organizationId, client);
    return organization;
  }
}
