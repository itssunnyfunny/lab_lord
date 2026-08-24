import { afterEach, describe, expect, it } from "vitest";
import {
  areWhatsAppMessageWritesEnabled,
  areWhatsAppOnboardingWritesEnabled,
  areWhatsAppTemplateWritesEnabled,
  configuredWhatsAppLiveDeliveryCanaryOrganizationIds,
  isWhatsAppAutomationPlannerEnabled,
  isWhatsAppDeliverySchemaAccessEnabled,
  isWhatsAppIntegrationEnabled,
  isWhatsAppWebhookIngestEnabled,
  resolveWhatsAppProviderMode,
  WhatsAppConfigurationError,
} from "@/lib/whatsappFeature";

const BASE_ENV = {
  NODE_ENV: "production",
  VERCEL_ENV: "production",
  META_WHATSAPP_MODE: "LIVE",
  WHATSAPP_INTEGRATION_ENABLED: "true",
} as const;

describe("WhatsApp feature gates", () => {
  afterEach(() => {
    // Every helper accepts an explicit environment; process state remains untouched.
  });

  it("fails closed when flags are absent", () => {
    expect(isWhatsAppIntegrationEnabled({})).toBe(false);
    expect(isWhatsAppWebhookIngestEnabled({})).toBe(false);
    expect(areWhatsAppOnboardingWritesEnabled("org_1", {
      NODE_ENV: "development",
      META_WHATSAPP_MODE: "TEST",
    })).toBe(false);
    expect(areWhatsAppTemplateWritesEnabled("org_1", {
      NODE_ENV: "test",
      META_WHATSAPP_MODE: "TEST",
    })).toBe(false);
    expect(areWhatsAppMessageWritesEnabled("org_1", {
      NODE_ENV: "test",
      META_WHATSAPP_MODE: "TEST",
    })).toBe(false);
    expect(isWhatsAppAutomationPlannerEnabled({
      NODE_ENV: "test",
      META_WHATSAPP_MODE: "TEST",
    })).toBe(false);
  });

  it("requires the independent webhook ingest gate", () => {
    expect(isWhatsAppWebhookIngestEnabled(BASE_ENV)).toBe(false);
    expect(isWhatsAppWebhookIngestEnabled({
      ...BASE_ENV,
      WHATSAPP_WEBHOOK_INGEST_ENABLED: "true",
    })).toBe(true);
  });

  it("allows explicitly gated Test onboarding writes", () => {
    expect(areWhatsAppOnboardingWritesEnabled("org_1", {
      NODE_ENV: "test",
      VERCEL_ENV: "preview",
      META_WHATSAPP_MODE: "TEST",
      WHATSAPP_INTEGRATION_ENABLED: "true",
      WHATSAPP_META_ONBOARDING_WRITES_ENABLED: "true",
    })).toBe(true);
  });

  it("grants gated Live production writes only to an exact canary organization", () => {
    const env = {
      ...BASE_ENV,
      WHATSAPP_META_ONBOARDING_WRITES_ENABLED: "true",
      WHATSAPP_LIVE_CANARY_ORG_IDS: "org_1, org_20",
    };
    expect(areWhatsAppOnboardingWritesEnabled("org_1", env)).toBe(true);
    expect(areWhatsAppOnboardingWritesEnabled("org_2", env)).toBe(false);
    expect(areWhatsAppOnboardingWritesEnabled("", env)).toBe(false);
  });

  it("does not grant malformed or empty canary entries", () => {
    expect(areWhatsAppOnboardingWritesEnabled("org 1", {
      ...BASE_ENV,
      WHATSAPP_META_ONBOARDING_WRITES_ENABLED: "true",
      WHATSAPP_LIVE_CANARY_ORG_IDS: " ,org 1,https://example.com",
    })).toBe(false);
  });

  it("treats the onboarding writes flag as a kill switch even for a Live canary", () => {
    expect(areWhatsAppOnboardingWritesEnabled("org_1", {
      ...BASE_ENV,
      WHATSAPP_META_ONBOARDING_WRITES_ENABLED: "false",
      WHATSAPP_LIVE_CANARY_ORG_IDS: "org_1",
    })).toBe(false);
  });

  it("keeps template, message, and planner gates independent in Test mode", () => {
    const env = {
      NODE_ENV: "test",
      VERCEL_ENV: "preview",
      META_WHATSAPP_MODE: "TEST",
      WHATSAPP_INTEGRATION_ENABLED: "true",
      WHATSAPP_META_TEMPLATE_WRITES_ENABLED: "true",
    };
    expect(areWhatsAppTemplateWritesEnabled("org_1", env)).toBe(true);
    expect(areWhatsAppMessageWritesEnabled("org_1", env)).toBe(false);
    expect(isWhatsAppAutomationPlannerEnabled(env)).toBe(false);

    expect(isWhatsAppAutomationPlannerEnabled({
      ...env,
      WHATSAPP_META_TEMPLATE_WRITES_ENABLED: "false",
      WHATSAPP_AUTOMATION_PLANNER_ENABLED: "true",
    })).toBe(true);
  });

  it("opens PR3 schema access only when integration and at least one PR3 flag are enabled", () => {
    const base = {
      NODE_ENV: "test",
      META_WHATSAPP_MODE: "TEST",
      WHATSAPP_INTEGRATION_ENABLED: "true",
    };
    expect(isWhatsAppDeliverySchemaAccessEnabled(base)).toBe(false);
    expect(isWhatsAppDeliverySchemaAccessEnabled({
      ...base,
      WHATSAPP_META_TEMPLATE_WRITES_ENABLED: "true",
    })).toBe(true);
    expect(isWhatsAppDeliverySchemaAccessEnabled({
      ...base,
      WHATSAPP_META_MESSAGE_WRITES_ENABLED: "true",
    })).toBe(true);
    expect(isWhatsAppDeliverySchemaAccessEnabled({
      ...base,
      WHATSAPP_AUTOMATION_PLANNER_ENABLED: "true",
    })).toBe(true);
    expect(isWhatsAppDeliverySchemaAccessEnabled({
      ...base,
      WHATSAPP_INTEGRATION_ENABLED: "false",
      WHATSAPP_META_MESSAGE_WRITES_ENABLED: "true",
    })).toBe(false);
  });

  it("exposes only the validated exact Live delivery canary set", () => {
    expect([...configuredWhatsAppLiveDeliveryCanaryOrganizationIds({
      WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS: "org_2,org_1",
    })].sort()).toEqual(["org_1", "org_2"]);
    expect(configuredWhatsAppLiveDeliveryCanaryOrganizationIds({
      WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS: "org_1,not valid",
    }).size).toBe(0);
    expect(configuredWhatsAppLiveDeliveryCanaryOrganizationIds({
      WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS: "org_1,org_1",
    }).size).toBe(0);
  });

  it("requires the separate exact Live delivery canary for template and message writes", () => {
    const env = {
      ...BASE_ENV,
      WHATSAPP_META_TEMPLATE_WRITES_ENABLED: "true",
      WHATSAPP_META_MESSAGE_WRITES_ENABLED: "true",
      WHATSAPP_LIVE_CANARY_ORG_IDS: "org_wrong_boundary",
      WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS: "org_1,org_20",
    };
    expect(areWhatsAppTemplateWritesEnabled("org_1", env)).toBe(true);
    expect(areWhatsAppMessageWritesEnabled("org_1", env)).toBe(true);
    expect(areWhatsAppTemplateWritesEnabled("org_2", env)).toBe(false);
    expect(areWhatsAppMessageWritesEnabled("org_2", env)).toBe(false);
  });

  it("lets one malformed delivery-canary entry hold every Live provider write", () => {
    const env = {
      ...BASE_ENV,
      WHATSAPP_META_TEMPLATE_WRITES_ENABLED: "true",
      WHATSAPP_META_MESSAGE_WRITES_ENABLED: "true",
      WHATSAPP_LIVE_DELIVERY_CANARY_ORG_IDS: "org_1,not valid",
    };
    expect(areWhatsAppTemplateWritesEnabled("org_1", env)).toBe(false);
    expect(areWhatsAppMessageWritesEnabled("org_1", env)).toBe(false);
  });

  it("does not let the planner flag independently authorize provider delivery", () => {
    const env = {
      ...BASE_ENV,
      WHATSAPP_AUTOMATION_PLANNER_ENABLED: "true",
    };
    expect(isWhatsAppAutomationPlannerEnabled(env)).toBe(true);
    expect(areWhatsAppTemplateWritesEnabled("org_1", env)).toBe(false);
    expect(areWhatsAppMessageWritesEnabled("org_1", env)).toBe(false);
  });

  it("rejects Production/Test and Preview/Live mismatches", () => {
    expect(() => resolveWhatsAppProviderMode({
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      META_WHATSAPP_MODE: "TEST",
    })).toThrow(WhatsAppConfigurationError);
    expect(() => resolveWhatsAppProviderMode({
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
      META_WHATSAPP_MODE: "LIVE",
    })).toThrow(WhatsAppConfigurationError);
  });

  it("requires explicit mode and keeps local development in Test", () => {
    expect(() => resolveWhatsAppProviderMode({ NODE_ENV: "development" })).toThrow(
      WhatsAppConfigurationError
    );
    expect(resolveWhatsAppProviderMode({
      NODE_ENV: "development",
      META_WHATSAPP_MODE: "TEST",
    })).toBe("TEST");
    expect(() => resolveWhatsAppProviderMode({
      NODE_ENV: "development",
      META_WHATSAPP_MODE: "LIVE",
    })).toThrow(WhatsAppConfigurationError);
    expect(() => resolveWhatsAppProviderMode({
      NODE_ENV: "development",
      VERCEL_ENV: "development",
      META_WHATSAPP_MODE: "LIVE",
    })).toThrow(WhatsAppConfigurationError);
  });
});
