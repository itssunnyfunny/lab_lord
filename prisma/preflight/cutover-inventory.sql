-- psql, read-only. Run only on an explicitly approved target; save output to an
-- access-controlled operator artifact, never public logs or an issue body.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- Exact row counts for every existing table; safe before and after new migrations.
SELECT string_agg(format('SELECT %L AS table_name, count(*) AS row_count FROM %I.%I',
  tablename, schemaname, tablename), ' UNION ALL ' ORDER BY tablename)
FROM pg_tables WHERE schemaname='public'
\gexec
SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
FROM "_prisma_migrations" ORDER BY started_at;
SELECT "billingModelVersion", COUNT(*) FROM "Organization" GROUP BY "billingModelVersion";
SELECT "id", "organizationId", "providerMode", status, "razorpaySubscriptionId",
 "currentOrganizationId", "pendingReplacementOrganizationId", "replacesSubscriptionId"
FROM "OrganizationSubscription" ORDER BY "organizationId", "id";
SELECT "id", "organizationId", status, "operationStatus", "organizationSubscriptionId",
 "replacementSubscriptionId", "failureCode" FROM "OrganizationBillingChange"
WHERE "resolvedAt" IS NULL ORDER BY "organizationId", sequence;
SELECT "id", "branchId", kind, status, "targetRevision", "workflowRunId"
FROM "ImportRun" WHERE status IN ('QUEUED','RUNNING','RETRYABLE_FAILURE','CANCEL_REQUESTED');
SELECT "id", "branchId", status, "draftRevision" FROM "ImportSession" WHERE status='ANALYZING';
SELECT "id", "organizationId", "branchId", "senderId", status, "providerMessageId"
FROM "WhatsAppMessage" WHERE status IN ('CLAIMED','SUBMITTING','UNKNOWN');
SELECT "providerMode", status, COUNT(*) FROM "WhatsAppWebhookReceipt" GROUP BY "providerMode", status;
SELECT s."providerMode", COUNT(*) FROM "RazorpayWebhookEvent" e LEFT JOIN "OrganizationSubscription" s ON s.id=e."organizationSubscriptionId" WHERE e."processedAt" IS NULL GROUP BY s."providerMode";
SELECT COUNT(*) AS required_database_identities FROM "BillingDatabaseIdentity";
COMMIT;
