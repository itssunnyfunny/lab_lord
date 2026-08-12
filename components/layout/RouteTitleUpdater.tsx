"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const BRANCH_TITLES: Record<string, string> = {
    "": "Branch dashboard",
    students: "Students",
    seats: "Seats",
    shifts: "Shifts",
    allocations: "Seat allocations",
    payments: "Payments",
    overdue: "Overdue payments",
    analytics: "Branch analytics",
    staff: "Staff",
    settings: "Branch settings",
    onboarding: "Import students",
};

const AI_TITLES: Record<string, string> = {
    reports: "AI reports",
    messages: "AI messages",
};

function titleForPath(pathname: string) {
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] === "branch") {
        if (parts[2] === "ai") return AI_TITLES[parts[3] ?? ""] ?? "Branch AI";
        return BRANCH_TITLES[parts[2] ?? ""] ?? "Branch workspace";
    }
    if (parts[0] === "org") {
        if (parts[2] === "analytics") return "Organization analytics";
        if (parts[2] === "settings") return "Organization settings";
        if (parts[2] === "billing") return "Billing update";
        return "Organization overview";
    }
    if (parts[0] === "account") return "Account settings";
    return "Lab Lords";
}

export function RouteTitleUpdater() {
    const pathname = usePathname() ?? "/app";
    const initialTitle = useRef<string | null>(null);

    useEffect(() => {
        initialTitle.current ??= document.title;
        document.title = `${titleForPath(pathname)} | Lab Lords`;
    }, [pathname]);

    useEffect(() => () => {
        if (initialTitle.current) document.title = initialTitle.current;
    }, []);

    return null;
}
