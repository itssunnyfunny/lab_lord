import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ImportCommitService } from "@/importing/services/import-commit.service";
import { ImportPreviewService } from "@/importing/services/import-preview.service";
import { markManualNormalizedData } from "@/importing/pipeline/import-extraction.pipeline";
import { createSeat, createTestWorld } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

describe("Import commit flow integration", () => {
    afterAll(async () => { await disconnectDatabase(); });
    beforeEach(async () => { await resetDatabase(); });

    it("migrates a ready staged row into branch students, allocation, and payment records", async () => {
        const { user, branch } = await createTestWorld({
            shiftName: "Morning",
            shiftStart: "06:00",
            shiftEnd: "11:59",
            defaultFee: 1200,
        });
        await createSeat({ branchId: branch.id, label: "1" });

        const session = await testPrisma.importSession.create({
            data: {
                branchId: branch.id,
                uploadedByUserId: user.id,
                sourceType: "PASTED_TABLE",
                fileName: "ready-import.csv",
                fileMeta: {
                    columns: ["Student Name", "Phone", "Joined Date", "Monthly Fee", "Seat No", "Shift", "Payment Status"],
                    rowCount: 1,
                },
                mapping: {
                    entityTypesDetected: ["STUDENT", "ALLOCATION", "PAYMENT"],
                    columnMappings: [],
                    questions: [],
                    warnings: [],
                    importOptions: {
                        paymentCycle: "CURRENT_MONTH",
                        paymentAction: "IMPORT_PAID_UNPAID",
                        paymentMapping: {
                            paidValues: ["PAID"],
                            unpaidValues: ["DUE"],
                            waivedValues: [],
                            unclearValues: [],
                            confirmed: true,
                            defaultMethod: "CASH",
                        },
                    },
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
                    "Seat No": "1",
                    Shift: "Morning",
                    "Payment Status": "PAID",
                },
                mappedData: markManualNormalizedData({}),
                normalizedData: {
                    student: {
                        name: "Aarav Sharma",
                        phone: "9876501001",
                        joinedAt: "2026-01-05T00:00:00.000Z",
                        monthlyFee: 1200,
                    },
                    allocation: {
                        seatLabel: "1",
                        shiftName: "Morning",
                    },
                    payment: {
                        amount: 1200,
                        status: "PAID",
                        method: "UPI",
                        referenceId: "IMP-CLEAN-001",
                    },
                },
            },
        });

        const preview = await ImportPreviewService.getPreview(user.id, branch.id, session.id, "SAFE_PARTIAL");
        expect(preview.canCommit).toBe(true);
        expect(preview.summary.createStudents).toBe(1);
        expect(preview.summary.createAllocations).toBe(1);
        expect(preview.summary.generatePayments).toBe(1);
        expect(preview.summary.markPaid).toBe(1);

        const result = await ImportCommitService.commitSession(user.id, branch.id, session.id, "SAFE_PARTIAL", preview.planVersion);

        expect(result.status).toBe("SUCCESS");
        expect(result.summary.createdStudents).toBe(1);
        expect(result.summary.createdAllocations).toBe(1);
        expect(result.summary.generatedPayments).toBe(1);
        expect(result.summary.markedPaid).toBe(1);

        const student = await testPrisma.student.findFirstOrThrow({
            where: { branchId: branch.id, name: "Aarav Sharma" },
        });
        expect(student.phone).toBe("+91 98765 01001");

        const allocation = await testPrisma.seatAllocation.findFirstOrThrow({
            where: { studentId: student.id },
            include: { seat: true, shift: true },
        });
        expect(allocation.seat.label).toBe("1");
        expect(allocation.shift.name).toBe("Morning");

        const payment = await testPrisma.payment.findFirstOrThrow({
            where: { studentId: student.id },
        });
        expect(payment.amount).toBe(1200);
        expect(payment.status).toBe("PAID");
        expect(payment.paymentMethod).toBe("UPI");
        expect(payment.referenceId).toBe("IMP-CLEAN-001");

        const importedRow = await testPrisma.importRow.findUniqueOrThrow({
            where: { id: row.id },
        });
        expect(importedRow.status).toBe("IMPORTED");
        expect(importedRow.createdEntityIds).toMatchObject({
            studentId: student.id,
            paymentId: payment.id,
            allocationIds: [allocation.id],
        });

        const committedSession = await testPrisma.importSession.findUniqueOrThrow({
            where: { id: session.id },
        });
        expect(committedSession.status).toBe("COMMITTED");
    });
});
