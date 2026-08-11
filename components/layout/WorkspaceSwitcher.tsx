"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { workspaces } from "@/lib/api/workspaces";
import type { WorkspaceDirectory } from "@/types";
import { cn } from "@/lib/utils";

function currentWorkspaceHref(pathname: string | null) {
    const branchMatch = pathname?.match(/^\/branch\/([^/]+)/);
    if (branchMatch) return `/branch/${branchMatch[1]}`;
    const organizationMatch = pathname?.match(/^\/org\/([^/]+)/);
    if (organizationMatch) return `/org/${organizationMatch[1]}`;
    return "/app";
}

type WorkspaceDestination = {
    href: string;
    label: string;
    group: string;
};

export function getWorkspaceSwitcherModel(directory: WorkspaceDirectory) {
    const destinations: WorkspaceDestination[] = [
        ...directory.organizations.flatMap(organization => [
            {
                href: organization.href,
                label: `${organization.name} overview`,
                group: organization.name,
            },
            ...organization.branches.map(branch => ({
                href: branch.href,
                label: branch.name,
                group: organization.name,
            })),
        ]),
        ...directory.staffBranches.map(branch => ({
            href: branch.href,
            label: `${branch.name} — ${branch.organizationName}`,
            group: "Branch workspaces",
        })),
    ];

    return {
        label: directory.organizations.length > 0 ? "Org / Branch" : "Branch",
        destinations,
    };
}

export function WorkspaceSwitcherControl({
    directory,
    error = false,
    pathname,
    className,
    onNavigate,
}: {
    directory: WorkspaceDirectory | null;
    error?: boolean;
    pathname: string | null;
    className?: string;
    onNavigate: (href: string) => void;
}) {
    const controlId = useId();
    const model = useMemo(
        () => directory ? getWorkspaceSwitcherModel(directory) : null,
        [directory]
    );
    const availableHrefs = useMemo(
        () => new Set(model?.destinations.map(destination => destination.href) ?? []),
        [model]
    );
    const currentHref = currentWorkspaceHref(pathname);
    const fallbackHref = directory && availableHrefs.has(directory.defaultHref)
        ? directory.defaultHref
        : model?.destinations[0]?.href;
    const value = availableHrefs.has(currentHref) ? currentHref : fallbackHref;
    const label = model?.label ?? "Workspace";
    const destinations = model?.destinations ?? [];

    if (directory && destinations.length === 1) {
        return (
            <div className={cn("min-w-0", className)}>
                <span className="block text-[10px] font-semibold uppercase leading-4 tracking-[0.12em] text-[color:var(--text-muted)]">
                    {label}
                </span>
                <div
                    aria-label={`${label}: ${destinations[0].label}`}
                    title={destinations[0].label}
                    className="flex h-11 min-w-0 items-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-input-border)] bg-[color:var(--ui-form-input-bg)] px-3 text-sm font-semibold text-[color:var(--text-primary)]"
                >
                    <span className="truncate">{destinations[0].label}</span>
                </div>
            </div>
        );
    }

    const groups = destinations.reduce<Map<string, WorkspaceDestination[]>>((result, destination) => {
        const group = result.get(destination.group) ?? [];
        group.push(destination);
        result.set(destination.group, group);
        return result;
    }, new Map());

    return (
        <div className={cn("min-w-0", className)}>
            <label
                htmlFor={controlId}
                className="block text-[10px] font-semibold uppercase leading-4 tracking-[0.12em] text-[color:var(--text-muted)]"
            >
                {label}
            </label>
            <select
                id={controlId}
                aria-label={`Switch ${label.toLowerCase()}`}
                value={value ?? ""}
                disabled={!directory || error || destinations.length === 0}
                title={error ? "Workspace list is temporarily unavailable" : `Switch ${label.toLowerCase()}`}
                onChange={event => onNavigate(event.target.value)}
                className="h-11 w-full min-w-0 max-w-56 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-input-border)] bg-[color:var(--ui-form-input-bg)] px-2 text-sm font-semibold text-[color:var(--text-primary)] outline-none transition-colors focus-visible:border-[color:var(--ui-form-input-focus-border)] focus-visible:ring-2 focus-visible:ring-[color:var(--ui-form-input-focus-ring)] disabled:opacity-60 sm:px-3"
            >
                {!directory && <option>{error ? "Workspaces unavailable" : "Loading workspaces"}</option>}
                {directory && destinations.length === 0 && <option>No workspaces available</option>}
                {[...groups.entries()].map(([group, options]) => (
                    <optgroup key={group} label={group}>
                        {options.map(destination => (
                            <option key={destination.href} value={destination.href}>
                                {destination.label}
                            </option>
                        ))}
                    </optgroup>
                ))}
            </select>
        </div>
    );
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

    return (
        <WorkspaceSwitcherControl
            directory={directory}
            error={error}
            pathname={pathname}
            className={className}
            onNavigate={href => router.push(href)}
        />
    );
}
