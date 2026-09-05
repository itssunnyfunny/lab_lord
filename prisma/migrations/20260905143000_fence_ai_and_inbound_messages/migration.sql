BEGIN;
LOCK TABLE "MessageDraft" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "MessageDraft" WHERE "studentId" IS NOT NULL
    GROUP BY "branchId", "studentId", "action", "language" HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate logical message drafts require reviewed resolution before migration';
  END IF;
END $$;
CREATE UNIQUE INDEX "MessageDraft_branchId_studentId_action_language_key"
ON "MessageDraft"("branchId", "studentId", "action", "language");
CREATE TABLE "BranchGenerationLease" (
  "id" TEXT PRIMARY KEY, "branchId" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "token" TEXT, "leaseUntil" TIMESTAMP(3), "lastStartedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BranchGenerationLease_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BranchGenerationLease_branchId_kind_key" ON "BranchGenerationLease"("branchId", "kind");
CREATE TABLE "WhatsAppInboundMessageReceipt" (
  "id" TEXT PRIMARY KEY, "senderId" TEXT NOT NULL, "providerMessageId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsAppInboundMessageReceipt_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "WhatsAppSender"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WhatsAppInboundMessageReceipt_senderId_providerMessageId_key"
ON "WhatsAppInboundMessageReceipt"("senderId", "providerMessageId");
COMMIT;
