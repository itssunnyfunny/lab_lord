import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportPlanService } from "@/importing/services/import-plan.service";
import { ImportRunExecutor } from "@/importing/services/import-run-executor.service";
import { ImportRunService } from "@/importing/services/import-run.service";
import { ImportRunRunner } from "@/importing/services/import-runner.service";
import { createTestWorld } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";
import { freezeTime, restoreTime } from "@/tests/setup/time";

const FAILURE_TRIGGER = "import_v2_fail_success_marker";
const FAILURE_FUNCTION = "import_v2_fail_success_marker_once";
const ORIGINAL_MUTATION_LIMIT = process.env.IMPORT_MAX_PLANNED_MUTATIONS;

async function removeFailureInjection() {
    await testPrisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${FAILURE_TRIGGER} ON "ImportRunItem"`
    );
    await testPrisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS ${FAILURE_FUNCTION}()`
    );
}

describe("Import V2 commit flow integration", () => {
    afterAll(async () => {
        await disconnectDatabase();
    });

    beforeEach(async () => {
        process.env.IMPORT_MAX_PLANNED_MUTATIONS = "1000";
        freezeTime(new Date("2026-07-05T00:00:00.000Z"));
        await removeFailureInjection();
        await resetDatabase();
    });

    afterEach(async () => {
        if (ORIGINAL_MUTATION_LIMIT === undefined) {
            delete process.env.IMPORT_MAX_PLANNED_MUTATIONS;
        } else {
            process.env.IMPORT_MAX_PLANNED_MUTATIONS = ORIGINAL_MUTATION_LIMIT;
        }
        await removeFailureInjection();
        restoreTime();
    });

    it("atomically applies a mutation and its marker, then safely replays the item and commit request", async () => {
        const { user, branch } = await createTestWorld({ defaultFee: 1200 });
        const normalizedData = {
            student: {
                name: "Aarav Sharma",
                phone: "9876501001",
                joinedAt: "2026-01-05T00:00:00.000Z",
                monthlyFee: 1200,
            },
        };
        const session = await testPrisma.importSession.create({
            data: {
                branchId: branch.id,
                uploadedByUserId: user.id,
                sourceType: "PASTED_TABLE",
                fileName: "ready-import.csv",
                engineVersion: 2,
                goal: "STUDENTS",
                status: "READY_TO_COMMIT",
                draftRevision: 1,
                activeEvaluationRevision: 1,
                sourceConfiguration: { sourceType: "PASTED_TABLE" },
                fileMeta: { columns: ["Student Name", "Phone", "Joined Date", "Monthly Fee"], rowCount: 1 },
                mapping: {
                    entityTypesDetected: ["STUDENT"],
                    columnMappings: [
                        { sourceColumn: "Student Name", targetField: "student.name", confidence: 100, source: "MANUAL" },
                        { sourceColumn: "Phone", targetField: "student.phone", confidence: 100, source: "MANUAL" },
                        { sourceColumn: "Joined Date", targetField: "student.joinedAt", confidence: 100, source: "MANUAL" },
                        { sourceColumn: "Monthly Fee", targetField: "student.monthlyFee", confidence: 100, source: "MANUAL" },
                    ],
                    questions: [],
                    warnings: [],
                    importOptions: {
                        paymentCycle: "SKIP_PAYMENTS",
                        paymentAction: "SKIP_PAYMENTS",
                    },
                },
                summary: {
                    totalRows: 1,
                    readyRows: 1,
                    needsReviewRows: 0,
                    blockedRows: 0,
                    warningRows: 0,
                    duplicateRows: 0,
                    conflictRows: 0,
                    skippedRows: 0,
                    readinessScore: 100,
                    detectedEntityCounts: { STUDENT: 1, SEAT: 0, SHIFT: 0, ALLOCATION: 0, PAYMENT: 0 },
                    warnings: [],
                    openQuestions: 0,
                    attention: [],
                },
            },
        });
        const row = await testPrisma.importRow.create({
            data: {
                importSessionId: session.id,
                rowNumber: 2,
                rawData: {
                    "Student Name": "Aarav Sharma",
                    Phone: "9876501001",
                    "Joined Date": "2026-01-05",
                    "Monthly Fee": "1200",
                },
                mappedData: normalizedData,
                normalizedData,
                status: "READY",
                issues: [],
                warnings: [],
                confidence: 100,
            },
        });
        await testPrisma.importRowEvaluation.create({
            data: {
                importRowId: row.id,
                revision: 1,
                engineVersion: 2,
                status: "READY",
                mappedData: normalizedData,
                normalizedData,
                issues: [],
                warnings: [],
                confidence: 100,
            },
        });

        const plan = await ImportPlanService.compilePlan({
            userId: user.id,
            branchId: branch.id,
            sessionId: session.id,
            targetRevision: 1,
            readinessPolicy: "READY_ROWS_ONLY",
        });
        expect(plan).toMatchObject({ canRun: true, totalRows: 1, readyRows: 1 });

        const request = {
            userId: user.id,
            branchId: branch.id,
            sessionId: session.id,
            kind: "COMMIT" as const,
            importPlanId: plan.id,
            confirmedPlanVersion: plan.planVersion,
            targetRevision: 1,
            idempotencyKey: "import-v2-integration-commit-1",
        };
        const run = await ImportRunService.createOrGetRun(request);
        await expect(ImportRunService.createOrGetRun(request)).resolves.toMatchObject({ id: run.id });

        const [claimed] = await ImportRunRunner.claimBatch({
            importRunId: run.id,
            workerId: "integration-worker-0",
            limit: 25,
        });
        expect(claimed).toMatchObject({ kind: "STUDENT", attemptCount: 1 });

        await testPrisma.$executeRawUnsafe(`
            CREATE FUNCTION ${FAILURE_FUNCTION}() RETURNS trigger AS $$
            BEGIN
                IF NEW.status = 'SUCCEEDED' AND OLD.status = 'RUNNING' THEN
                    RAISE EXCEPTION 'injected failure before durable completion marker';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);
        await testPrisma.$executeRawUnsafe(`
            CREATE TRIGGER ${FAILURE_TRIGGER}
            BEFORE UPDATE ON "ImportRunItem"
            FOR EACH ROW EXECUTE FUNCTION ${FAILURE_FUNCTION}()
        `);

        await expect(ImportRunExecutor.executeClaimedItem(claimed))
            .rejects.toThrow("injected failure before durable completion marker");
        expect(await testPrisma.student.count({ where: { branchId: branch.id } })).toBe(0);
        await expect(testPrisma.importRunItem.findUniqueOrThrow({ where: { id: claimed.id } }))
            .resolves.toMatchObject({ status: "RUNNING", attemptCount: 1 });

        await removeFailureInjection();
        await expect(ImportRunExecutor.executeClaimedItem(claimed))
            .resolves.toEqual({ alreadyCompleted: false });
        await expect(ImportRunExecutor.executeClaimedItem(claimed))
            .resolves.toEqual({ alreadyCompleted: true });

        const student = await testPrisma.student.findFirstOrThrow({
            where: { branchId: branch.id, name: "Aarav Sharma" },
        });
        expect(student.phone).toBe("+91 98765 01001");
        expect(await testPrisma.student.count({ where: { branchId: branch.id } })).toBe(1);

        const completedItem = await testPrisma.importRunItem.findUniqueOrThrow({ where: { id: claimed.id } });
        expect(completedItem).toMatchObject({ status: "SUCCEEDED", payload: null });
        expect(completedItem.result).toMatchObject({ entityIds: [student.id], counts: { students: 1 } });

        const completedRun = await testPrisma.importRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(completedRun).toMatchObject({
            status: "COMPLETED",
            totalItems: 1,
            completedItems: 1,
            succeededItems: 1,
        });
        await expect(testPrisma.importSession.findUniqueOrThrow({ where: { id: session.id } }))
            .resolves.toMatchObject({ status: "COMMITTED" });
        await expect(testPrisma.importRow.findUniqueOrThrow({ where: { id: row.id } }))
            .resolves.toMatchObject({
                status: "IMPORTED",
                createdEntityIds: { studentId: student.id },
            });
    });
});
