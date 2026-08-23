import { apiClient } from "./core";
import type { WhatsAppBrowserConfig } from "@/types";

export type WhatsAppSenderStatus =
  | "PENDING"
  | "NEEDS_REGISTRATION"
  | "ACTIVE"
  | "RESTRICTED"
  | "DISCONNECTED"
  | "ERROR";

export type WhatsAppTemplateCounts = {
  approved: number;
  pending: number;
  rejected: number;
  other: number;
  total: number;
};

export type WhatsAppAssignedBranchSummary = {
  id: string;
  name: string;
};

/** Browser-safe sender projection. Provider asset identifiers are deliberately absent. */
export type WhatsAppSenderSummary = {
  id: string;
  providerMode: "TEST" | "LIVE";
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string | null;
  accountMode: string | null;
  status: WhatsAppSenderStatus;
  phoneRegisteredAt: string | null;
  webhookSubscribedAt: string | null;
  lastHealthCheckAt: string | null;
  lastTemplateSyncAt: string | null;
  templateCounts: WhatsAppTemplateCounts;
  assignedBranches: WhatsAppAssignedBranchSummary[];
};

export type WhatsAppSendersResponse = {
  enabled: boolean;
  canManage: boolean;
  safeReason: string | null;
  senders: WhatsAppSenderSummary[];
};

export type WhatsAppConnectionIntentResponse = {
  intentId: string;
  state: string;
  expiresAt: string;
};

export type CompleteWhatsAppConnectionInput = {
  state: string;
  code: string;
  businessId: string | null;
  wabaId: string;
  phoneNumberId: string;
};

export type WhatsAppBranchSenderSummary = Pick<
  WhatsAppSenderSummary,
  | "id"
  | "providerMode"
  | "displayPhoneNumber"
  | "verifiedName"
  | "qualityRating"
  | "status"
  | "phoneRegisteredAt"
  | "webhookSubscribedAt"
>;

export type WhatsAppBranchAssignment = {
  branchId: string;
  sender: WhatsAppBranchSenderSummary | null;
  defaultLanguage: string;
  defaultTone: string;
  automationEnabled: false;
};

export type WhatsAppBranchAssignmentResponse = {
  enabled: boolean;
  canManage: boolean;
  safeReason: string | null;
  assignment: WhatsAppBranchAssignment | null;
  availableSenders: WhatsAppBranchSenderSummary[];
};

export const WHATSAPP_AUTOMATION_STAGES = [
  "WELCOME",
  "FEE_DUE_MINUS_7",
  "FEE_DUE_MINUS_3",
  "FEE_DUE_MINUS_1",
  "FEE_DUE_TODAY",
  "PAST_DUE_PLUS_1",
  "PAST_DUE_PLUS_3",
  "PAST_DUE_PLUS_7",
  "PAYMENT_CONFIRMATION",
  "PAYMENT_CORRECTION",
] as const;

export type WhatsAppAutomationStage = (typeof WHATSAPP_AUTOMATION_STAGES)[number];
export type WhatsAppManagedLanguage = "en_IN" | "hi";
export type WhatsAppManagedTemplateProvisioningStatus =
  | "PENDING"
  | "CREATING"
  | "WAITING_APPROVAL"
  | "READY"
  | "REJECTED"
  | "FAILED"
  | "UNKNOWN";

export type WhatsAppManagedTemplateInstallation = {
  catalogVersion: 1;
  languages: WhatsAppManagedLanguage[];
  templates: Array<{
    managedKey: string;
    language: WhatsAppManagedLanguage;
    providerTemplateName: string;
    providerTemplateId: string | null;
    status: WhatsAppManagedTemplateProvisioningStatus;
    active: boolean;
    errorCode: string | null;
    providerCategory: string | null;
    providerStatus: string | null;
    lastSyncedAt: string | null;
  }>;
};

export type WhatsAppBranchSettings = {
  branchId: string;
  enabled: boolean;
  automationEnabled: boolean;
  automationEnabledAt: string | null;
  defaultLanguage: WhatsAppManagedLanguage;
  defaultTone: "polite" | "friendly" | "firm";
  sendTimeLocal: string;
  dailyAutomaticMessageLimit: number;
  maxAutomaticCollectionMessagesPerCycle: number;
  configurationRevision: number;
  monthlyBudgetMinor: number | null;
  timeZone: string;
  sender: {
    id: string;
    status: WhatsAppSenderStatus;
    providerMode: "TEST" | "LIVE";
    displayPhoneNumber: string;
    lastHealthCheckAt: string | null;
  } | null;
  rules: Array<{ stage: WhatsAppAutomationStage; enabled: boolean }>;
  templateHealth: Array<{
    managedKey: string;
    active: boolean;
    template: {
      providerStatus: string;
      category: string;
      staleAt: string | null;
    };
  }>;
  budget: {
    month: string;
    ceilingMicros: string | null;
    reservedMicros: string;
    committedMicros: string;
    reservedAndCommittedMicros: string;
    remainingMicros: string | null;
  };
  consentCoverage: {
    activeStudents: number;
    missingPhone: number;
    associated: number;
    optedIn: number;
    optedOut: number;
    stale: number;
    recipientStatusCounts: Partial<Record<"ACTIVE" | "STALE" | "DISABLED", number>>;
  };
  deliveryHealth: Record<string, number>;
  deliveryHealthWindowDays: number;
  lastWebhookReceivedAt: string | null;
  lastPlannedAt: string | null;
  lastPlannerErrorCode: string | null;
};

export type WhatsAppBranchSettingsUpdate = Partial<{
  defaultLanguage: WhatsAppManagedLanguage;
  defaultTone: "polite" | "friendly" | "firm";
  sendTimeLocal: string;
  dailyAutomaticMessageLimit: number;
  maxAutomaticCollectionMessagesPerCycle: number;
  monthlyBudgetMinor: number | null;
  rules: Array<{ stage: WhatsAppAutomationStage; enabled: boolean }>;
}>;

export type WhatsAppRecipientRelationship = "SELF" | "GUARDIAN" | "OTHER";
export type WhatsAppConsentSource =
  | "IN_PERSON"
  | "REGISTRATION_FORM"
  | "IMPORT_ATTESTATION"
  | "WHATSAPP_REPLY"
  | "OWNER_CONFIGURATION"
  | "SYSTEM";

export type WhatsAppRecipientMutationResult = {
  recipient: {
    id: string;
    studentId: string;
    relationship: WhatsAppRecipientRelationship;
    status: "ACTIVE" | "STALE" | "DISABLED";
  };
  changed: boolean;
  consentChanged: boolean;
};

export type WhatsAppStudentRecipientState = {
  studentId: string;
  studentStatus: "ACTIVE" | "INACTIVE";
  /** @deprecated Use studentMaskedPhone. Kept for response compatibility. */
  maskedPhone: string | null;
  studentMaskedPhone: string | null;
  assignedSender: {
    id: string;
    status: WhatsAppSenderStatus;
    verifiedName: string | null;
    maskedPhone: string | null;
  } | null;
  recipient: {
    id: string;
    studentId: string;
    relationship: WhatsAppRecipientRelationship;
    status: "ACTIVE" | "STALE" | "DISABLED";
    consentStatus: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT";
    consentType: "OPERATIONAL" | "UNKNOWN";
    policyVersion: string | null;
    maskedPhone: string | null;
    phoneMatchesCurrentStudent: boolean;
    consentSource: WhatsAppConsentSource;
    consentRecordedAt: string | null;
    verifiedAt: string;
    staleAt: string | null;
    disabledAt: string | null;
  } | null;
};

export type WhatsAppBulkRecipientSkipReason =
  | "STUDENT_INACTIVE"
  | "NO_PHONE"
  | "INVALID_PHONE";

export type WhatsAppBulkRecipientResult = {
  requestedCount: number;
  associatedCount: number;
  unchangedCount: number;
  skipped: Array<{ studentId: string; reason: WhatsAppBulkRecipientSkipReason }>;
};

export type WhatsAppPaymentReminderSuppressionReason =
  | "STUDENT_INACTIVE"
  | "PAYMENT_NOT_DUE"
  | "PAYMENT_ALREADY_RESOLVED"
  | "NO_PHONE"
  | "INVALID_PHONE"
  | "NO_RECIPIENT_ASSOCIATION"
  | "CONSENT_UNKNOWN"
  | "CONSENT_OPTED_OUT"
  | "SENDER_UNAVAILABLE"
  | "BRANCH_DISABLED"
  | "TEMPLATE_UNAVAILABLE"
  | "BUDGET_UNAVAILABLE"
  | "RATE_UNAVAILABLE"
  | "DESTINATION_UNSUPPORTED";

export type WhatsAppPaymentReminderPreview = {
  selectedPaymentCount: number;
  eligibleRecipientCount: number;
  suppressedCount: number;
  estimatedCostMicros: string;
  rateCardVersion: string | null;
  currency: "INR";
  groups: Array<{
    maskedPhone: string;
    paymentCount: number;
    studentCount: number;
    studentName: string;
    managedTemplateKey: string;
    renderedPreview: string;
    scheduledFor: string;
  }>;
  suppressed: Array<{
    paymentId: string;
    reason: WhatsAppPaymentReminderSuppressionReason;
  }>;
  estimateDisclaimer: string;
};

export type WhatsAppManualQueueResult = {
  replayed: boolean;
  request: {
    id: string;
    status: "PENDING" | "QUEUED" | "PARTIAL" | "COMPLETED" | "FAILED";
    selectedPaymentCount: number;
    eligibleRecipientCount: number;
    queuedMessageCount: number;
    suppressedCount: number;
    estimatedCostMicros: string;
    createdAt: string;
    completedAt: string | null;
  };
  preview?: WhatsAppPaymentReminderPreview;
};

export type WhatsAppMessageHistoryItem = {
  id: string;
  student: { id: string; name: string } | null;
  maskedPhone: string;
  purpose: string;
  trigger: "MANUAL" | "AUTOMATION";
  automationStage: WhatsAppAutomationStage | null;
  managedTemplateKey: string | null;
  template: { name: string; language: string } | null;
  status: string;
  scheduledFor: string;
  submissionStartedAt: string | null;
  acceptedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  safeFailureCode: string | null;
  estimatedCostMicros: string | null;
  providerBillable: boolean | null;
  providerPricingCategory: string | null;
  createdBy: { id: string; name: string | null } | null;
  payments?: Array<{
    id: string;
    status: string;
    amount: number;
    dueDate: string;
  }>;
  paymentResolutionEvent?: {
    id: string;
    source: string;
    fromStatus: string;
    toStatus: string;
    occurredAt: string;
  };
  createdAt: string;
};

export type WhatsAppMessageHistoryResponse = {
  items: WhatsAppMessageHistoryItem[];
  nextCursor: string | null;
  total: number;
};

function organizationBase(organizationId: string) {
  return `/organizations/${encodeURIComponent(organizationId)}/whatsapp`;
}

function senderBase(organizationId: string, senderId: string) {
  return `${organizationBase(organizationId)}/senders/${encodeURIComponent(senderId)}`;
}

function branchBase(branchId: string) {
  return `/branches/${encodeURIComponent(branchId)}/whatsapp`;
}

function mutationHeaders() {
  return { "Idempotency-Key": crypto.randomUUID() };
}

export const whatsapp = {
  getBrowserConfig(organizationId: string): Promise<WhatsAppBrowserConfig> {
    return apiClient.get(`${organizationBase(organizationId)}/config`);
  },

  listSenders(organizationId: string): Promise<WhatsAppSendersResponse> {
    return apiClient.get(`${organizationBase(organizationId)}/senders`);
  },

  createConnectionIntent(
    organizationId: string
  ): Promise<WhatsAppConnectionIntentResponse> {
    return apiClient.post(`${organizationBase(organizationId)}/connection-intents`);
  },

  completeConnection(
    organizationId: string,
    intentId: string,
    input: CompleteWhatsAppConnectionInput
  ): Promise<{ senderId: string; status: WhatsAppSenderStatus; replay: boolean }> {
    return apiClient.post(
      `${organizationBase(organizationId)}/connection-intents/${encodeURIComponent(intentId)}/complete`,
      input
    );
  },

  registerSender(
    organizationId: string,
    senderId: string,
    pin: string
  ): Promise<{ senderId: string; status: WhatsAppSenderStatus; changed: boolean }> {
    return apiClient.post(
      `${senderBase(organizationId, senderId)}/register`,
      { pin },
      { headers: mutationHeaders() }
    );
  },

  syncTemplates(
    organizationId: string,
    senderId: string
  ): Promise<{ total: number; created: number; updated: number; stale: number }> {
    return apiClient.post(
      `${senderBase(organizationId, senderId)}/templates/sync`,
      null,
      { headers: mutationHeaders() }
    );
  },

  disconnectSender(
    organizationId: string,
    senderId: string
  ): Promise<{ senderId: string; changed: boolean; unassignedBranches?: number }> {
    return apiClient.post(
      `${senderBase(organizationId, senderId)}/disconnect`,
      null,
      { headers: mutationHeaders() }
    );
  },

  getBranchAssignment(
    organizationId: string,
    branchId: string
  ): Promise<WhatsAppBranchAssignmentResponse> {
    const query = new URLSearchParams({ branchId });
    return apiClient.get(
      `${organizationBase(organizationId)}/branch-assignments?${query.toString()}`
    );
  },

  assignBranch(
    organizationId: string,
    branchId: string,
    senderId: string
  ): Promise<{ branchId: string; senderId: string; changed: boolean }> {
    return apiClient.put(
      `${organizationBase(organizationId)}/branch-assignments`,
      { branchId, senderId },
      { headers: mutationHeaders() }
    );
  },

  unassignBranch(
    organizationId: string,
    branchId: string
  ): Promise<{ branchId: string; changed: boolean }> {
    return apiClient.delete(`${organizationBase(organizationId)}/branch-assignments`, {
      data: { branchId },
      headers: mutationHeaders(),
    });
  },

  installManagedTemplates(
    organizationId: string,
    senderId: string,
    languages: readonly WhatsAppManagedLanguage[]
  ): Promise<{ installation: WhatsAppManagedTemplateInstallation }> {
    return apiClient.post(
      `${senderBase(organizationId, senderId)}/managed-templates/install`,
      { languages: [...languages], catalogVersion: 1 },
      { headers: mutationHeaders() }
    );
  },

  getManagedTemplateStatus(
    organizationId: string,
    senderId: string
  ): Promise<{ installation: WhatsAppManagedTemplateInstallation }> {
    return apiClient.get(
      `${senderBase(organizationId, senderId)}/managed-templates/install`
    );
  },

  getBranchSettings(branchId: string): Promise<WhatsAppBranchSettings> {
    return apiClient.get(`${branchBase(branchId)}/settings`);
  },

  updateBranchSettings(
    branchId: string,
    changes: WhatsAppBranchSettingsUpdate
  ): Promise<{ updated: true }> {
    return apiClient.patch(`${branchBase(branchId)}/settings`, changes, {
      headers: mutationHeaders(),
    });
  },

  setBranchDelivery(branchId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    return apiClient.post(
      `${branchBase(branchId)}/delivery/${enabled ? "enable" : "disable"}`,
      null,
      { headers: mutationHeaders() }
    );
  },

  setBranchAutomation(
    branchId: string,
    enabled: boolean
  ): Promise<{ enabled: boolean; prospectiveFrom?: string }> {
    return apiClient.post(
      `${branchBase(branchId)}/automation/${enabled ? "enable" : "disable"}`,
      enabled ? { confirmChargesAndProspectiveAutomation: true } : null,
      { headers: mutationHeaders() }
    );
  },

  associateRecipient(
    branchId: string,
    input: {
      studentId: string;
      relationship: WhatsAppRecipientRelationship;
      attestation: true;
    }
  ): Promise<WhatsAppRecipientMutationResult> {
    return apiClient.post(`${branchBase(branchId)}/recipients`, input, {
      headers: mutationHeaders(),
    });
  },

  getStudentRecipient(
    branchId: string,
    studentId: string
  ): Promise<WhatsAppStudentRecipientState> {
    return apiClient.get(
      `${branchBase(branchId)}/recipients/student/${encodeURIComponent(studentId)}`
    );
  },

  associateRecipientsBulk(
    branchId: string,
    recipients: ReadonlyArray<{
      studentId: string;
      relationship: WhatsAppRecipientRelationship;
    }>
  ): Promise<WhatsAppBulkRecipientResult> {
    return apiClient.post(
      `${branchBase(branchId)}/recipients/bulk`,
      { recipients: [...recipients], attestation: true },
      { headers: mutationHeaders() }
    );
  },

  disableRecipient(
    branchId: string,
    recipientId: string
  ): Promise<{
    recipientId: string;
    changed: boolean;
    disabledCount: number;
    cancelledMessageCount: number;
  }> {
    return apiClient.delete(
      `${branchBase(branchId)}/recipients/${encodeURIComponent(recipientId)}`,
      { headers: mutationHeaders() }
    );
  },

  previewPaymentReminders(
    branchId: string,
    paymentIds: readonly string[]
  ): Promise<WhatsAppPaymentReminderPreview> {
    return apiClient.post(
      `${branchBase(branchId)}/payment-reminders/preview`,
      { paymentIds: [...paymentIds] },
      { headers: mutationHeaders() }
    );
  },

  queuePaymentReminders(
    branchId: string,
    paymentIds: readonly string[],
    idempotencyKey: string
  ): Promise<WhatsAppManualQueueResult> {
    return apiClient.post(
      `${branchBase(branchId)}/payment-reminders`,
      { paymentIds: [...paymentIds] },
      { headers: { "Idempotency-Key": idempotencyKey } }
    );
  },

  getMessageHistory(
    branchId: string,
    input: { cursor?: string | null; limit?: number } = {}
  ): Promise<WhatsAppMessageHistoryResponse> {
    const query = new URLSearchParams();
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return apiClient.get(`${branchBase(branchId)}/messages${suffix}`);
  },
};
