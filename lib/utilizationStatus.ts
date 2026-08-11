export type UtilizationStatusKey = "underused" | "balanced" | "near_capacity" | "full";

export type UtilizationStatus = Readonly<{
    key: UtilizationStatusKey;
    label: "Underused" | "Balanced" | "Near capacity" | "Full";
    tone: "success" | "warning" | "danger";
}>;

const UNDERUSED: UtilizationStatus = {
    key: "underused",
    label: "Underused",
    tone: "warning",
};

const BALANCED: UtilizationStatus = {
    key: "balanced",
    label: "Balanced",
    tone: "success",
};

const NEAR_CAPACITY: UtilizationStatus = {
    key: "near_capacity",
    label: "Near capacity",
    tone: "warning",
};

const FULL: UtilizationStatus = {
    key: "full",
    label: "Full",
    tone: "danger",
};

/**
 * Classifies a utilization percentage using the shared product thresholds.
 * Values above 100 remain "Full" so over-capacity data is never presented as healthy.
 */
export function getUtilizationStatus(percent: number): UtilizationStatus {
    const value = Number.isFinite(percent) ? percent : 0;

    if (value >= 100) return FULL;
    if (value >= 80) return NEAR_CAPACITY;
    if (value >= 40) return BALANCED;
    return UNDERUSED;
}
