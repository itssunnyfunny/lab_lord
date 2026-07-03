-- Add an optional billing baseline for imports that preserve historical joined dates.
ALTER TABLE "Student" ADD COLUMN "billingStartAt" TIMESTAMP(3);

CREATE INDEX "Student_branchId_billingStartAt_idx" ON "Student"("branchId", "billingStartAt");
