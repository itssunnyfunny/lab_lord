CREATE TYPE "ImportGoal" AS ENUM ('STUDENTS', 'STUDENTS_ALLOCATIONS', 'FULL');
CREATE TYPE "ImportReadinessPolicy" AS ENUM ('READY_ROWS_ONLY', 'REQUIRE_ALL_ROWS_READY');
CREATE TYPE "ImportRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_FOR_USER', 'COMPLETED', 'COMPLETED_WITH_ISSUES', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'CANCEL_REQUESTED', 'CANCELLED', 'SUPERSEDED');
CREATE TYPE "ImportRunKind" AS ENUM ('ANALYSIS', 'COMMIT');
CREATE TYPE "ImportRunItemKind" AS ENUM ('CONFIG', 'STUDENT', 'ALLOCATION', 'PAYMENT_CYCLE');
CREATE TYPE "ImportRunItemStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED');

ALTER TABLE "ImportSession"
  ADD COLUMN "engineVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "goal" "ImportGoal",
  ADD COLUMN "sourceConfiguration" JSONB,
  ADD COLUMN "draftRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "activeEvaluationRevision" INTEGER,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "purgeAfter" TIMESTAMP(3);

-- Terminal V1 sessions remain visible as historical evidence. Unfinished V1
-- sessions are archived in place so a V2 worker cannot resume mutable legacy
-- state, then scheduled for the approved 30-day staging purge window.
UPDATE "ImportSession"
SET "archivedAt" = CURRENT_TIMESTAMP,
    "purgeAfter" = CURRENT_TIMESTAMP + INTERVAL '30 days'
WHERE "engineVersion" = 1
  AND "status" NOT IN ('COMMITTED', 'PARTIAL', 'FAILED', 'CANCELLED');

CREATE TABLE "ImportRowEvaluation" (
  "id" TEXT NOT NULL,
  "importRowId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "engineVersion" INTEGER NOT NULL,
  "status" "ImportRowStatus" NOT NULL,
  "mappedData" JSONB,
  "normalizedData" JSONB,
  "issues" JSONB NOT NULL,
  "warnings" JSONB NOT NULL,
  "confidence" INTEGER,
  "skipped" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ImportRowEvaluation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportRowEvaluation_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "ImportRowEvaluation_engineVersion_check" CHECK ("engineVersion" >= 1),
  CONSTRAINT "ImportRowEvaluation_confidence_check" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 100))
);

CREATE TABLE "ImportPlan" (
  "id" TEXT NOT NULL,
  "importSessionId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "engineVersion" INTEGER NOT NULL,
  "goal" "ImportGoal" NOT NULL,
  "readinessPolicy" "ImportReadinessPolicy" NOT NULL,
  "planVersion" TEXT NOT NULL,
  "canRun" BOOLEAN NOT NULL,
  "totalRows" INTEGER NOT NULL,
  "readyRows" INTEGER NOT NULL,
  "blockedRows" INTEGER NOT NULL,
  "warningRows" INTEGER NOT NULL,
  "skippedRows" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "checks" JSONB NOT NULL,
  "summary" JSONB NOT NULL,
  "compiledByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ImportPlan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportPlan_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "ImportPlan_engineVersion_check" CHECK ("engineVersion" >= 1),
  CONSTRAINT "ImportPlan_counts_check" CHECK (
    "totalRows" >= 0
    AND "readyRows" >= 0
    AND "blockedRows" >= 0
    AND "warningRows" >= 0
    AND "skippedRows" >= 0
    AND "warningRows" <= "readyRows"
    AND "totalRows" = "readyRows" + "blockedRows" + "skippedRows"
  )
);

CREATE TABLE "ImportRun" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "importSessionId" TEXT,
  "importPlanId" TEXT,
  "targetRevision" INTEGER NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "workflowRunId" TEXT,
  "kind" "ImportRunKind" NOT NULL,
  "status" "ImportRunStatus" NOT NULL DEFAULT 'QUEUED',
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "totalItems" INTEGER NOT NULL,
  "completedItems" INTEGER NOT NULL DEFAULT 0,
  "succeededItems" INTEGER NOT NULL DEFAULT 0,
  "failedItems" INTEGER NOT NULL DEFAULT 0,
  "skippedItems" INTEGER NOT NULL DEFAULT 0,
  "cancelledItems" INTEGER NOT NULL DEFAULT 0,
  "cancelRequestedAt" TIMESTAMP(3),
  "cancelRequestedByUserId" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "lastHeartbeatAt" TIMESTAMP(3),
  "error" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportRun_targetRevision_check" CHECK ("targetRevision" >= 0),
  CONSTRAINT "ImportRun_attempts_check" CHECK ("maxAttempts" >= 1 AND "maxAttempts" <= 100),
  CONSTRAINT "ImportRun_progress_check" CHECK (
    "totalItems" >= 0
    AND "completedItems" >= 0
    AND "succeededItems" >= 0
    AND "failedItems" >= 0
    AND "skippedItems" >= 0
    AND "cancelledItems" >= 0
    AND "completedItems" = "succeededItems" + "failedItems" + "skippedItems" + "cancelledItems"
    AND "completedItems" <= "totalItems"
  )
);

CREATE TABLE "ImportRunItem" (
  "id" TEXT NOT NULL,
  "importRunId" TEXT NOT NULL,
  "importRowId" TEXT,
  "evaluationId" TEXT,
  "ordinal" INTEGER NOT NULL,
  "itemKey" TEXT NOT NULL,
  "kind" "ImportRunItemKind" NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" "ImportRunItemStatus" NOT NULL DEFAULT 'QUEUED',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastHeartbeatAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "payload" JSONB,
  "result" JSONB,
  "error" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ImportRunItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportRunItem_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "ImportRunItem_attemptCount_check" CHECK ("attemptCount" >= 0)
);

CREATE TABLE "ImportRecipe" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "engineVersion" INTEGER NOT NULL,
  "goal" "ImportGoal" NOT NULL,
  "sourceType" "ImportSourceType" NOT NULL,
  "normalizedHeaderSignature" TEXT NOT NULL,
  "entityTypes" JSONB NOT NULL,
  "columnMappings" JSONB NOT NULL,
  "useCount" INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ImportRecipe_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportRecipe_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "ImportRecipe_schemaVersion_check" CHECK ("schemaVersion" >= 1),
  CONSTRAINT "ImportRecipe_engineVersion_check" CHECK ("engineVersion" >= 1),
  CONSTRAINT "ImportRecipe_useCount_check" CHECK ("useCount" >= 0)
);

CREATE UNIQUE INDEX "ImportRowEvaluation_importRowId_revision_key" ON "ImportRowEvaluation"("importRowId", "revision");
CREATE INDEX "ImportRowEvaluation_revision_status_idx" ON "ImportRowEvaluation"("revision", "status");

CREATE UNIQUE INDEX "ImportPlan_planVersion_key" ON "ImportPlan"("planVersion");
CREATE UNIQUE INDEX "ImportPlan_importSessionId_revision_readinessPolicy_key" ON "ImportPlan"("importSessionId", "revision", "readinessPolicy");
CREATE INDEX "ImportPlan_importSessionId_createdAt_idx" ON "ImportPlan"("importSessionId", "createdAt");

CREATE UNIQUE INDEX "ImportRun_idempotencyKey_key" ON "ImportRun"("idempotencyKey");
CREATE UNIQUE INDEX "ImportRun_workflowRunId_key" ON "ImportRun"("workflowRunId");
CREATE INDEX "ImportRun_importSessionId_kind_createdAt_idx" ON "ImportRun"("importSessionId", "kind", "createdAt");
CREATE INDEX "ImportRun_branchId_createdAt_idx" ON "ImportRun"("branchId", "createdAt");
CREATE INDEX "ImportRun_status_createdAt_idx" ON "ImportRun"("status", "createdAt");
CREATE UNIQUE INDEX "ImportRun_active_session_key"
  ON "ImportRun"("importSessionId")
  WHERE "importSessionId" IS NOT NULL
    AND "status" IN ('QUEUED', 'RUNNING', 'WAITING_FOR_USER', 'RETRYABLE_FAILURE', 'CANCEL_REQUESTED');

CREATE UNIQUE INDEX "ImportRunItem_idempotencyKey_key" ON "ImportRunItem"("idempotencyKey");
CREATE UNIQUE INDEX "ImportRunItem_leaseToken_key" ON "ImportRunItem"("leaseToken");
CREATE UNIQUE INDEX "ImportRunItem_importRunId_itemKey_key" ON "ImportRunItem"("importRunId", "itemKey");
CREATE UNIQUE INDEX "ImportRunItem_importRunId_ordinal_key" ON "ImportRunItem"("importRunId", "ordinal");
CREATE INDEX "ImportRunItem_importRunId_status_availableAt_idx" ON "ImportRunItem"("importRunId", "status", "availableAt");
CREATE INDEX "ImportRunItem_status_leaseExpiresAt_idx" ON "ImportRunItem"("status", "leaseExpiresAt");

CREATE UNIQUE INDEX "ImportRecipe_organizationId_name_revision_key" ON "ImportRecipe"("organizationId", "name", "revision");
CREATE INDEX "ImportRecipe_organizationId_goal_archivedAt_idx" ON "ImportRecipe"("organizationId", "goal", "archivedAt");
CREATE INDEX "ImportRecipe_organizationId_sourceType_normalizedHeaderSignature_idx" ON "ImportRecipe"("organizationId", "sourceType", "normalizedHeaderSignature");
CREATE INDEX "ImportRecipe_branchId_archivedAt_idx" ON "ImportRecipe"("branchId", "archivedAt");

CREATE INDEX "ImportSession_branchId_archivedAt_createdAt_idx" ON "ImportSession"("branchId", "archivedAt", "createdAt");
CREATE INDEX "ImportSession_purgeAfter_idx" ON "ImportSession"("purgeAfter");

ALTER TABLE "ImportSession"
  ADD CONSTRAINT "ImportSession_revisions_check"
  CHECK (
    "draftRevision" >= 0
    AND ("activeEvaluationRevision" IS NULL OR (
      "activeEvaluationRevision" >= 0
      AND "activeEvaluationRevision" <= "draftRevision"
    ))
  );

ALTER TABLE "ImportRowEvaluation"
  ADD CONSTRAINT "ImportRowEvaluation_importRowId_fkey"
  FOREIGN KEY ("importRowId") REFERENCES "ImportRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ImportPlan"
  ADD CONSTRAINT "ImportPlan_importSessionId_fkey"
  FOREIGN KEY ("importSessionId") REFERENCES "ImportSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportPlan"
  ADD CONSTRAINT "ImportPlan_compiledByUserId_fkey"
  FOREIGN KEY ("compiledByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ImportRun"
  ADD CONSTRAINT "ImportRun_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportRun"
  ADD CONSTRAINT "ImportRun_importSessionId_fkey"
  FOREIGN KEY ("importSessionId") REFERENCES "ImportSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportRun"
  ADD CONSTRAINT "ImportRun_importPlanId_fkey"
  FOREIGN KEY ("importPlanId") REFERENCES "ImportPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportRun"
  ADD CONSTRAINT "ImportRun_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportRun"
  ADD CONSTRAINT "ImportRun_cancelRequestedByUserId_fkey"
  FOREIGN KEY ("cancelRequestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ImportRunItem"
  ADD CONSTRAINT "ImportRunItem_importRunId_fkey"
  FOREIGN KEY ("importRunId") REFERENCES "ImportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportRunItem"
  ADD CONSTRAINT "ImportRunItem_importRowId_fkey"
  FOREIGN KEY ("importRowId") REFERENCES "ImportRow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportRunItem"
  ADD CONSTRAINT "ImportRunItem_evaluationId_fkey"
  FOREIGN KEY ("evaluationId") REFERENCES "ImportRowEvaluation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ImportRecipe"
  ADD CONSTRAINT "ImportRecipe_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportRecipe"
  ADD CONSTRAINT "ImportRecipe_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportRecipe"
  ADD CONSTRAINT "ImportRecipe_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "reject_import_snapshot_update"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; create a new revision instead', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "ImportRowEvaluation_immutable"
BEFORE UPDATE ON "ImportRowEvaluation"
FOR EACH ROW EXECUTE FUNCTION "reject_import_snapshot_update"();

CREATE TRIGGER "ImportPlan_immutable"
BEFORE UPDATE ON "ImportPlan"
FOR EACH ROW EXECUTE FUNCTION "reject_import_snapshot_update"();
