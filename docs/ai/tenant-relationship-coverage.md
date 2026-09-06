# Tenant relationship coverage

All owning Prisma relations are listed below, including global identities and single-parent chains so the multi-parent scope is reviewable. `relationship-catalog.test.ts` compares every listed key against the installed PostgreSQL catalog and detects schema/inventory drift. SQL migrations additionally enforce presence, identity, and immutable-intent CHECKs/triggers that Prisma cannot express. Direct mixed-parent SQL and upgrade/blocker fixtures exercise the operational, billing/WhatsApp, allocation, import, and typed-target families.

Composite keys prove matching scope only when references are present. Column-specific SET NULL detaches only the foreign ID, preserving required scope. Presence CHECKs cover operational WhatsApp targets and bound webhook references. Historical import target snapshots may detach after deletion; new JSON references require live same-branch targets. Payment/student identity consistency inside one branch and plan/evaluation session semantics remain domain validation, distinct from tenant integrity.

Global User references record actors/owners and do not assert current membership. BillingOffer, plan catalog, database identity, and provider IDs are global configuration or historical provider evidence: they do not confer tenant access. OrganizationOfferGrant.subscriptionId is a Razorpay provider ID snapshot, not a local OrganizationSubscription FK. JobRun is system-wide telemetry, not an authorization context. Text/JSON actor/provider snapshots are never authorization proof.

| Relationship | PostgreSQL parent key | Tenant proof | Nullable reference |
| --- | --- | --- | --- |
| Organization.owner (ownerId) | User (id) | Global identity/configuration; policy checks remain | No |
| Branch.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| Student.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| Student.feeLinkedShift (feeLinkedShiftId, branchId) | Shift (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| Student.feeLinkedMultiShift (feeLinkedMultiShiftId, branchId) | MultiShift (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| Seat.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| Shift.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| MultiShift.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| MultiShiftComponent.multiShift (multiShiftId, branchId) | MultiShift (id, branchId) | Composite branchId | No |
| MultiShiftComponent.shift (shiftId, branchId) | Shift (id, branchId) | Composite branchId | No |
| SeatAllocation.seat (seatId, branchId) | Seat (id, branchId) | Composite branchId | No |
| SeatAllocation.shift (shiftId, branchId) | Shift (id, branchId) | Composite branchId | No |
| SeatAllocation.student (studentId, branchId) | Student (id, branchId) | Composite branchId | No |
| SeatAllocation.multiShift (multiShiftId, branchId) | MultiShift (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| Payment.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| Payment.student (studentId, branchId) | Student (id, branchId) | Composite branchId | No |
| PaymentResolutionEvent.payment (paymentId, branchId) | Payment (id, branchId) | Composite branchId | No |
| PaymentResolutionEvent.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| PaymentResolutionEvent.actor (actorUserId) | User (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| Staff.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| Staff.user (userId) | User (id) | Global identity/configuration; policy checks remain | No |
| StaffPermissionOverride.staff (staffId) | Staff (id) | Single scoped parent chain | No |
| StaffInvite.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| BranchAIReport.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| MessageDraft.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| MessageDraft.student (studentId, branchId) | Student (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| BranchGenerationLease.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| WhatsAppInboundMessageReceipt.sender (senderId) | WhatsAppSender (id) | Single scoped parent chain | No |
| WhatsAppSender.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| WhatsAppSender.connectedBy (connectedByUserId) | User (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| WhatsAppConnectionIntent.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| WhatsAppConnectionIntent.actor (actorUserId) | User (id) | Global identity/configuration; policy checks remain | No |
| BranchWhatsAppSettings.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | No |
| BranchWhatsAppSettings.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| BranchWhatsAppSettings.sender (senderId, organizationId) | WhatsAppSender (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| BranchWhatsAppSettings.automationEnabledBy (automationEnabledByUserId) | User (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| WhatsAppTemplate.sender (senderId) | WhatsAppSender (id) | Single scoped parent chain | No |
| WhatsAppConsent.sender (senderId) | WhatsAppSender (id) | Single scoped parent chain | No |
| WhatsAppConsent.recordedBy (recordedByUserId) | User (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| WhatsAppConsentEvent.consent (consentId, senderId) | WhatsAppConsent (id, senderId) | Composite senderId | No |
| WhatsAppConsentEvent.sender (senderId) | WhatsAppSender (id) | Single scoped parent chain | No |
| WhatsAppConsentEvent.actor (actorUserId) | User (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| WhatsAppStudentRecipient.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| WhatsAppStudentRecipient.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | No |
| WhatsAppStudentRecipient.student (studentId, branchId) | Student (id, branchId) | Composite branchId | No |
| WhatsAppStudentRecipient.sender (senderId, organizationId) | WhatsAppSender (id, organizationId) | Composite organizationId | No |
| WhatsAppStudentRecipient.consent (consentId, senderId) | WhatsAppConsent (id, senderId) | Composite senderId | No |
| WhatsAppStudentRecipient.createdBy (createdByUserId) | User (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| WhatsAppManagedTemplateProvisioning.sender (senderId) | WhatsAppSender (id) | Single scoped parent chain | No |
| WhatsAppTemplateBinding.sender (senderId) | WhatsAppSender (id) | Single scoped parent chain | No |
| WhatsAppTemplateBinding.template (templateId, senderId) | WhatsAppTemplate (id, senderId) | Composite senderId | No |
| WhatsAppTemplateBinding.provisioning (provisioningId, senderId) | WhatsAppManagedTemplateProvisioning (id, senderId) | Composite senderId | No |
| WhatsAppAutomationRule.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| WhatsAppAutomationRule.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | No |
| WhatsAppManualSendRequest.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| WhatsAppManualSendRequest.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | No |
| WhatsAppManualSendRequest.actor (actorUserId) | User (id) | Global identity/configuration; policy checks remain | No |
| WhatsAppReportSubscription.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| WhatsAppReportSubscription.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppReportSubscription.sender (senderId, organizationId) | WhatsAppSender (id, organizationId) | Composite organizationId | No |
| WhatsAppReportSubscription.user (userId) | User (id) | Global identity/configuration; policy checks remain | No |
| WhatsAppReportSubscription.consent (consentId, senderId) | WhatsAppConsent (id, senderId) | Composite senderId | Yes; deletion semantics in SQL |
| OrganizationWhatsAppReportSettings.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| OrganizationWhatsAppReportSettings.sender (senderId, organizationId) | WhatsAppSender (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppDailyReportSnapshot.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| WhatsAppDailyReportSnapshot.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppServiceNotice.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| WhatsAppServiceNotice.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | No |
| WhatsAppServiceNotice.sender (senderId, organizationId) | WhatsAppSender (id, organizationId) | Composite organizationId | No |
| WhatsAppServiceNotice.actor (actorUserId) | User (id) | Global identity/configuration; policy checks remain | No |
| WhatsAppSenderSafetyState.sender (senderId) | WhatsAppSender (id) | Single scoped parent chain | No |
| WhatsAppSenderSafetyState.pausedBy (pausedByUserId) | User (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| WhatsAppOperationalIncident.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| WhatsAppOperationalIncident.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppOperationalIncident.sender (senderId, organizationId) | WhatsAppSender (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppOperationalIncident.message (messageId, organizationId) | WhatsAppMessage (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppOperationalIncident.acknowledgedBy (acknowledgedByUserId) | User (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| WhatsAppOperationalIncident.messageBybranchId (messageId, branchId) | WhatsAppMessage (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| WhatsAppOperationalIncident.messageBysenderId (messageId, senderId) | WhatsAppMessage (id, senderId) | Composite senderId | Yes; deletion semantics in SQL |
| WhatsAppMessage.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| WhatsAppMessage.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppMessage.sender (senderId, organizationId) | WhatsAppSender (id, organizationId) | Composite organizationId | No |
| WhatsAppMessage.student (studentId, branchId) | Student (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| WhatsAppMessage.payment (paymentId, branchId) | Payment (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| WhatsAppMessage.paymentResolutionEvent (paymentResolutionEventId, branchId) | PaymentResolutionEvent (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| WhatsAppMessage.template (templateId, senderId) | WhatsAppTemplate (id, senderId) | Composite senderId | Yes; deletion semantics in SQL |
| WhatsAppMessage.templateBinding (templateBindingId, senderId) | WhatsAppTemplateBinding (id, senderId) | Composite senderId | Yes; deletion semantics in SQL |
| WhatsAppMessage.manualSendRequest (manualSendRequestId, organizationId) | WhatsAppManualSendRequest (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppMessage.reportSubscription (reportSubscriptionId, organizationId) | WhatsAppReportSubscription (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppMessage.dailyReportSnapshot (dailyReportSnapshotId, organizationId) | WhatsAppDailyReportSnapshot (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppMessage.serviceNotice (serviceNoticeId, organizationId) | WhatsAppServiceNotice (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppMessage.createdBy (createdByUserId) | User (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| WhatsAppMessage.manualSendRequestBybranchId (manualSendRequestId, branchId) | WhatsAppManualSendRequest (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| WhatsAppMessage.reportSubscriptionBybranchId (reportSubscriptionId, branchId) | WhatsAppReportSubscription (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| WhatsAppMessage.reportSubscriptionBysenderId (reportSubscriptionId, senderId) | WhatsAppReportSubscription (id, senderId) | Composite senderId | Yes; deletion semantics in SQL |
| WhatsAppMessage.dailyReportSnapshotBybranchId (dailyReportSnapshotId, branchId) | WhatsAppDailyReportSnapshot (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| WhatsAppMessage.serviceNoticeBybranchId (serviceNoticeId, branchId) | WhatsAppServiceNotice (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| WhatsAppMessage.serviceNoticeBysenderId (serviceNoticeId, senderId) | WhatsAppServiceNotice (id, senderId) | Composite senderId | Yes; deletion semantics in SQL |
| WhatsAppMessagePayment.message (messageId, branchId) | WhatsAppMessage (id, branchId) | Composite branchId | No |
| WhatsAppMessagePayment.payment (paymentId, branchId) | Payment (id, branchId) | Composite branchId | No |
| WhatsAppMessageEvent.message (messageId, senderId) | WhatsAppMessage (id, senderId) | Composite senderId | Yes; deletion semantics in SQL |
| WhatsAppMessageEvent.sender (senderId) | WhatsAppSender (id) | Single scoped parent chain | No |
| WhatsAppWebhookReceipt.organization (organizationId) | Organization (id) | Organization ownership chain | Yes; deletion semantics in SQL |
| WhatsAppWebhookReceipt.sender (senderId, organizationId) | WhatsAppSender (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppAuditEvent.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| WhatsAppAuditEvent.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppAuditEvent.sender (senderId, organizationId) | WhatsAppSender (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| WhatsAppAuditEvent.actor (actorUserId) | User (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| ImportSession.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| ImportSession.uploadedBy (uploadedByUserId) | User (id) | Global identity/configuration; policy checks remain | No |
| ImportRow.session (importSessionId, branchId) | ImportSession (id, branchId) | Composite branchId | No |
| ImportQuestion.session (importSessionId) | ImportSession (id) | Single scoped parent chain | No |
| ImportQuestion.row (rowId, importSessionId) | ImportRow (id, importSessionId) | Composite importSessionId | Yes; deletion semantics in SQL |
| ImportCommit.session (importSessionId) | ImportSession (id) | Single scoped parent chain | No |
| ImportCommit.committedBy (committedByUserId) | User (id) | Global identity/configuration; policy checks remain | No |
| ImportRowEvaluation.row (importRowId, branchId) | ImportRow (id, branchId) | Composite branchId | No |
| ImportPlan.session (importSessionId, branchId) | ImportSession (id, branchId) | Composite branchId | No |
| ImportPlan.compiledBy (compiledByUserId) | User (id) | Global identity/configuration; policy checks remain | No |
| ImportRun.session (importSessionId, branchId) | ImportSession (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportRun.plan (importPlanId, branchId) | ImportPlan (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportRun.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| ImportRun.requestedBy (requestedByUserId) | User (id) | Global identity/configuration; policy checks remain | No |
| ImportRun.cancelRequestedBy (cancelRequestedByUserId) | User (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| ImportRunItem.run (importRunId, branchId) | ImportRun (id, branchId) | Composite branchId | No |
| ImportRunItem.row (importRowId, branchId) | ImportRow (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportRunItem.evaluation (evaluationId, branchId) | ImportRowEvaluation (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportRecipe.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| ImportRecipe.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| ImportRecipe.createdBy (createdByUserId) | User (id) | Global identity/configuration; policy checks remain | No |
| AuditLog.branch (branchId) | Branch (id) | Single scoped parent chain | No |
| AuditLog.user (userId) | User (id) | Global identity/configuration; policy checks remain | No |
| AuditLog.payment (paymentId, branchId) | Payment (id, branchId) | Composite branchId | No |
| OwnerTrialGrant.owner (ownerId) | User (id) | Global identity/configuration; policy checks remain | No |
| OwnerTrialGrant.organization (organizationId) | Organization (id) | Organization ownership chain | Yes; deletion semantics in SQL |
| OrganizationOfferGrant.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| OrganizationOfferGrant.billingOffer (billingOfferId) | BillingOffer (id) | Global identity/configuration; policy checks remain | No |
| OrganizationSubscription.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| OrganizationSubscription.currentForOrganization (currentOrganizationId) | Organization (id) | Organization ownership chain | Yes; deletion semantics in SQL |
| OrganizationSubscription.pendingReplacementForOrganization (pendingReplacementOrganizationId) | Organization (id) | Organization ownership chain | Yes; deletion semantics in SQL |
| OrganizationSubscription.replacesSubscription (replacesSubscriptionId, organizationId) | OrganizationSubscription (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| OrganizationSubscription.billingOffer (billingOfferId) | BillingOffer (id) | Global identity/configuration; policy checks remain | Yes; deletion semantics in SQL |
| OrganizationSubscription.confirmedCommercialIntentChange (confirmedCommercialIntentChangeId, organizationId) | OrganizationBillingChange (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| OrganizationBillingChange.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| OrganizationBillingChange.organizationSubscription (organizationSubscriptionId, organizationId) | OrganizationSubscription (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| OrganizationBillingChange.replacementSubscription (replacementSubscriptionId, organizationId) | OrganizationSubscription (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| OrganizationBillingChange.branch (branchId, organizationId) | Branch (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| OrganizationBillingChangeAudit.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| OrganizationBillingChangeAudit.change (changeId, organizationId) | OrganizationBillingChange (id, organizationId) | Composite organizationId | No |
| OrganizationSubscriptionInvoice.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| OrganizationSubscriptionInvoice.organizationSubscription (organizationSubscriptionId, organizationId) | OrganizationSubscription (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| OrganizationSubscriptionInvoice.commercialIntentChange (commercialIntentChangeId, organizationId) | OrganizationBillingChange (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| OrganizationSubscriptionHistory.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| OrganizationSubscriptionHistory.organizationSubscription (organizationSubscriptionId, organizationId) | OrganizationSubscription (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| RazorpayWebhookEvent.organization (organizationId) | Organization (id) | Organization ownership chain | Yes; deletion semantics in SQL |
| RazorpayWebhookEvent.organizationSubscription (organizationSubscriptionId, organizationId) | OrganizationSubscription (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |
| ImportTargetReference.row (importRowId, branchId) | ImportRow (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportTargetReference.item (importRunItemId, branchId) | ImportRunItem (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportTargetReference.plan (importPlanId, branchId) | ImportPlan (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportTargetReference.student (studentId, branchId) | Student (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportTargetReference.seat (seatId, branchId) | Seat (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportTargetReference.shift (shiftId, branchId) | Shift (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportTargetReference.multiShift (multiShiftId, branchId) | MultiShift (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportTargetReference.seatAllocation (seatAllocationId, branchId) | SeatAllocation (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| ImportTargetReference.payment (paymentId, branchId) | Payment (id, branchId) | Composite branchId | Yes; deletion semantics in SQL |
| BillingProviderAction.organization (organizationId) | Organization (id) | Organization ownership chain | No |
| BillingProviderAction.change (changeId, organizationId) | OrganizationBillingChange (id, organizationId) | Composite organizationId | Yes; deletion semantics in SQL |

Frozen migration-specific details: [billing/WhatsApp](../../prisma/tenant-relationship-contracts.json), [import](../../prisma/import-relationship-contracts.json). The full [machine-readable inventory](../../prisma/relationship-coverage.json) includes 166 owning relationships. No new tenant columns were added to single-parent or global identity chains.

Retained retry-plan `snapshot.items[].payload.studentId` is also maintained in the typed ledger by migration 48; runtime foreign/missing targets reject, historical missing targets detach, and foreign history blocks atomically. Other plan JSON is reviewed staging/description, not a second executable target map.
