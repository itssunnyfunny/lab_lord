BEGIN;
LOCK TABLE "Branch", "BranchWhatsAppSettings", "ImportRecipe", "OrganizationBillingChange", "OrganizationBillingChangeAudit", "OrganizationSubscription", "OrganizationSubscriptionHistory", "OrganizationSubscriptionInvoice", "OrganizationWhatsAppReportSettings", "Payment", "PaymentResolutionEvent", "RazorpayWebhookEvent", "Student", "WhatsAppAuditEvent", "WhatsAppAutomationRule", "WhatsAppConsent", "WhatsAppConsentEvent", "WhatsAppDailyReportSnapshot", "WhatsAppManagedTemplateProvisioning", "WhatsAppManualSendRequest", "WhatsAppMessage", "WhatsAppMessageEvent", "WhatsAppOperationalIncident", "WhatsAppReportSubscription", "WhatsAppSender", "WhatsAppServiceNotice", "WhatsAppStudentRecipient", "WhatsAppTemplate", "WhatsAppTemplateBinding", "WhatsAppWebhookReceipt" IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE n bigint; BEGIN
 SELECT SUM(inconsistent_references) INTO n FROM (
SELECT 'TI_BranchWhatsAppSettings_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "BranchWhatsAppSettings" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_BranchWhatsAppSettings_sender_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "BranchWhatsAppSettings" c WHERE c."senderId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppSender" p WHERE p.id=c."senderId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppConsentEvent_consent_senderId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppConsentEvent" c WHERE c."consentId" IS NOT NULL AND c."senderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppConsent" p WHERE p.id=c."consentId" AND p."senderId"=c."senderId")
UNION ALL
SELECT 'TI_WhatsAppStudentRecipient_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppStudentRecipient" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppStudentRecipient_student_branchId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppStudentRecipient" c WHERE c."studentId" IS NOT NULL AND c."branchId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Student" p WHERE p.id=c."studentId" AND p."branchId"=c."branchId")
UNION ALL
SELECT 'TI_WhatsAppStudentRecipient_sender_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppStudentRecipient" c WHERE c."senderId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppSender" p WHERE p.id=c."senderId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppStudentRecipient_consent_senderId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppStudentRecipient" c WHERE c."consentId" IS NOT NULL AND c."senderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppConsent" p WHERE p.id=c."consentId" AND p."senderId"=c."senderId")
UNION ALL
SELECT 'TI_WhatsAppTemplateBinding_template_senderId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppTemplateBinding" c WHERE c."templateId" IS NOT NULL AND c."senderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppTemplate" p WHERE p.id=c."templateId" AND p."senderId"=c."senderId")
UNION ALL
SELECT 'TI_WhatsAppTemplateBinding_provisioning_senderId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppTemplateBinding" c WHERE c."provisioningId" IS NOT NULL AND c."senderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppManagedTemplateProvisioning" p WHERE p.id=c."provisioningId" AND p."senderId"=c."senderId")
UNION ALL
SELECT 'TI_WhatsAppAutomationRule_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppAutomationRule" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppManualSendRequest_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppManualSendRequest" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppReportSubscription_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppReportSubscription" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppReportSubscription_sender_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppReportSubscription" c WHERE c."senderId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppSender" p WHERE p.id=c."senderId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppReportSubscription_consent_senderId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppReportSubscription" c WHERE c."consentId" IS NOT NULL AND c."senderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppConsent" p WHERE p.id=c."consentId" AND p."senderId"=c."senderId")
UNION ALL
SELECT 'TI_OrganizationWhatsAppReportSettings_sender_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationWhatsAppReportSettings" c WHERE c."senderId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppSender" p WHERE p.id=c."senderId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppDailyReportSnapshot_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppDailyReportSnapshot" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppServiceNotice_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppServiceNotice" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppServiceNotice_sender_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppServiceNotice" c WHERE c."senderId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppSender" p WHERE p.id=c."senderId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppOperationalIncident_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppOperationalIncident" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppOperationalIncident_sender_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppOperationalIncident" c WHERE c."senderId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppSender" p WHERE p.id=c."senderId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppOperationalIncident_message_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppOperationalIncident" c WHERE c."messageId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppMessage" p WHERE p.id=c."messageId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppOperationalIncident_message_branchId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppOperationalIncident" c WHERE c."messageId" IS NOT NULL AND c."branchId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppMessage" p WHERE p.id=c."messageId" AND p."branchId"=c."branchId")
UNION ALL
SELECT 'TI_WhatsAppOperationalIncident_message_senderId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppOperationalIncident" c WHERE c."messageId" IS NOT NULL AND c."senderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppMessage" p WHERE p.id=c."messageId" AND p."senderId"=c."senderId")
UNION ALL
SELECT 'TI_WhatsAppMessage_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppMessage_sender_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."senderId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppSender" p WHERE p.id=c."senderId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppMessage_student_branchId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."studentId" IS NOT NULL AND c."branchId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Student" p WHERE p.id=c."studentId" AND p."branchId"=c."branchId")
UNION ALL
SELECT 'TI_WhatsAppMessage_payment_branchId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."paymentId" IS NOT NULL AND c."branchId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p.id=c."paymentId" AND p."branchId"=c."branchId")
UNION ALL
SELECT 'TI_WhatsAppMessage_paymentResolutionEvent_branchId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."paymentResolutionEventId" IS NOT NULL AND c."branchId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "PaymentResolutionEvent" p WHERE p.id=c."paymentResolutionEventId" AND p."branchId"=c."branchId")
UNION ALL
SELECT 'TI_WhatsAppMessage_template_senderId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."templateId" IS NOT NULL AND c."senderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppTemplate" p WHERE p.id=c."templateId" AND p."senderId"=c."senderId")
UNION ALL
SELECT 'TI_WhatsAppMessage_templateBinding_senderId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."templateBindingId" IS NOT NULL AND c."senderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppTemplateBinding" p WHERE p.id=c."templateBindingId" AND p."senderId"=c."senderId")
UNION ALL
SELECT 'TI_WhatsAppMessage_manualSendRequest_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."manualSendRequestId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppManualSendRequest" p WHERE p.id=c."manualSendRequestId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppMessage_manualSendRequest_branchId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."manualSendRequestId" IS NOT NULL AND c."branchId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppManualSendRequest" p WHERE p.id=c."manualSendRequestId" AND p."branchId"=c."branchId")
UNION ALL
SELECT 'TI_WhatsAppMessage_reportSubscription_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."reportSubscriptionId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppReportSubscription" p WHERE p.id=c."reportSubscriptionId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppMessage_reportSubscription_branchId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."reportSubscriptionId" IS NOT NULL AND c."branchId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppReportSubscription" p WHERE p.id=c."reportSubscriptionId" AND p."branchId"=c."branchId")
UNION ALL
SELECT 'TI_WhatsAppMessage_reportSubscription_senderId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."reportSubscriptionId" IS NOT NULL AND c."senderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppReportSubscription" p WHERE p.id=c."reportSubscriptionId" AND p."senderId"=c."senderId")
UNION ALL
SELECT 'TI_WhatsAppMessage_dailyReportSnapshot_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."dailyReportSnapshotId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppDailyReportSnapshot" p WHERE p.id=c."dailyReportSnapshotId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppMessage_dailyReportSnapshot_branchId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."dailyReportSnapshotId" IS NOT NULL AND c."branchId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppDailyReportSnapshot" p WHERE p.id=c."dailyReportSnapshotId" AND p."branchId"=c."branchId")
UNION ALL
SELECT 'TI_WhatsAppMessage_serviceNotice_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."serviceNoticeId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppServiceNotice" p WHERE p.id=c."serviceNoticeId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppMessage_serviceNotice_branchId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."serviceNoticeId" IS NOT NULL AND c."branchId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppServiceNotice" p WHERE p.id=c."serviceNoticeId" AND p."branchId"=c."branchId")
UNION ALL
SELECT 'TI_WhatsAppMessage_serviceNotice_senderId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" c WHERE c."serviceNoticeId" IS NOT NULL AND c."senderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppServiceNotice" p WHERE p.id=c."serviceNoticeId" AND p."senderId"=c."senderId")
UNION ALL
SELECT 'TI_WhatsAppMessageEvent_message_senderId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessageEvent" c WHERE c."messageId" IS NOT NULL AND c."senderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppMessage" p WHERE p.id=c."messageId" AND p."senderId"=c."senderId")
UNION ALL
SELECT 'TI_WhatsAppWebhookReceipt_sender_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppWebhookReceipt" c WHERE c."senderId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppSender" p WHERE p.id=c."senderId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppAuditEvent_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppAuditEvent" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_WhatsAppAuditEvent_sender_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppAuditEvent" c WHERE c."senderId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "WhatsAppSender" p WHERE p.id=c."senderId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_ImportRecipe_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "ImportRecipe" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_OrganizationSubscription_replacesSubscription_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationSubscription" c WHERE c."replacesSubscriptionId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "OrganizationSubscription" p WHERE p.id=c."replacesSubscriptionId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_OrganizationSubscription_confirmedCommercialIntentC_4eaeac3f' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationSubscription" c WHERE c."confirmedCommercialIntentChangeId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "OrganizationBillingChange" p WHERE p.id=c."confirmedCommercialIntentChangeId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_OrganizationBillingChange_organizationSubscription__553adedd' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationBillingChange" c WHERE c."organizationSubscriptionId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "OrganizationSubscription" p WHERE p.id=c."organizationSubscriptionId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_OrganizationBillingChange_replacementSubscription_o_1f579ce7' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationBillingChange" c WHERE c."replacementSubscriptionId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "OrganizationSubscription" p WHERE p.id=c."replacementSubscriptionId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_OrganizationBillingChange_branch_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationBillingChange" c WHERE c."branchId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Branch" p WHERE p.id=c."branchId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_OrganizationBillingChangeAudit_change_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationBillingChangeAudit" c WHERE c."changeId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "OrganizationBillingChange" p WHERE p.id=c."changeId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_OrganizationSubscriptionInvoice_organizationSubscri_ad094872' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationSubscriptionInvoice" c WHERE c."organizationSubscriptionId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "OrganizationSubscription" p WHERE p.id=c."organizationSubscriptionId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_OrganizationSubscriptionInvoice_commercialIntentCha_a48c26ff' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationSubscriptionInvoice" c WHERE c."commercialIntentChangeId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "OrganizationBillingChange" p WHERE p.id=c."commercialIntentChangeId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_OrganizationSubscriptionHistory_organizationSubscri_a1d99aa0' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationSubscriptionHistory" c WHERE c."organizationSubscriptionId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "OrganizationSubscription" p WHERE p.id=c."organizationSubscriptionId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_RazorpayWebhookEvent_organizationSubscription_organizationId' AS relationship, COUNT(*) AS inconsistent_references FROM "RazorpayWebhookEvent" c WHERE c."organizationSubscriptionId" IS NOT NULL AND c."organizationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "OrganizationSubscription" p WHERE p.id=c."organizationSubscriptionId" AND p."organizationId"=c."organizationId")
UNION ALL
SELECT 'TI_subscription_current_owner' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationSubscription" WHERE NOT ("currentOrganizationId" IS NULL OR "currentOrganizationId"="organizationId")
UNION ALL
SELECT 'TI_subscription_pending_owner' AS relationship, COUNT(*) AS inconsistent_references FROM "OrganizationSubscription" WHERE NOT ("pendingReplacementOrganizationId" IS NULL OR "pendingReplacementOrganizationId"="organizationId")
UNION ALL
SELECT 'TI_webhook_subscription_scope' AS relationship, COUNT(*) AS inconsistent_references FROM "RazorpayWebhookEvent" WHERE NOT ("organizationSubscriptionId" IS NULL OR "organizationId" IS NOT NULL)
UNION ALL
SELECT 'TI_inbound_sender_scope' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppWebhookReceipt" WHERE NOT ("senderId" IS NULL OR "organizationId" IS NOT NULL)
UNION ALL
SELECT 'TI_message_operational_scope' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" WHERE NOT ("branchId" IS NOT NULL OR ("studentId" IS NULL AND "paymentId" IS NULL AND "paymentResolutionEventId" IS NULL AND "manualSendRequestId" IS NULL AND "serviceNoticeId" IS NULL))
) counts;
 IF n > 0 THEN RAISE EXCEPTION 'Tenant relationship migration blocked: % inconsistent references require reviewed repair', n; END IF;
END $$;
CREATE UNIQUE INDEX "TI_U_BranchWhatsAppSettings_branchId_organizationId" ON "BranchWhatsAppSettings"("branchId", "organizationId");

CREATE UNIQUE INDEX "TI_U_Branch_id_organizationId" ON "Branch"("id","organizationId");
CREATE UNIQUE INDEX "TI_U_WhatsAppSender_id_organizationId" ON "WhatsAppSender"("id","organizationId");
CREATE UNIQUE INDEX "TI_U_WhatsAppConsent_id_senderId" ON "WhatsAppConsent"("id","senderId");
CREATE UNIQUE INDEX "TI_U_WhatsAppTemplate_id_senderId" ON "WhatsAppTemplate"("id","senderId");
CREATE UNIQUE INDEX "TI_U_WhatsAppTemplateBinding_templateId_senderId" ON "WhatsAppTemplateBinding"("templateId","senderId");
CREATE UNIQUE INDEX "TI_U_WhatsAppManagedTemplateProvisioning_id_senderId" ON "WhatsAppManagedTemplateProvisioning"("id","senderId");
CREATE UNIQUE INDEX "TI_U_WhatsAppTemplateBinding_provisioningId_senderId" ON "WhatsAppTemplateBinding"("provisioningId","senderId");
CREATE UNIQUE INDEX "TI_U_WhatsAppMessage_id_organizationId" ON "WhatsAppMessage"("id","organizationId");
CREATE UNIQUE INDEX "TI_U_WhatsAppMessage_id_branchId" ON "WhatsAppMessage"("id","branchId");
CREATE UNIQUE INDEX "TI_U_WhatsAppMessage_id_senderId" ON "WhatsAppMessage"("id","senderId");
CREATE UNIQUE INDEX "TI_U_PaymentResolutionEvent_id_branchId" ON "PaymentResolutionEvent"("id","branchId");
CREATE UNIQUE INDEX "TI_U_WhatsAppTemplateBinding_id_senderId" ON "WhatsAppTemplateBinding"("id","senderId");
CREATE UNIQUE INDEX "TI_U_WhatsAppManualSendRequest_id_organizationId" ON "WhatsAppManualSendRequest"("id","organizationId");
CREATE UNIQUE INDEX "TI_U_WhatsAppManualSendRequest_id_branchId" ON "WhatsAppManualSendRequest"("id","branchId");
CREATE UNIQUE INDEX "TI_U_WhatsAppReportSubscription_id_organizationId" ON "WhatsAppReportSubscription"("id","organizationId");
CREATE UNIQUE INDEX "TI_U_WhatsAppReportSubscription_id_branchId" ON "WhatsAppReportSubscription"("id","branchId");
CREATE UNIQUE INDEX "TI_U_WhatsAppReportSubscription_id_senderId" ON "WhatsAppReportSubscription"("id","senderId");
CREATE UNIQUE INDEX "TI_U_WhatsAppDailyReportSnapshot_id_organizationId" ON "WhatsAppDailyReportSnapshot"("id","organizationId");
CREATE UNIQUE INDEX "TI_U_WhatsAppDailyReportSnapshot_id_branchId" ON "WhatsAppDailyReportSnapshot"("id","branchId");
CREATE UNIQUE INDEX "TI_U_WhatsAppServiceNotice_id_organizationId" ON "WhatsAppServiceNotice"("id","organizationId");
CREATE UNIQUE INDEX "TI_U_WhatsAppServiceNotice_id_branchId" ON "WhatsAppServiceNotice"("id","branchId");
CREATE UNIQUE INDEX "TI_U_WhatsAppServiceNotice_id_senderId" ON "WhatsAppServiceNotice"("id","senderId");
CREATE UNIQUE INDEX "TI_U_OrganizationSubscription_id_organizationId" ON "OrganizationSubscription"("id","organizationId");
CREATE UNIQUE INDEX "TI_U_OrganizationBillingChange_id_organizationId" ON "OrganizationBillingChange"("id","organizationId");
CREATE UNIQUE INDEX "TI_U_OrganizationSubscription_confirmedCommercialInten_5ff9dc96" ON "OrganizationSubscription"("confirmedCommercialIntentChangeId","organizationId");
CREATE UNIQUE INDEX "TI_U_OrganizationBillingChange_replacementSubscription_d0865a8d" ON "OrganizationBillingChange"("replacementSubscriptionId","organizationId");
ALTER TABLE "BranchWhatsAppSettings" DROP CONSTRAINT "BranchWhatsAppSettings_branchId_fkey", ADD CONSTRAINT "TI_BranchWhatsAppSettings_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BranchWhatsAppSettings" DROP CONSTRAINT "BranchWhatsAppSettings_senderId_fkey", ADD CONSTRAINT "TI_BranchWhatsAppSettings_sender_organizationId" FOREIGN KEY ("senderId", "organizationId") REFERENCES "WhatsAppSender"(id, "organizationId") ON DELETE SET NULL ("senderId") ON UPDATE CASCADE;
ALTER TABLE "WhatsAppConsentEvent" DROP CONSTRAINT "WhatsAppConsentEvent_consentId_fkey", ADD CONSTRAINT "TI_WhatsAppConsentEvent_consent_senderId" FOREIGN KEY ("consentId", "senderId") REFERENCES "WhatsAppConsent"(id, "senderId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppStudentRecipient" DROP CONSTRAINT "WhatsAppStudentRecipient_branchId_fkey", ADD CONSTRAINT "TI_WhatsAppStudentRecipient_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppStudentRecipient" DROP CONSTRAINT "WhatsAppStudentRecipient_studentId_fkey", ADD CONSTRAINT "TI_WhatsAppStudentRecipient_student_branchId" FOREIGN KEY ("studentId", "branchId") REFERENCES "Student"(id, "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppStudentRecipient" DROP CONSTRAINT "WhatsAppStudentRecipient_senderId_fkey", ADD CONSTRAINT "TI_WhatsAppStudentRecipient_sender_organizationId" FOREIGN KEY ("senderId", "organizationId") REFERENCES "WhatsAppSender"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppStudentRecipient" DROP CONSTRAINT "WhatsAppStudentRecipient_consentId_fkey", ADD CONSTRAINT "TI_WhatsAppStudentRecipient_consent_senderId" FOREIGN KEY ("consentId", "senderId") REFERENCES "WhatsAppConsent"(id, "senderId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppTemplateBinding" DROP CONSTRAINT "WhatsAppTemplateBinding_templateId_fkey", ADD CONSTRAINT "TI_WhatsAppTemplateBinding_template_senderId" FOREIGN KEY ("templateId", "senderId") REFERENCES "WhatsAppTemplate"(id, "senderId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppTemplateBinding" DROP CONSTRAINT "WhatsAppTemplateBinding_provisioningId_fkey", ADD CONSTRAINT "TI_WhatsAppTemplateBinding_provisioning_senderId" FOREIGN KEY ("provisioningId", "senderId") REFERENCES "WhatsAppManagedTemplateProvisioning"(id, "senderId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppAutomationRule" DROP CONSTRAINT "WhatsAppAutomationRule_branchId_fkey", ADD CONSTRAINT "TI_WhatsAppAutomationRule_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppManualSendRequest" DROP CONSTRAINT "WhatsAppManualSendRequest_branchId_fkey", ADD CONSTRAINT "TI_WhatsAppManualSendRequest_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppReportSubscription" DROP CONSTRAINT "WhatsAppReportSubscription_branchId_fkey", ADD CONSTRAINT "TI_WhatsAppReportSubscription_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppReportSubscription" DROP CONSTRAINT "WhatsAppReportSubscription_senderId_fkey", ADD CONSTRAINT "TI_WhatsAppReportSubscription_sender_organizationId" FOREIGN KEY ("senderId", "organizationId") REFERENCES "WhatsAppSender"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppReportSubscription" DROP CONSTRAINT "WhatsAppReportSubscription_consentId_fkey", ADD CONSTRAINT "TI_WhatsAppReportSubscription_consent_senderId" FOREIGN KEY ("consentId", "senderId") REFERENCES "WhatsAppConsent"(id, "senderId") ON DELETE SET NULL ("consentId") ON UPDATE CASCADE;
ALTER TABLE "OrganizationWhatsAppReportSettings" DROP CONSTRAINT "OrganizationWhatsAppReportSettings_senderId_fkey", ADD CONSTRAINT "TI_OrganizationWhatsAppReportSettings_sender_organizationId" FOREIGN KEY ("senderId", "organizationId") REFERENCES "WhatsAppSender"(id, "organizationId") ON DELETE SET NULL ("senderId") ON UPDATE CASCADE;
ALTER TABLE "WhatsAppDailyReportSnapshot" DROP CONSTRAINT "WhatsAppDailyReportSnapshot_branchId_fkey", ADD CONSTRAINT "TI_WhatsAppDailyReportSnapshot_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppServiceNotice" DROP CONSTRAINT "WhatsAppServiceNotice_branchId_fkey", ADD CONSTRAINT "TI_WhatsAppServiceNotice_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppServiceNotice" DROP CONSTRAINT "WhatsAppServiceNotice_senderId_fkey", ADD CONSTRAINT "TI_WhatsAppServiceNotice_sender_organizationId" FOREIGN KEY ("senderId", "organizationId") REFERENCES "WhatsAppSender"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppOperationalIncident" DROP CONSTRAINT "WhatsAppOperationalIncident_branchId_fkey", ADD CONSTRAINT "TI_WhatsAppOperationalIncident_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppOperationalIncident" DROP CONSTRAINT "WhatsAppOperationalIncident_senderId_fkey", ADD CONSTRAINT "TI_WhatsAppOperationalIncident_sender_organizationId" FOREIGN KEY ("senderId", "organizationId") REFERENCES "WhatsAppSender"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppOperationalIncident" DROP CONSTRAINT "WhatsAppOperationalIncident_messageId_fkey", ADD CONSTRAINT "TI_WhatsAppOperationalIncident_message_organizationId" FOREIGN KEY ("messageId", "organizationId") REFERENCES "WhatsAppMessage"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppOperationalIncident" ADD CONSTRAINT "TI_WhatsAppOperationalIncident_message_branchId" FOREIGN KEY ("messageId", "branchId") REFERENCES "WhatsAppMessage"(id, "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppOperationalIncident" ADD CONSTRAINT "TI_WhatsAppOperationalIncident_message_senderId" FOREIGN KEY ("messageId", "senderId") REFERENCES "WhatsAppMessage"(id, "senderId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" DROP CONSTRAINT "WhatsAppMessage_branchId_fkey", ADD CONSTRAINT "TI_WhatsAppMessage_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE SET NULL ("branchId") ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" DROP CONSTRAINT "WhatsAppMessage_senderId_fkey", ADD CONSTRAINT "TI_WhatsAppMessage_sender_organizationId" FOREIGN KEY ("senderId", "organizationId") REFERENCES "WhatsAppSender"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" DROP CONSTRAINT "WhatsAppMessage_studentId_fkey", ADD CONSTRAINT "TI_WhatsAppMessage_student_branchId" FOREIGN KEY ("studentId", "branchId") REFERENCES "Student"(id, "branchId") ON DELETE SET NULL ("studentId") ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" DROP CONSTRAINT "WhatsAppMessage_paymentId_fkey", ADD CONSTRAINT "TI_WhatsAppMessage_payment_branchId" FOREIGN KEY ("paymentId", "branchId") REFERENCES "Payment"(id, "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" DROP CONSTRAINT "WhatsAppMessage_paymentResolutionEventId_fkey", ADD CONSTRAINT "TI_WhatsAppMessage_paymentResolutionEvent_branchId" FOREIGN KEY ("paymentResolutionEventId", "branchId") REFERENCES "PaymentResolutionEvent"(id, "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" DROP CONSTRAINT "WhatsAppMessage_templateId_fkey", ADD CONSTRAINT "TI_WhatsAppMessage_template_senderId" FOREIGN KEY ("templateId", "senderId") REFERENCES "WhatsAppTemplate"(id, "senderId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" DROP CONSTRAINT "WhatsAppMessage_templateBindingId_fkey", ADD CONSTRAINT "TI_WhatsAppMessage_templateBinding_senderId" FOREIGN KEY ("templateBindingId", "senderId") REFERENCES "WhatsAppTemplateBinding"(id, "senderId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" DROP CONSTRAINT "WhatsAppMessage_manualSendRequestId_fkey", ADD CONSTRAINT "TI_WhatsAppMessage_manualSendRequest_organizationId" FOREIGN KEY ("manualSendRequestId", "organizationId") REFERENCES "WhatsAppManualSendRequest"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "TI_WhatsAppMessage_manualSendRequest_branchId" FOREIGN KEY ("manualSendRequestId", "branchId") REFERENCES "WhatsAppManualSendRequest"(id, "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" DROP CONSTRAINT "WhatsAppMessage_reportSubscriptionId_fkey", ADD CONSTRAINT "TI_WhatsAppMessage_reportSubscription_organizationId" FOREIGN KEY ("reportSubscriptionId", "organizationId") REFERENCES "WhatsAppReportSubscription"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "TI_WhatsAppMessage_reportSubscription_branchId" FOREIGN KEY ("reportSubscriptionId", "branchId") REFERENCES "WhatsAppReportSubscription"(id, "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "TI_WhatsAppMessage_reportSubscription_senderId" FOREIGN KEY ("reportSubscriptionId", "senderId") REFERENCES "WhatsAppReportSubscription"(id, "senderId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" DROP CONSTRAINT "WhatsAppMessage_dailyReportSnapshotId_fkey", ADD CONSTRAINT "TI_WhatsAppMessage_dailyReportSnapshot_organizationId" FOREIGN KEY ("dailyReportSnapshotId", "organizationId") REFERENCES "WhatsAppDailyReportSnapshot"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "TI_WhatsAppMessage_dailyReportSnapshot_branchId" FOREIGN KEY ("dailyReportSnapshotId", "branchId") REFERENCES "WhatsAppDailyReportSnapshot"(id, "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" DROP CONSTRAINT "WhatsAppMessage_serviceNoticeId_fkey", ADD CONSTRAINT "TI_WhatsAppMessage_serviceNotice_organizationId" FOREIGN KEY ("serviceNoticeId", "organizationId") REFERENCES "WhatsAppServiceNotice"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "TI_WhatsAppMessage_serviceNotice_branchId" FOREIGN KEY ("serviceNoticeId", "branchId") REFERENCES "WhatsAppServiceNotice"(id, "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "TI_WhatsAppMessage_serviceNotice_senderId" FOREIGN KEY ("serviceNoticeId", "senderId") REFERENCES "WhatsAppServiceNotice"(id, "senderId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppMessageEvent" DROP CONSTRAINT "WhatsAppMessageEvent_messageId_fkey", ADD CONSTRAINT "TI_WhatsAppMessageEvent_message_senderId" FOREIGN KEY ("messageId", "senderId") REFERENCES "WhatsAppMessage"(id, "senderId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppWebhookReceipt" DROP CONSTRAINT "WhatsAppWebhookReceipt_senderId_fkey", ADD CONSTRAINT "TI_WhatsAppWebhookReceipt_sender_organizationId" FOREIGN KEY ("senderId", "organizationId") REFERENCES "WhatsAppSender"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WhatsAppAuditEvent" DROP CONSTRAINT "WhatsAppAuditEvent_branchId_fkey", ADD CONSTRAINT "TI_WhatsAppAuditEvent_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE SET NULL ("branchId") ON UPDATE CASCADE;
ALTER TABLE "WhatsAppAuditEvent" DROP CONSTRAINT "WhatsAppAuditEvent_senderId_fkey", ADD CONSTRAINT "TI_WhatsAppAuditEvent_sender_organizationId" FOREIGN KEY ("senderId", "organizationId") REFERENCES "WhatsAppSender"(id, "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportRecipe" DROP CONSTRAINT "ImportRecipe_branchId_fkey", ADD CONSTRAINT "TI_ImportRecipe_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE SET NULL ("branchId") ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscription" DROP CONSTRAINT "OrganizationSubscription_replacesSubscriptionId_fkey", ADD CONSTRAINT "TI_OrganizationSubscription_replacesSubscription_organizationId" FOREIGN KEY ("replacesSubscriptionId", "organizationId") REFERENCES "OrganizationSubscription"(id, "organizationId") ON DELETE SET NULL ("replacesSubscriptionId") ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscription" DROP CONSTRAINT "OrganizationSubscription_confirmedCommercialIntentChangeId_fkey", ADD CONSTRAINT "TI_OrganizationSubscription_confirmedCommercialIntentC_4eaeac3f" FOREIGN KEY ("confirmedCommercialIntentChangeId", "organizationId") REFERENCES "OrganizationBillingChange"(id, "organizationId") ON DELETE SET NULL ("confirmedCommercialIntentChangeId") ON UPDATE CASCADE;
ALTER TABLE "OrganizationBillingChange" DROP CONSTRAINT "OrganizationBillingChange_organizationSubscriptionId_fkey", ADD CONSTRAINT "TI_OrganizationBillingChange_organizationSubscription__553adedd" FOREIGN KEY ("organizationSubscriptionId", "organizationId") REFERENCES "OrganizationSubscription"(id, "organizationId") ON DELETE SET NULL ("organizationSubscriptionId") ON UPDATE CASCADE;
ALTER TABLE "OrganizationBillingChange" DROP CONSTRAINT "OrganizationBillingChange_replacementSubscriptionId_fkey", ADD CONSTRAINT "TI_OrganizationBillingChange_replacementSubscription_o_1f579ce7" FOREIGN KEY ("replacementSubscriptionId", "organizationId") REFERENCES "OrganizationSubscription"(id, "organizationId") ON DELETE SET NULL ("replacementSubscriptionId") ON UPDATE CASCADE;
ALTER TABLE "OrganizationBillingChange" DROP CONSTRAINT "OrganizationBillingChange_branchId_fkey", ADD CONSTRAINT "TI_OrganizationBillingChange_branch_organizationId" FOREIGN KEY ("branchId", "organizationId") REFERENCES "Branch"(id, "organizationId") ON DELETE SET NULL ("branchId") ON UPDATE CASCADE;
ALTER TABLE "OrganizationBillingChangeAudit" DROP CONSTRAINT "OrganizationBillingChangeAudit_changeId_fkey", ADD CONSTRAINT "TI_OrganizationBillingChangeAudit_change_organizationId" FOREIGN KEY ("changeId", "organizationId") REFERENCES "OrganizationBillingChange"(id, "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscriptionInvoice" DROP CONSTRAINT "OrganizationSubscriptionInvoice_organizationSubscriptionId_fkey", ADD CONSTRAINT "TI_OrganizationSubscriptionInvoice_organizationSubscri_ad094872" FOREIGN KEY ("organizationSubscriptionId", "organizationId") REFERENCES "OrganizationSubscription"(id, "organizationId") ON DELETE SET NULL ("organizationSubscriptionId") ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscriptionInvoice" DROP CONSTRAINT "OrganizationSubscriptionInvoice_commercialIntentChangeId_fkey", ADD CONSTRAINT "TI_OrganizationSubscriptionInvoice_commercialIntentCha_a48c26ff" FOREIGN KEY ("commercialIntentChangeId", "organizationId") REFERENCES "OrganizationBillingChange"(id, "organizationId") ON DELETE SET NULL ("commercialIntentChangeId") ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscriptionHistory" DROP CONSTRAINT "OrganizationSubscriptionHistory_organizationSubscriptionId_fkey", ADD CONSTRAINT "TI_OrganizationSubscriptionHistory_organizationSubscri_a1d99aa0" FOREIGN KEY ("organizationSubscriptionId", "organizationId") REFERENCES "OrganizationSubscription"(id, "organizationId") ON DELETE SET NULL ("organizationSubscriptionId") ON UPDATE CASCADE;
ALTER TABLE "RazorpayWebhookEvent" DROP CONSTRAINT "RazorpayWebhookEvent_organizationSubscriptionId_fkey", ADD CONSTRAINT "TI_RazorpayWebhookEvent_organizationSubscription_organizationId" FOREIGN KEY ("organizationSubscriptionId", "organizationId") REFERENCES "OrganizationSubscription"(id, "organizationId") ON DELETE SET NULL ("organizationSubscriptionId") ON UPDATE CASCADE;
ALTER TABLE "OrganizationSubscription" ADD CONSTRAINT "TI_subscription_current_owner" CHECK ("currentOrganizationId" IS NULL OR "currentOrganizationId"="organizationId");
ALTER TABLE "OrganizationSubscription" ADD CONSTRAINT "TI_subscription_pending_owner" CHECK ("pendingReplacementOrganizationId" IS NULL OR "pendingReplacementOrganizationId"="organizationId");
ALTER TABLE "RazorpayWebhookEvent" ADD CONSTRAINT "TI_webhook_subscription_scope" CHECK ("organizationSubscriptionId" IS NULL OR "organizationId" IS NOT NULL);
ALTER TABLE "WhatsAppWebhookReceipt" ADD CONSTRAINT "TI_inbound_sender_scope" CHECK ("senderId" IS NULL OR "organizationId" IS NOT NULL);
ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "TI_message_operational_scope" CHECK ("branchId" IS NOT NULL OR ("studentId" IS NULL AND "paymentId" IS NULL AND "paymentResolutionEventId" IS NULL AND "manualSendRequestId" IS NULL AND "serviceNoticeId" IS NULL));
COMMIT;
