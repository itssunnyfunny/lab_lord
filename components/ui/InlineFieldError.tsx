"use client";

import { useCallback, useState } from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type ErrorMap<K extends string> = Partial<Record<K, string>>;
type TouchedMap<K extends string> = Partial<Record<K, boolean>>;

export function FieldError({
    id,
    error,
    className,
}: {
    id?: string;
    error?: string | null;
    className?: string;
}) {
    if (!error) return null;

    return (
        <p id={id} role="alert" className={cn("mt-1.5 flex items-start gap-1.5 text-xs text-[color:var(--ui-form-error-text)]", className)}>
            <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
        </p>
    );
}

export function fieldErrorClass(error?: string | null) {
    return error
        ? "border-[color:var(--ui-form-error-border)] focus:border-[color:var(--ui-form-error-focus-border)] focus:ring-[color:var(--ui-form-error-ring)]"
        : "";
}

export function fieldErrorProps(id: string, error?: string | null) {
    return {
        "aria-invalid": Boolean(error),
        "aria-describedby": error ? id : undefined,
    };
}

export function useInlineFieldErrors<K extends string>() {
    const [submitted, setSubmitted] = useState(false);
    const [touched, setTouched] = useState<TouchedMap<K>>({});

    const markTouched = useCallback((field: K) => {
        setTouched(prev => ({ ...prev, [field]: true }));
    }, []);

    const markSubmitted = useCallback(() => {
        setSubmitted(true);
    }, []);

    const resetFieldErrors = useCallback(() => {
        setSubmitted(false);
        setTouched({});
    }, []);

    const visibleError = useCallback((field: K, errors: ErrorMap<K>) => {
        return submitted || touched[field] ? errors[field] : undefined;
    }, [submitted, touched]);

    return {
        submitted,
        touched,
        markTouched,
        markSubmitted,
        resetFieldErrors,
        visibleError,
    };
}
