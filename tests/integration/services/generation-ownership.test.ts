import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimGeneration, publishGeneration, releaseGeneration } from "@/ai/generationLease";
import { createTestWorld, createStudent } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

describe("AI generation ownership", () => {
  beforeEach(resetDatabase);
  afterAll(disconnectDatabase);
  it.each(["REPORT", "DRAFTS"] as const)("admits one %s owner, fences takeover and stale cleanup", async kind => {
    const { branch } = await createTestWorld();
    const claims = await Promise.all([claimGeneration(branch.id, kind, 0), claimGeneration(branch.id, kind, 0)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean)!;
    await testPrisma.branchGenerationLease.updateMany({ where: { branchId: branch.id }, data: { leaseUntil: new Date(0) } });
    const current = await testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } });
    const next = await claimGeneration(branch.id, kind, 0, new Date(), current.aiLastCalledAt);
    expect(next).toBeTruthy();
    await expect(publishGeneration(branch.id, kind, old, tx => tx.branchAIReport.create({
      data: { branchId: branch.id, data: { stale: true } },
    }))).rejects.toThrow("ownership");
    await releaseGeneration(branch.id, kind, old);
    expect(await testPrisma.branchGenerationLease.findUniqueOrThrow({ where: { branchId_kind: { branchId: branch.id, kind } } }))
      .toMatchObject({ token: next });
    await publishGeneration(branch.id, kind, next!, tx => tx.branchAIReport.create({ data: { branchId: branch.id, data: { current: true } } }));
    expect(await testPrisma.branchAIReport.count({ where: { branchId: branch.id } })).toBe(1);
  });
  it("reserves draft cooldown before generation and rolls back a failed batch publication", async () => {
    const { branch } = await createTestWorld();
    const student = await createStudent({ branchId: branch.id });
    const old = await testPrisma.messageDraft.create({ data: { branchId: branch.id, studentId: student.id,
      action: "overdue", language: "en", message: "Original" } });
    const token = await claimGeneration(branch.id, "DRAFTS", 60_000);
    await expect(publishGeneration(branch.id, "DRAFTS", token!, async tx => {
      await tx.messageDraft.deleteMany({ where: { branchId: branch.id } });
      await tx.messageDraft.create({ data: { branchId: branch.id, studentId: student.id, action: "overdue", language: "en", message: "New" } });
      throw new Error("batch persistence failure");
    })).rejects.toThrow("persistence");
    expect(await testPrisma.messageDraft.findUnique({ where: { id: old.id } })).toMatchObject({ message: "Original" });
    await releaseGeneration(branch.id, "DRAFTS", token!);
    expect(await claimGeneration(branch.id, "DRAFTS", 60_000)).toBeNull();
    await expect(testPrisma.messageDraft.create({ data: { branchId: branch.id, studentId: student.id,
      action: "overdue", language: "en", message: "Duplicate" } })).rejects.toMatchObject({ code: "P2002" });
  });
});
