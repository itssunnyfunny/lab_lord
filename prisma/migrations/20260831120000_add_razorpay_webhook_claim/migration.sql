-- Add an expiring, token-fenced processing claim to the durable Razorpay
-- receipt. Existing completed rows remain complete; existing unprocessed rows
-- start unclaimed and can be claimed by the new application after deployment.
ALTER TABLE "RazorpayWebhookEvent"
  ADD COLUMN "processingToken" TEXT,
  ADD COLUMN "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN "processingLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "RazorpayWebhookEvent_processingToken_key"
  ON "RazorpayWebhookEvent"("processingToken");

CREATE INDEX "RazorpayWebhookEvent_processedAt_processingLeaseUntil_idx"
  ON "RazorpayWebhookEvent"("processedAt", "processingLeaseUntil");
