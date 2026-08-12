"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { resolveContextualParent } from "@/lib/contextualNavigation";

export function ContextualBackLink() {
    const parent = resolveContextualParent(usePathname());

    if (!parent) return null;

    return (
        <Link
            href={parent.href}
            className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-[var(--ui-radius-control)] px-2 text-sm font-semibold text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] lg:hidden"
        >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {parent.label}
        </Link>
    );
}
