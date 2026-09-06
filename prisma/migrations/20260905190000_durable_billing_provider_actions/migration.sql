-- Drain billing workers and interactive billing before changing the dispatch protocol.
-- Existing operation/audit evidence is retained; no past dispatch is inferred or replayed.
BEGIN;
CREATE TABLE "BillingProviderAction" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "changeId" TEXT,
  "actionKey" TEXT NOT NULL, "providerMode" "RazorpayMode" NOT NULL,
  "purpose" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "request" JSONB NOT NULL,
  "status" TEXT NOT NULL, "dispatchToken" TEXT NOT NULL,
  "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedAt" TIMESTAMP(3), "response" JSONB, "failureKind" TEXT,
  CONSTRAINT "BillingProviderAction_status" CHECK ("status" IN ('ADMITTED','CONFIRMED','REJECTED','UNKNOWN','RECONCILED')),
  CONSTRAINT "BillingProviderAction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BillingProviderAction_changeId_organizationId_fkey" FOREIGN KEY ("changeId","organizationId") REFERENCES "OrganizationBillingChange"(id,"organizationId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BillingProviderAction_dispatchToken_key" ON "BillingProviderAction"("dispatchToken");
CREATE UNIQUE INDEX "BillingProviderAction_organizationId_actionKey_key" ON "BillingProviderAction"("organizationId","actionKey");
CREATE INDEX "BillingProviderAction_organizationId_status_idx" ON "BillingProviderAction"("organizationId","status");
CREATE INDEX "BillingProviderAction_changeId_idx" ON "BillingProviderAction"("changeId");
CREATE FUNCTION "protect_billing_provider_action_intent"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW."organizationId",NEW."changeId",NEW."actionKey",NEW."providerMode",NEW.purpose,NEW."requestHash",NEW.request)
    IS DISTINCT FROM ROW(OLD."organizationId",OLD."changeId",OLD."actionKey",OLD."providerMode",OLD.purpose,OLD."requestHash",OLD.request)
 THEN RAISE EXCEPTION 'Billing provider action intent is immutable'; END IF;
 IF NEW."dispatchToken"<>OLD."dispatchToken" AND NOT (OLD.status='REJECTED' AND NEW.status='ADMITTED')
 THEN RAISE EXCEPTION 'An admitted provider action cannot be taken over'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "BillingProviderAction_immutable_intent" BEFORE UPDATE ON "BillingProviderAction" FOR EACH ROW EXECUTE FUNCTION "protect_billing_provider_action_intent"();
COMMIT;
