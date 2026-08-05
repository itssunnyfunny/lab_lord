-- Persist the owner's selected post-trial plan without creating or activating
-- a provider subscription. Existing qualifying subscriptions are used as the
-- initial selection so deployed workspaces retain their current intent.
ALTER TABLE "Organization"
ADD COLUMN "selectedPostTrialPlan" "SaasPlan";

UPDATE "Organization" AS organization
SET "selectedPostTrialPlan" = subscription."plan"
FROM "OrganizationSubscription" AS subscription
WHERE subscription."organizationId" = organization."id"
  AND subscription."plan" IN ('BASIC'::"SaasPlan", 'PRO'::"SaasPlan");
