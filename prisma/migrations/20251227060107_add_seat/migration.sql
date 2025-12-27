-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Seat_branchId_idx" ON "Seat"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_branchId_label_key" ON "Seat"("branchId", "label");

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
