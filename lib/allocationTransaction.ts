import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";

/** All allocation creation/replacement and shift deactivation use this protocol.
 * Serializable predicate reads fence concurrent inserts into the source set;
 * retries must repeat validation, never just the final writes.
 * Import execution composes the same work in its own serializable transaction.
 */
export async function runAllocationTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
        } catch (error) {
            if (attempt === 3 || typeof error !== "object" || error === null
                || !("code" in error) || error.code !== "P2034") throw error;
        }
    }
    throw new Error("Allocation transaction could not be completed.");
}
