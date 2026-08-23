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

function organizationBase(organizationId: string) {
  return `/organizations/${encodeURIComponent(organizationId)}/whatsapp`;
}

function senderBase(organizationId: string, senderId: string) {
  return `${organizationBase(organizationId)}/senders/${encodeURIComponent(senderId)}`;
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
};
