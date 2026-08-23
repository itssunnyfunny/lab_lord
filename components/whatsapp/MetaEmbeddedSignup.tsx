"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppButton } from "@/components/ui/AppButton";
import { whatsapp } from "@/lib/api/whatsapp";

export const META_FACEBOOK_SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
const META_EVENT_MAX_LENGTH = 16_384;
const META_ID_PATTERN = /^[0-9]{1,64}$/;

type MetaSignupFinish = {
  type: "WA_EMBEDDED_SIGNUP";
  event: "FINISH";
  data: {
    businessId: string | null;
    wabaId: string;
    phoneNumberId: string;
  };
};

type MetaSignupCancel = {
  type: "WA_EMBEDDED_SIGNUP";
  event: "CANCEL";
};

type MetaSignupError = {
  type: "WA_EMBEDDED_SIGNUP";
  event: "ERROR";
};

export type MetaEmbeddedSignupEvent =
  | MetaSignupFinish
  | MetaSignupCancel
  | MetaSignupError;

type FacebookLoginResponse = {
  authResponse?: { code?: unknown } | null;
};

type FacebookSdk = {
  init(options: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: Record<string, unknown>
  ): void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
  }
}

type AvailableMetaConfig = {
  appId: string;
  embeddedSignupConfigId: string;
  graphApiVersion: string;
};

type PreparedIntent = {
  intentId: string;
  rawState: string;
};

type LaunchPhase = "idle" | "preparing" | "prepared" | "launching" | "completing";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function isTrustedMetaOrigin(origin: string) {
  if (!origin || origin.length > 512) return false;

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:"
      && parsed.port === ""
      && parsed.origin === origin
      && (hostname === "facebook.com" || hostname.endsWith(".facebook.com"));
  } catch {
    return false;
  }
}

/** Accepts only a non-self browser window, and pins later events to the first source. */
export function isTrustedMetaMessageSource(
  source: MessageEventSource | null,
  currentWindow: Window | null,
  expectedSource: WindowProxy | null
): source is WindowProxy {
  if (!source || source === currentWindow) return false;
  if (expectedSource) return source === expectedSource;

  try {
    const possibleWindow = source as WindowProxy;
    return typeof possibleWindow.closed === "boolean"
      && typeof possibleWindow.postMessage === "function";
  } catch {
    return false;
  }
}

export function parseMetaEmbeddedSignupEvent(
  rawData: unknown
): MetaEmbeddedSignupEvent | null {
  if (typeof rawData !== "string" || rawData.length === 0 || rawData.length > META_EVENT_MAX_LENGTH) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["type", "event", "data"])) return null;
  if (parsed.type !== "WA_EMBEDDED_SIGNUP") return null;
  if (parsed.event !== "FINISH" && parsed.event !== "CANCEL" && parsed.event !== "ERROR") {
    return null;
  }
  if (!isRecord(parsed.data)) return null;

  if (parsed.event === "CANCEL") {
    if (!hasOnlyKeys(parsed.data, ["current_step"])) return null;
    if (parsed.data.current_step !== undefined && !boundedString(parsed.data.current_step, 256)) {
      return null;
    }
    return { type: "WA_EMBEDDED_SIGNUP", event: "CANCEL" };
  }

  if (parsed.event === "ERROR") {
    if (!hasOnlyKeys(parsed.data, ["error_message"])) return null;
    if (parsed.data.error_message !== undefined && !boundedString(parsed.data.error_message, 512)) {
      return null;
    }
    return { type: "WA_EMBEDDED_SIGNUP", event: "ERROR" };
  }

  if (!hasOnlyKeys(parsed.data, ["business_id", "waba_id", "phone_number_id"])) return null;
  const businessId = parsed.data.business_id;
  const wabaId = parsed.data.waba_id;
  const phoneNumberId = parsed.data.phone_number_id;
  if (businessId !== undefined && businessId !== null && (
    typeof businessId !== "string" || !META_ID_PATTERN.test(businessId)
  )) return null;
  if (typeof wabaId !== "string" || !META_ID_PATTERN.test(wabaId)) return null;
  if (typeof phoneNumberId !== "string" || !META_ID_PATTERN.test(phoneNumberId)) return null;

  return {
    type: "WA_EMBEDDED_SIGNUP",
    event: "FINISH",
    data: {
      businessId: typeof businessId === "string" ? businessId : null,
      wabaId,
      phoneNumberId,
    },
  };
}

export function MetaEmbeddedSignup({
  organizationId,
  config,
  disabled = false,
  disabledReason,
  onConnected,
}: {
  organizationId: string;
  config: AvailableMetaConfig;
  disabled?: boolean;
  disabledReason?: string | null;
  onConnected: () => void | Promise<void>;
}) {
  const [phase, setPhase] = useState<LaunchPhase>("idle");
  const [sdkReady, setSdkReady] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "status" | "error";
    message: string;
  } | null>(null);
  const preparedIntentRef = useRef<PreparedIntent | null>(null);
  const codeRef = useRef<string | null>(null);
  const sessionRef = useRef<MetaSignupFinish["data"] | null>(null);
  const metaSourceRef = useRef<WindowProxy | null>(null);
  const prepareStartedRef = useRef(false);
  const launchStartedRef = useRef(false);
  const completionStartedRef = useRef(false);
  const connectedHandlerRef = useRef(onConnected);
  const mountedRef = useRef(true);

  useEffect(() => {
    connectedHandlerRef.current = onConnected;
  }, [onConnected]);

  const clearSensitiveAttempt = useCallback(() => {
    preparedIntentRef.current = null;
    codeRef.current = null;
    sessionRef.current = null;
    metaSourceRef.current = null;
    prepareStartedRef.current = false;
    launchStartedRef.current = false;
    completionStartedRef.current = false;
  }, []);

  const resetAttempt = useCallback((message?: string, tone: "status" | "error" = "status") => {
    clearSensitiveAttempt();
    if (!mountedRef.current) return;
    setPhase("idle");
    setNotice(message ? { tone, message } : null);
  }, [clearSensitiveAttempt]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      preparedIntentRef.current = null;
      codeRef.current = null;
      sessionRef.current = null;
      metaSourceRef.current = null;
      prepareStartedRef.current = false;
      launchStartedRef.current = false;
      completionStartedRef.current = false;
    };
  }, []);

  const completeWhenReady = useCallback(async () => {
    const intent = preparedIntentRef.current;
    const code = codeRef.current;
    const session = sessionRef.current;
    if (!intent || !code || !session || completionStartedRef.current) return;

    completionStartedRef.current = true;
    setPhase("completing");
    setNotice({ tone: "status", message: "Verifying the Meta connection securely..." });
    try {
      await whatsapp.completeConnection(organizationId, intent.intentId, {
        state: intent.rawState,
        code,
        businessId: session.businessId,
        wabaId: session.wabaId,
        phoneNumberId: session.phoneNumberId,
      });
      clearSensitiveAttempt();
      if (!mountedRef.current) return;
      setPhase("idle");
      setNotice({ tone: "status", message: "WhatsApp connection setup completed." });
      try {
        await connectedHandlerRef.current();
      } catch {
        if (mountedRef.current) {
          setNotice({
            tone: "status",
            message: "Connection completed. Refresh settings to load current readiness.",
          });
        }
      }
    } catch {
      resetAttempt(
        "Meta connection could not be verified. Start a new secure connection attempt.",
        "error"
      );
    }
  }, [clearSensitiveAttempt, organizationId, resetAttempt]);

  const hasActiveAttempt = phase === "prepared"
    || phase === "launching"
    || phase === "completing";

  useEffect(() => {
    if (!hasActiveAttempt) return;

    const handleMetaMessage = (event: MessageEvent<unknown>) => {
      if (!isTrustedMetaOrigin(event.origin)) return;
      if (!isTrustedMetaMessageSource(event.source, window, metaSourceRef.current)) return;
      if (!launchStartedRef.current) return;

      const metaEvent = parseMetaEmbeddedSignupEvent(event.data);
      if (!metaEvent) return;
      if (!metaSourceRef.current) metaSourceRef.current = event.source;
      if (completionStartedRef.current) return;

      if (metaEvent.event === "CANCEL") {
        resetAttempt("Meta setup was cancelled. No connection was changed.");
        return;
      }
      if (metaEvent.event === "ERROR") {
        resetAttempt("Meta could not finish setup. Start a new secure connection attempt.", "error");
        return;
      }

      sessionRef.current = metaEvent.data;
      void completeWhenReady();
    };

    window.addEventListener("message", handleMetaMessage);
    return () => window.removeEventListener("message", handleMetaMessage);
  }, [completeWhenReady, hasActiveAttempt, resetAttempt]);

  const initializeSdk = useCallback(() => {
    const sdk = window.FB;
    if (!sdk) {
      setSdkReady(false);
      return;
    }
    sdk.init({
      appId: config.appId,
      autoLogAppEvents: false,
      xfbml: true,
      version: config.graphApiVersion,
    });
    setSdkReady(true);
  }, [config.appId, config.graphApiVersion]);

  const prepare = async () => {
    if (disabled || phase !== "idle" || prepareStartedRef.current) return;
    prepareStartedRef.current = true;
    setSdkReady(false);
    setPhase("preparing");
    setNotice({ tone: "status", message: "Preparing a secure one-time connection..." });
    try {
      const intent = await whatsapp.createConnectionIntent(organizationId);
      if (
        !boundedString(intent.intentId, 160)
        || !boundedString(intent.state, 512)
      ) {
        throw new Error("Invalid connection intent");
      }
      if (!mountedRef.current) return;
      clearSensitiveAttempt();
      preparedIntentRef.current = { intentId: intent.intentId, rawState: intent.state };
      setPhase("prepared");
      setNotice({
        tone: "status",
        message: "Secure connection prepared. Continue with Meta to choose the customer-owned number.",
      });
    } catch {
      resetAttempt("A secure connection could not be prepared. Please try again.", "error");
    }
  };

  const launch = () => {
    const sdk = window.FB;
    const intent = preparedIntentRef.current;
    if (
      phase !== "prepared"
      || !sdkReady
      || !sdk
      || !intent
      || launchStartedRef.current
    ) return;

    launchStartedRef.current = true;
    setPhase("launching");
    setNotice({ tone: "status", message: "Complete the customer-owned account selection in Meta." });
    try {
      sdk.login(response => {
        if (preparedIntentRef.current !== intent) return;
        const code = response.authResponse?.code;
        if (!boundedString(code, 4_096)) {
          resetAttempt("Meta setup was cancelled. No connection was changed.");
          return;
        }
        codeRef.current = code;
        void completeWhenReady();
      }, {
        config_id: config.embeddedSignupConfigId,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          sessionInfoVersion: "3",
        },
      });
    } catch {
      resetAttempt("Meta setup could not be opened. Start a new secure connection attempt.", "error");
    }
  };

  return (
    <div className="space-y-3 px-5 py-4" aria-label="Connect a customer-owned WhatsApp number">
      {hasActiveAttempt ? (
        <Script
          id="meta-facebook-jssdk"
          src={META_FACEBOOK_SDK_URL}
          strategy="afterInteractive"
          onLoad={initializeSdk}
          onReady={initializeSdk}
          onError={() => {
            setSdkReady(false);
            setNotice({
              tone: "error",
              message: "Meta setup could not be loaded. Cancel this attempt and try again.",
            });
          }}
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        {phase === "idle" ? (
          <AppButton
            variant="primary"
            onClick={() => void prepare()}
            disabled={disabled}
            title={disabled ? disabledReason ?? undefined : undefined}
          >
            Prepare Meta connection
          </AppButton>
        ) : null}
        {phase === "preparing" ? (
          <AppButton variant="primary" isLoading disabled>
            Preparing connection
          </AppButton>
        ) : null}
        {phase === "prepared" ? (
          <>
            <AppButton
              variant="primary"
              onClick={launch}
              disabled={!sdkReady}
            >
              {sdkReady ? "Continue with Meta" : "Loading Meta setup"}
            </AppButton>
            <AppButton variant="quiet" onClick={() => resetAttempt()}>
              Cancel setup
            </AppButton>
          </>
        ) : null}
        {phase === "launching" || phase === "completing" ? (
          <>
            <AppButton variant="primary" isLoading disabled>
              {phase === "completing" ? "Verifying connection" : "Waiting for Meta"}
            </AppButton>
            {phase === "launching" ? (
              <AppButton variant="quiet" onClick={() => resetAttempt()}>
                Cancel setup
              </AppButton>
            ) : null}
          </>
        ) : null}
      </div>

      {disabled && disabledReason ? (
        <p className="text-xs text-[color:var(--text-secondary)]">{disabledReason}</p>
      ) : null}
      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          aria-live={notice.tone === "error" ? "assertive" : "polite"}
          className={notice.tone === "error"
            ? "text-sm text-[color:var(--ui-form-error-text)]"
            : "text-sm text-[color:var(--text-secondary)]"}
        >
          {notice.message}
        </p>
      ) : null}
    </div>
  );
}
