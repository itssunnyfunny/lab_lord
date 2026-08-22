CREATE TYPE "PaymentResolutionEventSource" AS ENUM (
  'PAYMENT_ACTION',
  'STUDENT_INACTIVATION',
  'IMPORT_EXECUTION',
  'SYSTEM'
);

CREATE TABLE "PaymentResolutionEvent" (
  "id" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "source" "PaymentResolutionEventSource" NOT NULL,
  "fromStatus" "PaymentStatus" NOT NULL,
  "toStatus" "PaymentStatus" NOT NULL,
  "amount" INTEGER NOT NULL,
  "paymentType" "PaymentType" NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "dueDate" TIMESTAMP(3) NOT NULL,
  "paidAt" TIMESTAMP(3),
  "paymentMethod" "PaymentMethod",
  "referenceId" TEXT,
  "details" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaymentResolutionEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentResolutionEvent_paymentId_occurredAt_id_idx"
  ON "PaymentResolutionEvent"("paymentId", "occurredAt", "id");

CREATE INDEX "PaymentResolutionEvent_branchId_occurredAt_id_idx"
  ON "PaymentResolutionEvent"("branchId", "occurredAt", "id");

-- Establish the typed identity before removing the old cross-type constraint.
CREATE UNIQUE INDEX "Payment_studentId_type_periodStart_key"
  ON "Payment"("studentId", "type", "periodStart");

DROP INDEX "Payment_studentId_periodStart_key";

ALTER TABLE "PaymentResolutionEvent"
  ADD CONSTRAINT "PaymentResolutionEvent_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentResolutionEvent"
  ADD CONSTRAINT "PaymentResolutionEvent_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentResolutionEvent"
  ADD CONSTRAINT "PaymentResolutionEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
