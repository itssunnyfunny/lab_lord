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

async function installFailureInjection() {
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

    it("atomically applies imported payment events and success markers, then safely replays them", async () => {
        const { user, branch } = await createTestWorld({ defaultFee: 1200 });
        const normalizedData = {
            student: {
                name: "Aarav Sharma",
                phone: "9876501001",
                joinedAt: "2026-06-05T00:00:00.000Z",
                monthlyFee: 1200,
            },
            payment: {
                amount: 1200,
                status: "PAID" as const,
                rawStatus: "paid",
                method: "UPI" as const,
                referenceId: "import_txn_1",
            },
        };
        const session = await testPrisma.importSession.create({
            data: {
                branchId: branch.id,
                uploadedByUserId: user.id,
                sourceType: "PASTED_TABLE",
                fileName: "ready-import.csv",
                engineVersion: 2,
                goal: "FULL",
                status: "READY_TO_COMMIT",
                draftRevision: 1,
                activeEvaluationRevision: 1,
                sourceConfiguration: { sourceType: "PASTED_TABLE" },
                fileMeta: { columns: ["Student Name", "Phone", "Joined Date", "Monthly Fee", "Payment Status"], rowCount: 1 },
                mapping: {
                    entityTypesDetected: ["STUDENT", "PAYMENT"],
                    columnMappings: [
                        { sourceColumn: "Student Name", targetField: "student.name", confidence: 100, source: "MANUAL" },
                        { sourceColumn: "Phone", targetField: "student.phone", confidence: 100, source: "MANUAL" },
                        { sourceColumn: "Joined Date", targetField: "student.joinedAt", confidence: 100, source: "MANUAL" },
                        { sourceColumn: "Monthly Fee", targetField: "student.monthlyFee", confidence: 100, source: "MANUAL" },
                        { sourceColumn: "Payment Status", targetField: "payment.status", confidence: 100, source: "MANUAL" },
                    ],
                    questions: [],
                    warnings: [],
                    importOptions: {
                        paymentCycle: "USE_JOINED_AT_ANNIVERSARY",
                        paymentAction: "IMPORT_PAID_UNPAID",
                        paymentHistoryMode: "START_CURRENT_JOINED_CYCLE",
                        paymentMapping: {
                            confirmed: true,
                            paidValues: ["paid"],
                            unpaidValues: ["due"],
                            waivedValues: [],
                            unclearValues: [],
                            defaultMethod: "CASH",
                        },
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
                    detectedEntityCounts: { STUDENT: 1, SEAT: 0, SHIFT: 0, ALLOCATION: 0, PAYMENT: 1 },
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
                    "Joined Date": "2026-06-05",
                    "Monthly Fee": "1200",
                    "Payment Status": "paid",
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

        const [studentItem] = await ImportRunRunner.claimBatch({
            importRunId: run.id,
            workerId: "integration-worker-0",
            limit: 25,
        });
        expect(studentItem).toMatchObject({ kind: "STUDENT", attemptCount: 1 });

        await installFailureInjection();

        await expect(ImportRunExecutor.executeClaimedItem(studentItem))
            .rejects.toThrow("injected failure before durable completion marker");
        expect(await testPrisma.student.count({ where: { branchId: branch.id } })).toBe(0);
        await expect(testPrisma.importRunItem.findUniqueOrThrow({ where: { id: studentItem.id } }))
            .resolves.toMatchObject({ status: "RUNNING", attemptCount: 1 });

        await removeFailureInjection();
        await expect(ImportRunExecutor.executeClaimedItem(studentItem))
            .resolves.toEqual({ alreadyCompleted: false });
        await expect(ImportRunExecutor.executeClaimedItem(studentItem))
            .resolves.toEqual({ alreadyCompleted: true });

        const student = await testPrisma.student.findFirstOrThrow({
            where: { branchId: branch.id, name: "Aarav Sharma" },
        });
        expect(student.phone).toBe("+91 98765 01001");
        expect(await testPrisma.student.count({ where: { branchId: branch.id } })).toBe(1);

        const completedStudentItem = await testPrisma.importRunItem.findUniqueOrThrow({ where: { id: studentItem.id } });
        expect(completedStudentItem).toMatchObject({ status: "SUCCEEDED", payload: null });
        expect(completedStudentItem.result).toMatchObject({ entityIds: [student.id], counts: { students: 1 } });

        const [paymentItem] = await ImportRunRunner.claimBatch({
            importRunId: run.id,
            workerId: "integration-worker-1",
            limit: 25,
        });
        expect(paymentItem).toMatchObject({ kind: "PAYMENT_CYCLE", attemptCount: 1 });

        await installFailureInjection();
        await expect(ImportRunExecutor.executeClaimedItem(paymentItem))
            .rejects.toThrow("injected failure before durable completion marker");

        expect(await testPrisma.payment.count({ where: { branchId: branch.id } })).toBe(0);
        expect(await testPrisma.paymentResolutionEvent.count({ where: { branchId: branch.id } })).toBe(0);
        expect(await testPrisma.auditLog.count({
            where: { branchId: branch.id, action: "PAYMENT_MARKED_PAID" },
        })).toBe(0);
        await expect(testPrisma.importRunItem.findUniqueOrThrow({ where: { id: paymentItem.id } }))
            .resolves.toMatchObject({ status: "RUNNING", attemptCount: 1 });

        await removeFailureInjection();
        await expect(ImportRunExecutor.executeClaimedItem(paymentItem))
            .resolves.toEqual({ alreadyCompleted: false });
        await expect(ImportRunExecutor.executeClaimedItem(paymentItem))
            .resolves.toEqual({ alreadyCompleted: true });

        const payment = await testPrisma.payment.findFirstOrThrow({
            where: { branchId: branch.id, studentId: student.id, type: "MONTHLY" },
        });
        expect(payment).toMatchObject({
            amount: 1200,
            status: "PAID",
            paymentMethod: "UPI",
            referenceId: "import_txn_1",
        });
        expect(await testPrisma.payment.count({ where: { branchId: branch.id } })).toBe(1);
        expect(await testPrisma.auditLog.count({
            where: { paymentId: payment.id, action: "PAYMENT_MARKED_PAID" },
        })).toBe(1);

        const [resolutionEvent] = await testPrisma.paymentResolutionEvent.findMany({
            where: { paymentId: payment.id },
            orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        });
        expect(resolutionEvent).toMatchObject({
            paymentId: payment.id,
            branchId: branch.id,
            actorUserId: user.id,
            source: "IMPORT_EXECUTION",
            fromStatus: "DUE",
            toStatus: "PAID",
            amount: 1200,
            paymentType: "MONTHLY",
            periodStart: payment.periodStart,
            dueDate: payment.dueDate,
            paidAt: payment.paidAt,
            paymentMethod: "UPI",
            referenceId: "import_txn_1",
        });
        expect(await testPrisma.paymentResolutionEvent.count({ where: { paymentId: payment.id } })).toBe(1);

        const completedPaymentItem = await testPrisma.importRunItem.findUniqueOrThrow({ where: { id: paymentItem.id } });
        expect(completedPaymentItem).toMatchObject({ status: "SUCCEEDED", payload: null });
        expect(completedPaymentItem.result).toMatchObject({ entityIds: [payment.id], counts: { payments: 1, paid: 1 } });

        const completedRun = await testPrisma.importRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(completedRun).toMatchObject({
            status: "COMPLETED",
            totalItems: 2,
            completedItems: 2,
            succeededItems: 2,
        });
        await expect(testPrisma.importSession.findUniqueOrThrow({ where: { id: session.id } }))
            .resolves.toMatchObject({ status: "COMMITTED" });
        await expect(testPrisma.importRow.findUniqueOrThrow({ where: { id: row.id } }))
            .resolves.toMatchObject({
                status: "IMPORTED",
                createdEntityIds: { studentId: student.id, paymentIds: [payment.id] },
            });
    });
});
