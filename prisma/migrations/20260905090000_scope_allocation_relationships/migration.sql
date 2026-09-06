BEGIN;

-- Prevent concurrent writes between preflight, backfill, and constraint install.
-- Release requires draining old application writers: branchId is required.
LOCK TABLE "MultiShift", "Seat", "SeatAllocation", "Shift", "Student"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE inconsistent_count bigint;
BEGIN
  SELECT count(*) INTO inconsistent_count
  FROM "SeatAllocation" a
  LEFT JOIN "Seat" se ON se.id = a."seatId"
  LEFT JOIN "Student" st ON st.id = a."studentId"
  LEFT JOIN "Shift" sh ON sh.id = a."shiftId"
  LEFT JOIN "MultiShift" ms ON ms.id = a."multiShiftId"
  WHERE se.id IS NULL OR st.id IS NULL OR sh.id IS NULL
    OR se."branchId" IS DISTINCT FROM st."branchId"
    OR se."branchId" IS DISTINCT FROM sh."branchId"
    OR (a."multiShiftId" IS NOT NULL
      AND (ms.id IS NULL OR se."branchId" IS DISTINCT FROM ms."branchId"));
  IF inconsistent_count > 0 THEN
    RAISE EXCEPTION 'Allocation tenant migration blocked: % inconsistent rows require reviewed repair', inconsistent_count;
  END IF;
END $$;

ALTER TABLE "SeatAllocation" ADD COLUMN "branchId" TEXT;
UPDATE "SeatAllocation" a SET "branchId" = se."branchId"
  FROM "Seat" se WHERE se.id = a."seatId";
ALTER TABLE "SeatAllocation" ALTER COLUMN "branchId" SET NOT NULL;

CREATE UNIQUE INDEX "Student_id_branchId_key" ON "Student"("id", "branchId");
CREATE UNIQUE INDEX "Seat_id_branchId_key" ON "Seat"("id", "branchId");
CREATE UNIQUE INDEX "Shift_id_branchId_key" ON "Shift"("id", "branchId");
CREATE UNIQUE INDEX "MultiShift_id_branchId_key" ON "MultiShift"("id", "branchId");
CREATE INDEX "SeatAllocation_branchId_shiftId_endDate_idx" ON "SeatAllocation"("branchId", "shiftId", "endDate");

ALTER TABLE "SeatAllocation"
  DROP CONSTRAINT "SeatAllocation_seatId_fkey",
  DROP CONSTRAINT "SeatAllocation_studentId_fkey",
  DROP CONSTRAINT "SeatAllocation_shiftId_fkey",
  DROP CONSTRAINT "SeatAllocation_multiShiftId_fkey",
  ADD CONSTRAINT "SeatAllocation_seatId_branchId_fkey"
    FOREIGN KEY ("seatId", "branchId") REFERENCES "Seat"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SeatAllocation_studentId_branchId_fkey"
    FOREIGN KEY ("studentId", "branchId") REFERENCES "Student"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SeatAllocation_shiftId_branchId_fkey"
    FOREIGN KEY ("shiftId", "branchId") REFERENCES "Shift"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SeatAllocation_multiShiftId_branchId_fkey"
    FOREIGN KEY ("multiShiftId", "branchId") REFERENCES "MultiShift"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
