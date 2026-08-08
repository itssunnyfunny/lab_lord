"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";

export type UserDisplayPreferences = {
    densityPreference: "comfortable" | "compact";
    locale: string;
    timezone: string;
    dateFormat: "dd MMM yyyy" | "MMM dd, yyyy" | "yyyy-MM-dd";
};

const DEFAULT_PREFERENCES: UserDisplayPreferences = {
    densityPreference: "comfortable",
    locale: "en-IN",
    timezone: "Asia/Kolkata",
    dateFormat: "dd MMM yyyy",
};

const PREFERENCE_EVENT = "lablords:preferences-updated";

type UserPreferencesContextValue = UserDisplayPreferences & {
    formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
    formatDateTime: (value: Date | string | number) => string;
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
};

const UserPreferencesContext = createContext<UserPreferencesContextValue | null>(null);

function normalizePreferences(value: Partial<UserDisplayPreferences> | null | undefined): UserDisplayPreferences {
    return {
        densityPreference: value?.densityPreference === "compact" ? "compact" : "comfortable",
        locale: value?.locale || DEFAULT_PREFERENCES.locale,
        timezone: value?.timezone || DEFAULT_PREFERENCES.timezone,
        dateFormat: value?.dateFormat === "MMM dd, yyyy" || value?.dateFormat === "yyyy-MM-dd"
            ? value.dateFormat
            : "dd MMM yyyy",
    };
}

function defaultDateOptions(dateFormat: UserDisplayPreferences["dateFormat"]): Intl.DateTimeFormatOptions {
    if (dateFormat === "MMM dd, yyyy") {
        return { month: "short", day: "2-digit", year: "numeric" };
    }
    return { day: "2-digit", month: "short", year: "numeric" };
}

function formatIsoDate(date: Date, locale: string, timezone: string) {
    const parts = new Intl.DateTimeFormat(locale, {
        timeZone: timezone,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    }).formatToParts(date);
    const values = new Map(parts.map(part => [part.type, part.value]));
    return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export function notifyUserPreferencesChanged(preferences: Partial<UserDisplayPreferences>) {
    window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT, { detail: preferences }));
}

export function UserPreferencesProvider({ children }: { children: ReactNode }) {
    const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);

    useEffect(() => {
        let cancelled = false;

        fetch("/api/users/me", { cache: "no-store" })
            .then(response => response.ok ? response.json() as Promise<Partial<UserDisplayPreferences>> : null)
            .then(value => {
                if (!cancelled && value) setPreferences(normalizePreferences(value));
            })
            .catch(() => {
                // Defaults keep the authenticated shell usable when preferences are unavailable.
            });

        const handlePreferenceUpdate = (event: Event) => {
            const detail = (event as CustomEvent<Partial<UserDisplayPreferences>>).detail;
            setPreferences(current => normalizePreferences({ ...current, ...detail }));
        };
        window.addEventListener(PREFERENCE_EVENT, handlePreferenceUpdate);

        return () => {
            cancelled = true;
            window.removeEventListener(PREFERENCE_EVENT, handlePreferenceUpdate);
        };
    }, []);

    useEffect(() => {
        const root = document.documentElement;
        root.dataset.density = preferences.densityPreference;
        root.dataset.locale = preferences.locale;
        root.dataset.timezone = preferences.timezone;
        root.dataset.dateFormat = preferences.dateFormat;
        root.lang = preferences.locale.split("-")[0];
    }, [preferences]);

    const formatDate = useCallback((value: Date | string | number, options?: Intl.DateTimeFormatOptions) => {
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) return "Invalid date";
        if (!options && preferences.dateFormat === "yyyy-MM-dd") {
            return formatIsoDate(date, preferences.locale, preferences.timezone);
        }
        return new Intl.DateTimeFormat(preferences.locale, {
            timeZone: preferences.timezone,
            ...(options ?? defaultDateOptions(preferences.dateFormat)),
        }).format(date);
    }, [preferences.dateFormat, preferences.locale, preferences.timezone]);

    const formatDateTime = useCallback((value: Date | string | number) => {
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) return "Invalid date";
        return new Intl.DateTimeFormat(preferences.locale, {
            timeZone: preferences.timezone,
            ...defaultDateOptions(preferences.dateFormat),
            hour: "2-digit",
            minute: "2-digit",
        }).format(date);
    }, [preferences.dateFormat, preferences.locale, preferences.timezone]);

    const formatNumber = useCallback((value: number, options?: Intl.NumberFormatOptions) => (
        new Intl.NumberFormat(preferences.locale, options).format(value)
    ), [preferences.locale]);

    const value = useMemo<UserPreferencesContextValue>(() => ({
        ...preferences,
        formatDate,
        formatDateTime,
        formatNumber,
    }), [formatDate, formatDateTime, formatNumber, preferences]);

    return <UserPreferencesContext.Provider value={value}>{children}</UserPreferencesContext.Provider>;
}

/** Kept for compatibility; preference application now lives in the shell provider. */
export function UserPreferencesApplier() {
    useUserPreferences();
    return null;
}

export function useUserPreferences(): UserPreferencesContextValue {
    const value = useContext(UserPreferencesContext);
    if (!value) {
        return {
            ...DEFAULT_PREFERENCES,
            formatDate: input => new Intl.DateTimeFormat(DEFAULT_PREFERENCES.locale, defaultDateOptions(DEFAULT_PREFERENCES.dateFormat)).format(new Date(input)),
            formatDateTime: input => new Intl.DateTimeFormat(DEFAULT_PREFERENCES.locale, { ...defaultDateOptions(DEFAULT_PREFERENCES.dateFormat), hour: "2-digit", minute: "2-digit" }).format(new Date(input)),
            formatNumber: (input, options) => new Intl.NumberFormat(DEFAULT_PREFERENCES.locale, options).format(input),
        };
    }
    return value;
}
