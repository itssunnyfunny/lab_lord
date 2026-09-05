import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";

type Kind = "REPORT" | "DRAFTS";
const LEASE_MS = 5 * 60_000;

export async function claimGeneration(branchId: string, kind: Kind, cooldownMs: number,
  now = new Date(), expectedReportStart?: Date | null) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id" = ${branchId} FOR UPDATE`;
    const branch = await tx.branch.findUniqueOrThrow({ where: { id: branchId } });
    if (kind === "REPORT" && branch.aiLastCalledAt?.getTime() !== expectedReportStart?.getTime()) return null;
    const previous = await tx.branchGenerationLease.findUnique({ where: { branchId_kind: { branchId, kind } } });
    if (previous && ((previous.token && previous.leaseUntil && previous.leaseUntil > now)
      || previous.lastStartedAt.getTime() + cooldownMs > now.getTime())) return null;
    const token = randomUUID();
    await tx.branchGenerationLease.upsert({ where: { branchId_kind: { branchId, kind } },
      create: { branchId, kind, token, lastStartedAt: now, leaseUntil: new Date(now.getTime() + LEASE_MS) },
      update: { token, lastStartedAt: now, leaseUntil: new Date(now.getTime() + LEASE_MS) } });
    if (kind === "REPORT") await tx.branch.update({ where: { id: branchId }, data: { aiStatus: "RUNNING", aiLastCalledAt: now } });
    return token;
  });
}

export async function publishGeneration<T>(branchId: string, kind: Kind, token: string,
  publish: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id" = ${branchId} FOR UPDATE`;
    const lease = await tx.branchGenerationLease.findUnique({ where: { branchId_kind: { branchId, kind } } });
    if (lease?.token !== token || !lease.leaseUntil || lease.leaseUntil <= new Date()) {
      throw new Error("AI generation ownership expired or changed");
    }
    const result = await publish(tx);
    await tx.branchGenerationLease.update({ where: { id: lease.id }, data: { token: null, leaseUntil: null } });
    if (kind === "REPORT") await tx.branch.update({ where: { id: branchId }, data: { aiStatus: "IDLE" } });
    return result;
  });
}

export async function releaseGeneration(branchId: string, kind: Kind, token: string) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id" = ${branchId} FOR UPDATE`;
    const released = await tx.branchGenerationLease.updateMany({ where: { branchId, kind, token },
      data: { token: null, leaseUntil: null } });
    if (released.count && kind === "REPORT") await tx.branch.update({ where: { id: branchId }, data: { aiStatus: "IDLE" } });
  });
}
