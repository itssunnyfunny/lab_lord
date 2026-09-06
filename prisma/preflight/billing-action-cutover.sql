-- Read-only inventory. Run only against an explicitly approved target.
SELECT "billingModelVersion", COUNT(*) FROM "Organization" GROUP BY "billingModelVersion";
SELECT status,"operationStatus","failureCategory","failureCode", COUNT(*)
FROM "OrganizationBillingChange" WHERE "resolvedAt" IS NULL
GROUP BY status,"operationStatus","failureCategory","failureCode";
SELECT COUNT(*) AS owned_organizations FROM "Organization"
WHERE "billingMutationLeaseToken" IS NOT NULL OR "billingMutationLeaseUntil" IS NOT NULL;
SELECT "providerMode",status,COUNT(*) AS subscriptions,
 COUNT(*) FILTER (WHERE "currentOrganizationId" IS NOT NULL) AS current_slots,
 COUNT(*) FILTER (WHERE "pendingReplacementOrganizationId" IS NOT NULL) AS replacement_slots
FROM "OrganizationSubscription" GROUP BY "providerMode",status;
SELECT outcome,"failureCode",COUNT(*) FROM "OrganizationBillingChangeAudit"
WHERE outcome IN ('PROVIDER_MUTATION_ADMITTED','PROVIDER_STATE_ADOPTED','MANUAL_REVIEW_REQUIRED')
GROUP BY outcome,"failureCode";
-- After migration 46:
SELECT "providerMode",purpose,status,COUNT(*) FROM "BillingProviderAction"
GROUP BY "providerMode",purpose,status;
