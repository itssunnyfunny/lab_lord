export type WhatsAppBrowserConfig = {
  enabled: boolean;
  providerMode: "TEST" | "LIVE" | null;
  appId: string | null;
  embeddedSignupConfigId: string | null;
  graphApiVersion: string | null;
  connectionAvailability: "AVAILABLE" | "DISABLED" | "UNAVAILABLE";
  safeReason: string | null;
};

export type MetaWaba = {
  id: string;
  name: string | null;
  currency: string | null;
  timezoneId: string | null;
  accountMode: string | null;
};

export type MetaPhoneNumber = {
  id: string;
  wabaId: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string | null;
  codeVerificationStatus: string | null;
  platformType: string | null;
  status: string | null;
  registrationStatus: string | null;
};

export type MetaDebugToken = {
  appId: string;
  isValid: boolean;
  expiresAt: Date | null;
  scopes: string[];
  granularScopes: Array<{ scope: string; targetIds: string[] }>;
};

export type MetaAssignedSystemUser = {
  id: string;
  name: string | null;
  tasks: string[];
};

export type MetaSubscribedApp = {
  id: string;
  name: string | null;
};

export type MetaMessageTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: unknown[];
};
