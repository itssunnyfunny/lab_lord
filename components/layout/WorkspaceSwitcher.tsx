"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { workspaces } from "@/lib/api/workspaces";
import type { WorkspaceDirectory } from "@/types";
import { cn } from "@/lib/utils";

function currentWorkspaceHref(pathname: string | null) {
    const branchMatch = pathname?.match(/^\/branch\/([^/]+)/);
    if (branchMatch) return `/branch/${branchMatch[1]}`;
    const organizationMatch = pathname?.match(/^\/org\/([^/]+)/);
    if (organizationMatch) return `/org/${organizationMatch[1]}`;
    if (pathname?.startsWith("/account")) return "/account";
    return "/app";
}

export function WorkspaceSwitcher({ className }: { className?: string }) {
    const pathname = usePathname();
    const router = useRouter();
    const [directory, setDirectory] = useState<WorkspaceDirectory | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        workspaces.getDirectory()
            .then(result => {
                if (!cancelled) {
                    setDirectory(result);
                    setError(false);
                }
            })
            .catch(() => {
                if (!cancelled) setError(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const currentHref = currentWorkspaceHref(pathname);
    const availableHrefs = useMemo(() => {
        if (!directory) return new Set<string>();
        return new Set([
            "/account",
            ...directory.organizations.flatMap(organization => [
                organization.href,
                ...organization.branches.map(branch => branch.href),
            ]),
            ...directory.staffBranches.map(branch => branch.href),
        ]);
    }, [directory]);
    const value = availableHrefs.has(currentHref)
        ? currentHref
        : directory?.defaultHref ?? "/app";

    return (
        <select
            aria-label="Switch workspace"
            value={value}
            disabled={!directory || error}
            title={error ? "Workspace list is temporarily unavailable" : "Switch workspace"}
            onChange={event => router.push(event.target.value)}
            className={cn(
                "h-10 min-w-0 max-w-44 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-input-border)] bg-[color:var(--ui-form-input-bg)] px-2 text-sm font-semibold text-[color:var(--text-primary)] outline-none transition-colors focus-visible:border-[color:var(--ui-form-input-focus-border)] focus-visible:ring-2 focus-visible:ring-[color:var(--ui-form-input-focus-ring)] disabled:opacity-60 sm:max-w-56 sm:px-3",
                className
            )}
        >
            {!directory && <option>{error ? "Workspaces unavailable" : "Loading workspaces"}</option>}
            {directory?.organizations.map(organization => (
                <optgroup key={organization.id} label={organization.name}>
                    <option value={organization.href}>{organization.name} overview</option>
                    {organization.branches.map(branch => (
                        <option key={branch.id} value={branch.href}>{branch.name}</option>
                    ))}
                </optgroup>
            ))}
            {directory && directory.staffBranches.length > 0 && (
                <optgroup label="Staff workspaces">
                    {directory.staffBranches.map(branch => (
                        <option key={branch.id} value={branch.href}>
                            {branch.name} — {branch.organizationName}
                        </option>
                    ))}
                </optgroup>
            )}
            {directory && <option value="/account">Account settings</option>}
        </select>
    );
}
