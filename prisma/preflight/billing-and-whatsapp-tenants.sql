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
SELECT 'TI_message_operational_scope' AS relationship, COUNT(*) AS inconsistent_references FROM "WhatsAppMessage" WHERE NOT ("branchId" IS NOT NULL OR ("studentId" IS NULL AND "paymentId" IS NULL AND "paymentResolutionEventId" IS NULL AND "manualSendRequestId" IS NULL AND "serviceNoticeId" IS NULL));
