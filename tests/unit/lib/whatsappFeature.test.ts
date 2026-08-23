import { afterEach, describe, expect, it } from "vitest";
import {
  areWhatsAppOnboardingWritesEnabled,
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
