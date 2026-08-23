import { Prisma } from "@/app/generated/prisma/client";

/**
 * Serializes webhook insertion/projection with provider-response finalization
 * for one sender-scoped Meta message ID. The lock contains no customer data and
 * is released automatically with the surrounding transaction.
 */
export async function lockWhatsAppProviderMessage(
  tx: Prisma.TransactionClient,
  input: { senderId: string; providerMessageId: string }
) {
  // PostgreSQL text values cannot contain NUL bytes. A JSON tuple remains
  // unambiguous for arbitrary bounded identifiers without relying on a
  // delimiter that either identifier could contain.
  const lockKey = JSON.stringify([
    "META_CLOUD",
    input.senderId,
    input.providerMessageId,
  ]);
  await tx.$queryRaw<Array<{ lockAcquired: string }>>(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS "lockAcquired"
  `);
}
