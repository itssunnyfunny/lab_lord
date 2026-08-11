UPDATE "OrganizationSubscription"
SET "currentOrganizationId" = "organizationId"
WHERE "currentOrganizationId" IS NULL
  AND "pendingReplacementOrganizationId" IS NULL
  AND "replacesSubscriptionId" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "OrganizationSubscription"
    WHERE "currentOrganizationId" IS NULL
       OR "currentOrganizationId" <> "organizationId"
       OR "pendingReplacementOrganizationId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'OrganizationSubscription current-slot cutover preflight failed';
  END IF;
END
$$;

DROP INDEX "OrganizationSubscription_organizationId_key";
