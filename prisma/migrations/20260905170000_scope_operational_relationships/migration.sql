BEGIN;
LOCK TABLE "Student", "Shift", "MultiShift", "MultiShiftComponent", "Payment",
  "PaymentResolutionEvent", "AuditLog", "MessageDraft" IN SHARE ROW EXCLUSIVE MODE;

DO $$ DECLARE n bigint; BEGIN
  SELECT SUM(bad) INTO n FROM (
    SELECT COUNT(*) bad FROM "Payment" c WHERE NOT EXISTS
      (SELECT 1 FROM "Student" p WHERE p.id=c."studentId" AND p."branchId"=c."branchId")
    UNION ALL SELECT COUNT(*) FROM "PaymentResolutionEvent" c WHERE NOT EXISTS
      (SELECT 1 FROM "Payment" p WHERE p.id=c."paymentId" AND p."branchId"=c."branchId")
    UNION ALL SELECT COUNT(*) FROM "AuditLog" c WHERE NOT EXISTS
      (SELECT 1 FROM "Payment" p WHERE p.id=c."paymentId" AND p."branchId"=c."branchId")
    UNION ALL SELECT COUNT(*) FROM "MessageDraft" c WHERE c."studentId" IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM "Student" p WHERE p.id=c."studentId" AND p."branchId"=c."branchId")
    UNION ALL SELECT COUNT(*) FROM "Student" c WHERE c."feeLinkedShiftId" IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM "Shift" p WHERE p.id=c."feeLinkedShiftId" AND p."branchId"=c."branchId")
    UNION ALL SELECT COUNT(*) FROM "Student" c WHERE c."feeLinkedMultiShiftId" IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM "MultiShift" p WHERE p.id=c."feeLinkedMultiShiftId" AND p."branchId"=c."branchId")
    UNION ALL SELECT COUNT(*) FROM "MultiShiftComponent" c WHERE NOT EXISTS
      (SELECT 1 FROM "MultiShift" m JOIN "Shift" s ON s."branchId"=m."branchId"
       WHERE m.id=c."multiShiftId" AND s.id=c."shiftId")
  ) counts;
  IF n > 0 THEN RAISE EXCEPTION 'Operational tenant migration blocked: % inconsistent references require reviewed repair', n; END IF;
END $$;

ALTER TABLE "MultiShiftComponent" ADD COLUMN "branchId" TEXT;
UPDATE "MultiShiftComponent" c SET "branchId"=p."branchId" FROM "MultiShift" p WHERE p.id=c."multiShiftId";
ALTER TABLE "MultiShiftComponent" ALTER COLUMN "branchId" SET NOT NULL;
CREATE INDEX "MultiShiftComponent_branchId_shiftId_idx" ON "MultiShiftComponent"("branchId", "shiftId");
CREATE UNIQUE INDEX "Payment_id_branchId_key" ON "Payment"("id", "branchId");

ALTER TABLE "MultiShiftComponent" DROP CONSTRAINT "MultiShiftComponent_multiShiftId_fkey",
  DROP CONSTRAINT "MultiShiftComponent_shiftId_fkey",
  ADD CONSTRAINT "MultiShiftComponent_multiShiftId_branchId_fkey" FOREIGN KEY ("multiShiftId", "branchId") REFERENCES "MultiShift"("id", "branchId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MultiShiftComponent_shiftId_branchId_fkey" FOREIGN KEY ("shiftId", "branchId") REFERENCES "Shift"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Student"
  ADD CONSTRAINT "Student_feeLinkedShiftId_branchId_fkey" FOREIGN KEY ("feeLinkedShiftId", "branchId") REFERENCES "Shift"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Student_feeLinkedMultiShiftId_branchId_fkey" FOREIGN KEY ("feeLinkedMultiShiftId", "branchId") REFERENCES "MultiShift"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_studentId_fkey",
  ADD CONSTRAINT "Payment_studentId_branchId_fkey" FOREIGN KEY ("studentId", "branchId") REFERENCES "Student"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentResolutionEvent" DROP CONSTRAINT "PaymentResolutionEvent_paymentId_fkey",
  ADD CONSTRAINT "PaymentResolutionEvent_paymentId_branchId_fkey" FOREIGN KEY ("paymentId", "branchId") REFERENCES "Payment"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_paymentId_branchId_fkey" FOREIGN KEY ("paymentId", "branchId") REFERENCES "Payment"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessageDraft" DROP CONSTRAINT "MessageDraft_studentId_fkey",
  ADD CONSTRAINT "MessageDraft_studentId_branchId_fkey" FOREIGN KEY ("studentId", "branchId") REFERENCES "Student"("id", "branchId") ON DELETE SET NULL ("studentId") ON UPDATE CASCADE;
COMMIT;
