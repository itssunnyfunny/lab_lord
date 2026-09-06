import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportSessionService } from "@/importing/services/import-session.service";
import { createTestWorld } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";
const mocks = vi.hoisted(() => ({ map: vi.fn() }));
vi.mock("@/importing/ai/import-column-mapper.ai", () => ({ mapImportColumns: mocks.map }));
const mapping = { entityTypesDetected: ["STUDENT"], columnMappings: [], questions: [], warnings: [], suggestedImportOptions: {} };

describe("import analysis ownership", () => {
  beforeEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await resetDatabase(); });
  afterAll(disconnectDatabase);
  it.each(["success", "failure"])("a superseded %s cannot publish or release the current attempt", async outcome => {
    const { user, branch } = await createTestWorld();
    const session = await testPrisma.importSession.create({ data: {
      branchId: branch.id, uploadedByUserId: user.id, sourceType: "PASTED_TABLE", engineVersion: 2,
      goal: "STUDENTS", fileMeta: { columns: ["Name"] },
      rows: { create: { rowNumber: 1, rawData: { Name: "Test" }, status: "READY" } },
    } });
    // Keep the test focused on publication ownership, using the real database and policy.
    const internals = ImportSessionService as unknown as {
      getValidationContext: () => Promise<unknown>; revalidateAuthorizedSession: () => Promise<unknown>;
    };
    vi.spyOn(internals, "getValidationContext").mockResolvedValue({ aiBranchContext: {} });
    vi.spyOn(internals, "revalidateAuthorizedSession").mockResolvedValue({ activeEvaluationRevision: 1 });
    let finishOld!: (value: unknown) => void, failOld!: (error: Error) => void, finishNew!: (value: unknown) => void;
    let startOld!: () => void, startNew!: () => void;
    const oldStarted = new Promise<void>(r => { startOld = r; });
    const newStarted = new Promise<void>(r => { startNew = r; });
    mocks.map.mockImplementationOnce(() => { startOld(); return new Promise((r, j) => { finishOld = r; failOld = j; }); })
      .mockImplementationOnce(() => { startNew(); return new Promise(r => { finishNew = r; }); });
    const old = ImportSessionService.analyzeSession(user.id, branch.id, session.id, 0);
    const oldRejected = expect(old).rejects.toMatchObject({ code: "IMPORT_ANALYSIS_OWNERSHIP_LOST" });
    await oldStarted;
    await expect(ImportSessionService.analyzeSession(user.id, branch.id, session.id, 0)).rejects.toMatchObject({ code: "IMPORT_ANALYSIS_BUSY" });
    expect(mocks.map).toHaveBeenCalledTimes(1);
    await testPrisma.importSession.update({ where: { id: session.id }, data: { analysisLeaseUntil: new Date(0) } });
    const current = ImportSessionService.analyzeSession(user.id, branch.id, session.id, 0);
    await newStarted;
    const owned = await testPrisma.importSession.findUniqueOrThrow({ where: { id: session.id } });
    if (outcome === "success") finishOld(mapping); else failOld(new Error("provider failed"));
    await oldRejected;
    await expect(testPrisma.importSession.findUniqueOrThrow({ where: { id: session.id } })).resolves.toMatchObject({
      analysisLeaseToken: owned.analysisLeaseToken, status: "ANALYZING", draftRevision: 0, mapping: null,
    });
    finishNew(mapping);
    await current;
    await expect(testPrisma.importSession.findUniqueOrThrow({ where: { id: session.id } })).resolves.toMatchObject({
      analysisLeaseToken: null, analysisLeaseUntil: null, draftRevision: 1,
    });
  });
});
