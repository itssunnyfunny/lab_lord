import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";

const WHATSAPP_DELIVERY_MIGRATION = "20260823120000_whatsapp_template_delivery_and_collections";

/**
 * Legacy-safe capability probe for boundaries that also run during rollout.
 * Requiring Prisma's completed migration record avoids treating a partially
 * applied schema (before its final indexes and constraints) as ready.
 */
export async function isWhatsAppDeliverySchemaReady(
  client: Pick<Prisma.TransactionClient, "$queryRaw"> = prisma
) {
  if (typeof client.$queryRaw !== "function") return false;
  const rows = await client.$queryRaw<Array<{ ready: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "_prisma_migrations"
      WHERE migration_name = ${WHATSAPP_DELIVERY_MIGRATION}
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL
    ) AS "ready"
  `);
  return rows.length === 1 && rows[0]?.ready === true;
}
