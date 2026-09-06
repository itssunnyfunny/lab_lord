import { AccessPolicy } from "@/services/accessPolicy.service";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWorld, createStudent, createPayment, createSaasSubscription } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";
import * as generation from "@/ai/generationLease";
import { runBranchAI } from "@/ai/orchestrator/branchAI.orchestrator";
import { draftOverdueMessages } from "@/ai/messageDrafting/branchMessageDrafter";
const mocks = vi.hoisted(() => ({ report: vi.fn(), gemini: vi.fn() }));
vi.mock("@/ai/branchHealthReport", () => ({ generateBranchHealthReport: mocks.report }));
vi.mock("@/ai/llm/gemini.client", () => ({ callGemini: mocks.gemini }));

describe("AI generation callers", () => {
  beforeEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await resetDatabase(); });
  afterAll(disconnectDatabase);

  it("takes over an expired report owner at six minutes and rejects its late completion", async () => {
    const { branch, user, org } = await createTestWorld();
    await createSaasSubscription({organizationId:org.id});
    const access = await AccessPolicy.authorizeCapability(user.id,branch.id,"aiGenerate");
    await testPrisma.branch.update({ where: { id: branch.id }, data: { aiEnabled: true } });
    let resolveOld!: (report: object) => void;
    let admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    mocks.report.mockImplementationOnce(() => {
      admitted();
      return new Promise(resolve => { resolveOld = resolve; });
    }).mockResolvedValue({ marker: "current" });
    const oldRun = runBranchAI(access);
    const oldOutcome = expect(oldRun).rejects.toThrow("ownership");
    await started;
    await testPrisma.branch.update({ where: { id: branch.id }, data: { aiLastCalledAt: new Date(Date.now() - 6 * 60_000) } });
    await testPrisma.branchGenerationLease.updateMany({ where: { branchId: branch.id }, data: { leaseUntil: new Date(0) } });
    await expect(runBranchAI(access)).resolves.toMatchObject({ report: { marker: "current" } });
    resolveOld({ marker: "stale" });
    await oldOutcome;
    expect(await testPrisma.branchAIReport.count({ where: { branchId: branch.id } })).toBe(1);
    expect(await testPrisma.branch.findUniqueOrThrow({ where: { id: branch.id } })).toMatchObject({ aiStatus: "IDLE" });
  });

  async function overdueBranch() {
    const { branch, user, org } = await createTestWorld();
    await createSaasSubscription({organizationId:org.id});
    const access = await AccessPolicy.authorizeCapability(user.id,branch.id,"aiGenerate");
    await testPrisma.branch.update({ where: { id: branch.id }, data: { aiEnabled: true } });
    const student = await createStudent({ branchId: branch.id });
    await createPayment({ branchId: branch.id, studentId: student.id,
      dueDate: new Date("2020-01-01"), periodStart: new Date("2020-01-01"), periodEnd: new Date("2020-02-01") });
    return access;
  }

  it("returns durable cooldown to a concurrent POST and read-only GET", async () => {
    const access = await overdueBranch();
    let complete!: (text: string) => void;
    let admitted!: () => void;
    const started = new Promise<void>(resolve => { admitted = resolve; });
    mocks.gemini.mockImplementationOnce(() => { admitted(); return new Promise(resolve => { complete = resolve; }); });
    const first = draftOverdueMessages(access);
    await started;
    const second = await draftOverdueMessages(access);
    expect(second.meta.rateLimited).toBe(true);
    expect(new Date(second.meta.nextAllowedCallAt).getTime()).toBeGreaterThan(Date.now());
    const cached = await draftOverdueMessages(access, { allowGeneration: false });
    expect(cached.meta.nextAllowedCallAt).toBe(second.meta.nextAllowedCallAt);
    expect(mocks.gemini).toHaveBeenCalledTimes(1);
    complete("[]");
    await expect(first).resolves.toMatchObject({ meta: { generatedCount: 1 } });
  });

  it("preserves cooldown after failed publication in GET and POST metadata", async () => {
    const access = await overdueBranch();
    mocks.gemini.mockResolvedValue("[]");
    vi.spyOn(generation, "publishGeneration").mockRejectedValueOnce(new Error("publication failed"));
    await expect(draftOverdueMessages(access)).rejects.toThrow("publication failed");
    const cached = await draftOverdueMessages(access, { allowGeneration: false });
    const retry = await draftOverdueMessages(access);
    expect(retry.meta.rateLimited).toBe(true);
    expect(new Date(cached.meta.nextAllowedCallAt).getTime()).toBeGreaterThan(Date.now());
    expect(retry.meta.nextAllowedCallAt).toBe(cached.meta.nextAllowedCallAt);
    expect(mocks.gemini).toHaveBeenCalledTimes(1);
    expect(await testPrisma.messageDraft.count()).toBe(0);
  });
});
