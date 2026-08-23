"use client";

import { useEffect, useState } from "react";
import { AppButton } from "@/components/ui/AppButton";
import { Dialog } from "@/components/ui/Dialog";
import { FormField } from "@/components/ui/FormField";
import { SettingsInput } from "@/components/settings/SettingsWorkspace";

const META_REGISTRATION_PIN_PATTERN = /^[0-9]{6}$/;

export function isValidMetaRegistrationPin(value: string) {
  return META_REGISTRATION_PIN_PATTERN.test(value);
}

export function RegisterPhoneDialog({
  open,
  senderLabel,
  onClose,
  onRegister,
}: {
  open: boolean;
  senderLabel: string;
  onClose: () => void;
  onRegister: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setPin("");
    setSubmitted(false);
    setRequestError(null);
  }, [open]);

  const close = () => {
    if (loading) return;
    setPin("");
    setSubmitted(false);
    setRequestError(null);
    onClose();
  };

  const register = async () => {
    setSubmitted(true);
    setRequestError(null);
    if (!isValidMetaRegistrationPin(pin) || loading) return;

    const submittedPin = pin;
    setPin("");
    setLoading(true);
    try {
      await onRegister(submittedPin);
      setSubmitted(false);
      onClose();
    } catch {
      setRequestError("Registration could not be completed. Confirm the PIN and try again.");
    } finally {
      setLoading(false);
    }
  };

  const pinError = submitted && !isValidMetaRegistrationPin(pin)
    ? "Enter exactly six ASCII digits."
    : requestError;

  return (
    <Dialog
      open={open}
      onClose={close}
      role="dialog"
      title="Complete phone registration"
      description={`Enter the six-digit Meta registration PIN for ${senderLabel}. This is not a one-time password.`}
      closeLabel="Close phone registration"
      closeDisabled={loading}
      className="max-w-md"
      footer={(
        <>
          <AppButton variant="quiet" onClick={close} disabled={loading}>
            Cancel
          </AppButton>
          <AppButton
            variant="primary"
            onClick={() => void register()}
            isLoading={loading}
          >
            Register phone
          </AppButton>
        </>
      )}
    >
      <FormField
        label="Meta registration PIN"
        description="Exactly six digits. The PIN is sent only for this registration request and is not saved by Lab Lords."
        error={pinError}
        required
      >
        <SettingsInput
          data-dialog-initial-focus
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          value={pin}
          disabled={loading}
          onChange={event => {
            setPin(event.target.value.replace(/[^0-9]/g, "").slice(0, 6));
            if (submitted) setSubmitted(false);
            if (requestError) setRequestError(null);
          }}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              void register();
            }
          }}
          error={pinError}
        />
      </FormField>
    </Dialog>
  );
}
