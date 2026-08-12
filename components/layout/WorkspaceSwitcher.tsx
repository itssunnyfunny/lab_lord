"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AppSelect, type AppSelectItem } from "@/components/ui";
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

export function getWorkspaceSwitcherOptions(
    directory: WorkspaceDirectory | null,
    error = false
): AppSelectItem[] {
    const destinations = directory ? getWorkspaceSwitcherModel(directory).destinations : [];
    const groups = destinations.reduce<Map<string, WorkspaceDestination[]>>((result, destination) => {
        const group = result.get(destination.group) ?? [];
        group.push(destination);
        result.set(destination.group, group);
        return result;
    }, new Map());
    const workspaceOptions: AppSelectItem[] = [...groups.entries()].map(([group, groupDestinations]) => ({
        label: group,
        options: groupDestinations.map(destination => ({
            value: destination.href,
            label: destination.label,
        })),
    }));
    const statusLabel = error
        ? "Workspaces unavailable"
        : directory
            ? "No workspaces available"
            : "Loading workspaces";

    return [
        ...workspaceOptions,
        ...(workspaceOptions.length === 0
            ? [{ value: "__workspace_status__", label: statusLabel, disabled: true }]
            : []),
        {
            label: "Account",
            options: [{
                value: "/account",
                label: "Account settings",
                description: "Profile, locale, and preferences",
            }],
        },
    ];
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
    const statusLabel = error
        ? "Workspaces unavailable"
        : directory
            ? "No workspaces available"
            : "Loading workspaces";
    const selectOptions = useMemo(
        () => getWorkspaceSwitcherOptions(directory, error),
        [directory, error]
    );
    const currentValue = pathname?.startsWith("/account") ? "/account" : (value ?? "");

    return (
        <AppSelect
            value={currentValue}
            options={selectOptions}
            onValueChange={onNavigate}
            label={label}
            aria-label={`Switch ${label.toLowerCase()} or open account settings`}
            placeholder={statusLabel}
            containerClassName={cn("min-w-0", className)}
            labelClassName="mb-0 text-[10px] font-semibold uppercase leading-4 tracking-[0.12em] text-[color:var(--text-muted)]"
            className="max-w-56 px-2 font-semibold sm:px-3"
        />
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
