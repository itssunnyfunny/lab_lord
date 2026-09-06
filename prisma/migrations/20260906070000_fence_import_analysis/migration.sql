-- Drain old analysis workers before applying: old code has no token predicates.
ALTER TABLE "ImportSession" ADD COLUMN "analysisLeaseToken" TEXT,
  ADD COLUMN "analysisLeaseUntil" TIMESTAMP(3);
CREATE UNIQUE INDEX "ImportSession_analysisLeaseToken_key" ON "ImportSession"("analysisLeaseToken");
ALTER TABLE "ImportSession" ADD CONSTRAINT "ImportSession_analysis_lease_pair"
  CHECK (("analysisLeaseToken" IS NULL) = ("analysisLeaseUntil" IS NULL));
-- Existing ANALYZING rows remain intact. After the writer drain, their null
-- tokens permit one new owner to recover the existing revision.
