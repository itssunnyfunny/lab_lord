ALTER TYPE "BillingChangeType"
  ADD VALUE IF NOT EXISTS 'COMMERCIAL_RECONCILIATION' AFTER 'CANCELLATION';

ALTER TABLE "OrganizationBillingChange"
  ADD COLUMN "commercialIntentVersion" INTEGER,
  ADD COLUMN "commercialIntentCapturedAt" TIMESTAMP(3),
  ADD COLUMN "authorizedProviderMode" "RazorpayMode",
  ADD COLUMN "authorizedRazorpaySubscriptionId" TEXT,
  ADD COLUMN "authorizedSourceRazorpayPlanId" TEXT,
  ADD COLUMN "authorizedRazorpayPlanId" TEXT,
  ADD COLUMN "authorizedPlan" "SaasPlan",
  ADD COLUMN "authorizedQuantity" INTEGER,
  ADD COLUMN "authorizedRazorpayOfferId" TEXT,
  ADD COLUMN "authorizedUnitAmountSubunits" INTEGER,
  ADD COLUMN "authorizedGrossAmountSubunits" INTEGER,
  ADD COLUMN "authorizedExpectedAmountSubunits" INTEGER,
  ADD COLUMN "authorizedOfferValidThroughPaidCount" INTEGER,
  ADD COLUMN "authorizedCurrency" TEXT,
  ADD COLUMN "authorizedPeriod" TEXT,
  ADD COLUMN "authorizedInterval" INTEGER;

ALTER TABLE "OrganizationSubscription"
  ADD COLUMN "confirmedCommercialIntentChangeId" TEXT;

ALTER TABLE "OrganizationSubscriptionInvoice"
  ADD COLUMN "commercialEvidenceVersion" INTEGER,
  ADD COLUMN "commercialIntentChangeId" TEXT,
  ADD COLUMN "providerMode" "RazorpayMode",
  ADD COLUMN "razorpaySubscriptionId" TEXT,
  ADD COLUMN "razorpayPlanId" TEXT,
  ADD COLUMN "providerQuantity" INTEGER,
  ADD COLUMN "razorpayOfferId" TEXT,
  ADD COLUMN "paymentAmountSubunits" INTEGER,
  ADD COLUMN "paymentCurrency" TEXT,
  ADD COLUMN "paymentStatus" TEXT,
  ADD COLUMN "paymentCaptured" BOOLEAN,
  ADD COLUMN "evidenceConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "evidenceFailureCode" TEXT;

CREATE UNIQUE INDEX "OrganizationSubscription_confirmedCommercialIntentChangeId_key"
  ON "OrganizationSubscription"("confirmedCommercialIntentChangeId");

CREATE INDEX "BillingChange_commercial_intent_idx"
  ON "OrganizationBillingChange"("organizationId", "commercialIntentVersion", "sequence");

CREATE INDEX "BillingChange_authorized_subscription_idx"
  ON "OrganizationBillingChange"(
    "authorizedProviderMode",
    "authorizedRazorpaySubscriptionId",
    "sequence"
  );

CREATE INDEX "SubscriptionInvoice_provider_period_idx"
  ON "OrganizationSubscriptionInvoice"("providerMode", "razorpaySubscriptionId", "periodEnd");

CREATE INDEX "SubscriptionInvoice_commercial_intent_idx"
  ON "OrganizationSubscriptionInvoice"("commercialIntentChangeId", "paidAt");

ALTER TABLE "OrganizationSubscription"
  ADD CONSTRAINT "OrganizationSubscription_confirmedCommercialIntentChangeId_fkey"
  FOREIGN KEY ("confirmedCommercialIntentChangeId") REFERENCES "OrganizationBillingChange"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrganizationSubscriptionInvoice"
  ADD CONSTRAINT "OrganizationSubscriptionInvoice_commercialIntentChangeId_fkey"
  FOREIGN KEY ("commercialIntentChangeId") REFERENCES "OrganizationBillingChange"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrganizationBillingChange"
  ADD CONSTRAINT "OrganizationBillingChange_commercial_intent_complete_check"
  CHECK (
    (
      "commercialIntentVersion" IS NULL
      AND "commercialIntentCapturedAt" IS NULL
      AND "authorizedProviderMode" IS NULL
      AND "authorizedRazorpaySubscriptionId" IS NULL
      AND "authorizedSourceRazorpayPlanId" IS NULL
      AND "authorizedRazorpayPlanId" IS NULL
      AND "authorizedPlan" IS NULL
      AND "authorizedQuantity" IS NULL
      AND "authorizedRazorpayOfferId" IS NULL
      AND "authorizedUnitAmountSubunits" IS NULL
      AND "authorizedGrossAmountSubunits" IS NULL
      AND "authorizedExpectedAmountSubunits" IS NULL
      AND "authorizedOfferValidThroughPaidCount" IS NULL
      AND "authorizedCurrency" IS NULL
      AND "authorizedPeriod" IS NULL
      AND "authorizedInterval" IS NULL
    )
    OR
    (
      "commercialIntentVersion" = 1
      AND "commercialIntentCapturedAt" IS NOT NULL
      AND "authorizedProviderMode" IS NOT NULL
      AND LENGTH(BTRIM("authorizedRazorpaySubscriptionId")) > 0
      AND LENGTH(BTRIM("authorizedRazorpayPlanId")) > 0
      AND "authorizedPlan" IS NOT NULL
      AND "authorizedQuantity" > 0
      AND "authorizedUnitAmountSubunits" > 0
      AND "authorizedGrossAmountSubunits" =
        ("authorizedUnitAmountSubunits"::BIGINT * "authorizedQuantity"::BIGINT)
      AND "authorizedGrossAmountSubunits" > 0
      AND "authorizedExpectedAmountSubunits" > 0
      AND "authorizedExpectedAmountSubunits" <= "authorizedGrossAmountSubunits"
      AND LENGTH(BTRIM("authorizedCurrency")) = 3
      AND "authorizedCurrency" = UPPER("authorizedCurrency")
      AND LENGTH(BTRIM("authorizedPeriod")) > 0
      AND "authorizedInterval" > 0
      AND ("toPlan" IS NULL OR "toPlan" = "authorizedPlan")
      AND ("toQuantity" IS NULL OR "toQuantity" = "authorizedQuantity")
      AND (
        (
          "authorizedRazorpayOfferId" IS NULL
          AND "authorizedOfferValidThroughPaidCount" IS NULL
          AND "authorizedExpectedAmountSubunits" = "authorizedGrossAmountSubunits"
        )
        OR
        (
          LENGTH(BTRIM("authorizedRazorpayOfferId")) > 0
          AND "authorizedOfferValidThroughPaidCount" > 0
          AND "authorizedExpectedAmountSubunits" < "authorizedGrossAmountSubunits"
        )
      )
    )
  );

ALTER TABLE "OrganizationSubscriptionInvoice"
  ADD CONSTRAINT "OrganizationSubscriptionInvoice_commercial_evidence_check"
  CHECK (
    (
      "commercialEvidenceVersion" IS NULL
      AND "evidenceConfirmedAt" IS NULL
    )
    OR
    (
      "commercialEvidenceVersion" = 1
      AND "commercialIntentChangeId" IS NOT NULL
      AND "providerMode" IS NOT NULL
      AND LENGTH(BTRIM("razorpaySubscriptionId")) > 0
      AND LENGTH(BTRIM("razorpayPlanId")) > 0
      AND "providerQuantity" > 0
      AND "paymentAmountSubunits" > 0
      AND LENGTH(BTRIM("paymentCurrency")) = 3
      AND "paymentCurrency" = UPPER("paymentCurrency")
      AND LOWER("paymentStatus") = 'captured'
      AND "paymentCaptured" = TRUE
      AND "evidenceConfirmedAt" IS NOT NULL
      AND "evidenceFailureCode" IS NULL
      AND LOWER("status") = 'paid'
      AND "amountDueSubunits" = 0
      AND "amountPaidSubunits" = "amountSubunits"
      AND "paymentAmountSubunits" = "amountSubunits"
      AND UPPER("currency") = "paymentCurrency"
      AND "periodStart" IS NOT NULL
      AND "periodEnd" IS NOT NULL
      AND "periodEnd" > "periodStart"
    )
  );
