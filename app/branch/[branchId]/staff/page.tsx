"use client";

import { useCallback, useEffect, useState, use } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog, PageLoadingSkeleton, useToast } from "@/components/ui";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import {
    Loader2, AlertCircle,
    Pencil, Trash2, X, CheckCircle2, Shield, UserCog,
    UserPlus, Mail, Link2, Copy, SlidersHorizontal, RotateCcw, LockKeyhole,
} from "lucide-react";
import { staff, StaffInviteResponse, StaffWithUser } from "@/lib/api/staff";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { RowActionsMenu, type RowActionsMenuItem } from "@/components/ui/RowActionsMenu";
import {
    formCompactLabelClass,
    formControlClass,
    formErrorBannerClass,
    formHelpTextClass,
    formIconClass,
    formSurfaceClass,
    formSurfaceHoverClass,
    formWarningBannerClass,
} from "@/components/ui/formSurface";
import {
    pageEmptyStateClass,
    pageErrorIconClass,
    pageErrorStateClass,
    pageGridCardClass,
    pageGridCardHoverClass,
    pageInsetSurfaceClass,
    pageMutedTextClass,
    pageSubtleTextClass,
} from "@/components/ui/pageSurface";
import { FieldError, fieldErrorClass, fieldErrorProps, useInlineFieldErrors } from "@/components/ui/InlineFieldError";
import { useUserPreferences } from "@/components/settings/UserPreferencesApplier";
import { cn } from "@/lib/utils";
import type { CapabilityDecision, OverridableStaffAction, StaffPermissionUpdate } from "@/types";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { getBranchCapabilityDecision } from "@/lib/branchCapabilities";
import { validateOptionalEmail, validateRequiredText } from "@/lib/formValidation";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

// ─── Types ──────────────────────────────────────────────────────────────────

type StaffMember = StaffWithUser;
type StaffRoleOption = "MANAGER" | "STAFF";
type PermissionActionCode = NonNullable<StaffMember["permissionOverrides"]>[number]["action"];

const ROLE_DETAILS: Record<StaffRoleOption, { label: string; summary: string; can: string[]; cannot: string[] }> = {
    MANAGER: {
        label: "Manager",
        summary: "Runs branch operations, payments, analytics, and setup.",
        can: [
            "Update branch settings, seats, shifts, and bundles",
            "Manage students and seat allocations",
            "View, collect, generate, and waive payments",
            "View analytics, AI reports, and staff overview",
        ],
        cannot: ["Add, remove, or change staff roles"],
    },
    STAFF: {
        label: "Staff",
        summary: "Handles daily desk work without setup or reporting powers.",
        can: [
            "Manage students and seat allocations",
            "View payments and mark them paid",
        ],
        cannot: [
            "Change branch settings, seats, shifts, or bundles",
            "Generate or waive payments",
            "View analytics, AI reports, or manage staff",
        ],
    },
};

const PERMISSION_OPTIONS: {
    action: OverridableStaffAction;
    label: string;
    summary: string;
}[] = [
    { action: "manage_branch", label: "Branch setup", summary: "Settings, seats, shifts, and bundles" },
    { action: "students", label: "Students", summary: "Create and update student records" },
    { action: "seat_allocation", label: "Seat allocation", summary: "Assign, move, and end seats" },
    { action: "view_payments", label: "View payments", summary: "See dues, history, and payment lists" },
    { action: "generate_payments", label: "Generate payments", summary: "Create monthly and admission dues" },
    { action: "mark_payment_paid", label: "Collect payments", summary: "Mark dues as paid" },
    { action: "waive_payments", label: "Waive payments", summary: "Write off dues" },
    { action: "analytics", label: "Analytics and AI", summary: "Reports, insights, and branch analytics" },
];

const PERMISSION_ACTION_MAP: Record<OverridableStaffAction, PermissionActionCode> = {
    manage_branch: "MANAGE_BRANCH",
    students: "STUDENTS",
    seat_allocation: "SEAT_ALLOCATION",
    view_payments: "VIEW_PAYMENTS",
    generate_payments: "GENERATE_PAYMENTS",
    mark_payment_paid: "MARK_PAYMENT_PAID",
    waive_payments: "WAIVE_PAYMENTS",
    analytics: "ANALYTICS",
};

const ROLE_DEFAULT_PERMISSIONS: Record<StaffRoleOption, Record<OverridableStaffAction, boolean>> = {
    MANAGER: {
        manage_branch: true,
        students: true,
        seat_allocation: true,
        view_payments: true,
        generate_payments: true,
        mark_payment_paid: true,
        waive_payments: true,
        analytics: true,
    },
    STAFF: {
        manage_branch: false,
        students: true,
        seat_allocation: true,
        view_payments: true,
        generate_payments: false,
        mark_payment_paid: true,
        waive_payments: false,
        analytics: false,
    },
};

function getPermissionOverride(member: StaffMember, action: OverridableStaffAction) {
    const code = PERMISSION_ACTION_MAP[action];
    return member.permissionOverrides?.find(override => override.action === code)?.allowed ?? null;
}

function getPermissionDraft(member: StaffMember): StaffPermissionUpdate {
    return PERMISSION_OPTIONS.reduce<StaffPermissionUpdate>((draft, option) => {
        draft[option.action] = getPermissionOverride(member, option.action);
        return draft;
    }, {});
}

function hasPermissionOverrides(member: StaffMember) {
    return (member.permissionOverrides?.length ?? 0) > 0;
}

function getEffectivePermission(role: StaffRoleOption, draft: StaffPermissionUpdate, action: OverridableStaffAction) {
    return draft[action] ?? ROLE_DEFAULT_PERMISSIONS[role][action];
}

function AccessSummary({ member }: { member: StaffMember }) {
    const allowed = member.permissionOverrides?.filter(override => override.allowed).length ?? 0;
    const blocked = member.permissionOverrides?.filter(override => !override.allowed).length ?? 0;

    if (!allowed && !blocked) {
        return <Badge variant="default">Role defaults</Badge>;
    }

    return (
        <div className="flex flex-wrap gap-1.5">
            {allowed > 0 && <Badge variant="success">{allowed} allowed</Badge>}
            {blocked > 0 && <Badge variant="danger">{blocked} blocked</Badge>}
        </div>
    );
}

function RolePermissionSummary({ role }: { role: StaffRoleOption }) {
    const details = ROLE_DETAILS[role];

    return (
        <div className="mt-2 space-y-2">
            <p className={cn("text-xs", formHelpTextClass)}>{details.summary}</p>
            <div className="grid gap-1.5">
                {details.can.map(item => (
                    <div key={item} className="flex items-start gap-2 text-xs text-emerald-300/90">
                        <CheckCircle2 size={12} className="mt-0.5 flex-shrink-0" />
                        <span>{item}</span>
                    </div>
                ))}
                {details.cannot.map(item => (
                    <div key={item} className="flex items-start gap-2 text-xs text-rose-300/90">
                        <X size={12} className="mt-0.5 flex-shrink-0" />
                        <span>{item}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ─── Row dropdown ────────────────────────────────────────────────────────────

function getErrorMessage(err: unknown, fallback = "Something went wrong.") {
    return err instanceof Error ? err.message : fallback;
}

type RowAction = RowActionsMenuItem;

function RowActions({ actions }: { actions: RowAction[] }) {
    return <RowActionsMenu actions={actions} />;
}

// ─── Edit Role Dialog ────────────────────────────────────────────────────────

function PermissionModeButton({
    active,
    children,
    onClick,
}: {
    active: boolean;
    children: React.ReactNode;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                "inline-flex h-11 min-w-0 items-center justify-center gap-1 rounded-lg px-2 text-xs font-semibold transition-colors lg:h-8 lg:text-[11px]",
                active
                    ? "bg-cyan-500/15 text-cyan-200"
                    : "text-[color:var(--ui-form-help)] hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--ui-table-text)]"
            )}
        >
            {children}
        </button>
    );
}

function PermissionControls({
    role,
    draft,
    onChange,
}: {
    role: StaffRoleOption;
    draft: StaffPermissionUpdate;
    onChange: (action: OverridableStaffAction, value: boolean | null) => void;
}) {
    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <SlidersHorizontal size={15} className="text-cyan-300" />
                Access controls
            </div>
            <div className="grid gap-2">
                {PERMISSION_OPTIONS.map(option => {
                    const override = draft[option.action] ?? null;
                    const effective = getEffectivePermission(role, draft, option.action);

                    return (
                        <div
                            key={option.action}
                            className={cn("grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_260px]", formSurfaceClass)}
                        >
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-sm font-semibold text-white">{option.label}</p>
                                    <Badge variant={effective ? "success" : "danger"} className="shrink-0">
                                        {effective ? "Allowed" : "Blocked"}
                                    </Badge>
                                </div>
                                <p className={cn("mt-1 text-xs", formHelpTextClass)}>{option.summary}</p>
                            </div>

                            <div className={cn("grid grid-cols-3 gap-1 p-1", formSurfaceClass)}>
                                <PermissionModeButton
                                    active={override === null}
                                    onClick={() => onChange(option.action, null)}
                                >
                                    <RotateCcw size={12} />
                                    Default
                                </PermissionModeButton>
                                <PermissionModeButton
                                    active={override === true}
                                    onClick={() => onChange(option.action, true)}
                                >
                                    Allow
                                </PermissionModeButton>
                                <PermissionModeButton
                                    active={override === false}
                                    onClick={() => onChange(option.action, false)}
                                >
                                    Block
                                </PermissionModeButton>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

interface EditRoleDialogProps {
    isOpen: boolean;
    member: StaffMember | null;
    branchId: string;
    onClose: () => void;
    onSuccess: (updated: StaffMember) => void;
    capability: CapabilityDecision;
}

function EditRoleDialog({ isOpen, member, branchId, onClose, onSuccess, capability }: EditRoleDialogProps) {
    const [role, setRole] = useState<StaffRoleOption>("STAFF");
    const [permissionDraft, setPermissionDraft] = useState<StaffPermissionUpdate>({});
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (member) {
            setRole(member.role);
            setPermissionDraft(getPermissionDraft(member));
            setError(null);
        }
    }, [member]);

    if (!isOpen || !member) return null;

    const permissionsChanged = PERMISSION_OPTIONS.some(option => (
        (permissionDraft[option.action] ?? null) !== getPermissionOverride(member, option.action)
    ));
    const hasChanges = role !== member.role || permissionsChanged;

    const handlePermissionChange = (action: OverridableStaffAction, value: boolean | null) => {
        setPermissionDraft(prev => ({ ...prev, [action]: value }));
    };

    const handleSave = async () => {
        if (!capability.allowed) {
            setError(capability.reason);
            return;
        }
        if (!hasChanges) { onClose(); return; }
        setLoading(true); setError(null);
        try {
            const updated = await staff.update(branchId, member.id, {
                role: role !== member.role ? role : undefined,
                permissions: permissionsChanged ? permissionDraft : undefined,
            });
            onSuccess(updated);
            onClose();
        } catch (err: unknown) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            title="Staff Access"
            description={member.user?.name || member.user?.email}
            closeLabel="Close staff access dialog"
            closeDisabled={loading}
            className="max-w-3xl"
            footer={(
                <>
                    <Button variant="ghost" onClick={onClose} disabled={loading} className="min-h-11 px-3 text-sm">
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={loading || !hasChanges} className="min-h-11 min-w-[120px] justify-center px-4 text-sm">
                        {loading
                            ? <><Loader2 size={12} className="mr-1.5 animate-spin" /> Saving...</>
                            : "Save Access"
                        }
                    </Button>
                </>
            )}
        >
            <div className="space-y-5">
                <div className="grid gap-3 md:grid-cols-2" role="group" aria-label="Staff role">
                    {(["MANAGER", "STAFF"] as const).map(r => (
                        <button
                            key={r}
                            type="button"
                            onClick={() => setRole(r)}
                            aria-pressed={role === r}
                            className={cn(
                                "flex min-h-11 w-full items-start gap-4 rounded-xl border p-4 text-left transition-all",
                                role === r
                                    ? "border-cyan-500/40 bg-cyan-500/5"
                                    : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] hover:border-[color:var(--ui-form-input-border)]"
                            )}
                        >
                            <div className={cn(
                                "mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg",
                                role === r ? "bg-cyan-500/20" : "bg-[color:var(--ui-form-input-bg)]"
                            )}>
                                {r === "MANAGER"
                                    ? <Shield size={15} className={role === r ? "text-cyan-400" : formIconClass} aria-hidden="true" />
                                    : <UserCog size={15} className={role === r ? "text-cyan-400" : formIconClass} aria-hidden="true" />}
                            </div>
                            <div className="flex-1">
                                <p className={cn("text-sm font-semibold", role === r ? "text-[color:var(--ui-form-label-strong)]" : "text-[color:var(--ui-form-label)]")}>{ROLE_DETAILS[r].label}</p>
                                <RolePermissionSummary role={r} />
                            </div>
                            {role === r ? <div className="mt-1 h-4 w-4 flex-shrink-0 rounded-full border-2 border-cyan-500 bg-cyan-500/30" aria-hidden="true" /> : null}
                        </button>
                    ))}
                </div>

                <PermissionControls
                    role={role}
                    draft={permissionDraft}
                    onChange={handlePermissionChange}
                />

                {error ? (
                    <div className={cn("flex items-center gap-2 px-3 py-2 text-sm", formErrorBannerClass)} role="alert">
                        <AlertCircle size={13} aria-hidden="true" /> {error}
                    </div>
                ) : null}
            </div>
        </Dialog>
    );
}

// ─── Add Staff Dialog ────────────────────────────────────────────────────────

interface AddStaffDialogProps {
    isOpen: boolean;
    branchId: string;
    onClose: () => void;
    onSuccess: (member: StaffMember) => void;
    capability: CapabilityDecision;
}

function AddStaffDialog({ isOpen, branchId, onClose, onSuccess, capability }: AddStaffDialogProps) {
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<StaffRoleOption>("STAFF");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { markTouched, markSubmitted, resetFieldErrors, visibleError } = useInlineFieldErrors<"email">();

    useEffect(() => { if (isOpen) { setEmail(""); setRole("STAFF"); setError(null); resetFieldErrors(); } }, [isOpen, resetFieldErrors]);

    if (!isOpen) return null;

    const validateForm = () => {
        const errors: Partial<Record<"email", string>> = {};
        const requiredResult = validateRequiredText(email, "Email", 160);
        const emailResult = validateOptionalEmail(email, "Email");
        if (!requiredResult.ok) errors.email = requiredResult.error;
        else if (!emailResult.ok) errors.email = emailResult.error;
        return { errors, emailValue: emailResult.ok ? emailResult.value : undefined };
    };
    const validation = validateForm();
    const emailError = visibleError("email", validation.errors);

    const handleAdd = async () => {
        if (!capability.allowed) {
            setError(capability.reason);
            return;
        }
        markSubmitted();
        setError(null);
        const result = validateForm();
        if (Object.values(result.errors).some(Boolean) || !result.emailValue) return;
        setLoading(true); setError(null);
        try {
            const res = await fetch(`/api/branches/${branchId}/staff`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: result.emailValue, role }),
            });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || "Failed to add staff");
            }
            const newMember = await res.json();
            onSuccess(newMember);
            onClose();
        } catch (err: unknown) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            title="Add Staff Member"
            description="Enter their account email and assign a role."
            closeLabel="Close add staff dialog"
            closeDisabled={loading}
            className="max-w-md"
            footer={(
                <>
                    <Button variant="ghost" onClick={onClose} disabled={loading} className="min-h-11 px-3 text-sm">
                        Cancel
                    </Button>
                    <Button onClick={handleAdd} disabled={loading} className="min-h-11 min-w-[100px] justify-center px-4 text-sm">
                        {loading
                            ? <><Loader2 size={12} className="mr-1.5 animate-spin" /> Adding...</>
                            : "Add Staff"
                        }
                    </Button>
                </>
            )}
        >
            <div className="space-y-4">
                <div className="space-y-1.5">
                    <label htmlFor="add-staff-email" className={formCompactLabelClass}>Email *</label>
                    <div className="relative">
                        <Mail size={14} className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} aria-hidden="true" />
                        <input
                            id="add-staff-email"
                            type="email"
                            value={email}
                            onChange={e => { setEmail(e.target.value); setError(null); }}
                            onBlur={() => markTouched("email")}
                            placeholder="teammate@example.com"
                            data-dialog-initial-focus
                            className={cn(formControlClass, "py-2.5 pl-9 pr-4 text-base sm:text-sm", fieldErrorClass(emailError))}
                            {...fieldErrorProps("add-staff-email-error", emailError)}
                        />
                    </div>
                    <FieldError id="add-staff-email-error" error={emailError} />
                    <p className="text-xs text-[color:var(--ui-table-subtle)]">The user must sign in once before they can be added.</p>
                </div>

                <div className="space-y-1.5">
                    <span id="add-staff-role-label" className={formCompactLabelClass}>Role</span>
                    <div className="grid gap-2" role="group" aria-labelledby="add-staff-role-label">
                        {(["MANAGER", "STAFF"] as const).map(r => (
                            <button
                                key={r}
                                type="button"
                                onClick={() => setRole(r)}
                                aria-pressed={role === r}
                                className={cn(
                                    "min-h-11 rounded-[var(--ui-radius-control)] border p-3 text-left transition-all",
                                    role === r
                                        ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-400"
                                        : cn("text-[color:var(--ui-form-label)]", formSurfaceClass, formSurfaceHoverClass)
                                )}
                            >
                                <div className="flex items-center gap-2 text-sm font-semibold">
                                    {r === "MANAGER"
                                        ? <Shield size={14} aria-hidden="true" />
                                        : <UserCog size={14} aria-hidden="true" />}
                                    {ROLE_DETAILS[r].label}
                                </div>
                                {role === r ? <RolePermissionSummary role={r} /> : null}
                            </button>
                        ))}
                    </div>
                </div>

                {error ? (
                    <div className={cn("flex items-center gap-2 px-3 py-2 text-sm", formErrorBannerClass)} role="alert">
                        <AlertCircle size={13} aria-hidden="true" /> {error}
                    </div>
                ) : null}
            </div>
        </Dialog>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function InviteLinkPanel({
    inviteRole,
    inviteEmail,
    invite,
    activeInvites,
    loading,
    invitesLoading,
    error,
    copiedInviteId,
    revokingInviteId,
    onRoleChange,
    onEmailChange,
    onCreateInvite,
    onCopyInvite,
    onRevokeInvite,
    capability,
}: {
    inviteRole: StaffRoleOption;
    inviteEmail: string;
    invite: StaffInviteResponse | null;
    activeInvites: StaffInviteResponse[];
    loading: boolean;
    invitesLoading: boolean;
    error: string | null;
    copiedInviteId: string | null;
    revokingInviteId: string | null;
    onRoleChange: (role: StaffRoleOption) => void;
    onEmailChange: (email: string) => void;
    onCreateInvite: () => void;
    onCopyInvite: (invite: StaffInviteResponse) => void;
    onRevokeInvite: (inviteId: string) => void;
    capability: CapabilityDecision;
}) {
    const { formatDateTime } = useUserPreferences();
    const olderInvites = activeInvites.filter(item => item.id !== invite?.id);

    return (
        <Card noHover className="p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-white">
                        <Link2 size={16} className="text-cyan-300" />
                        Invite by link
                    </div>
                    <p className={cn("mt-1 text-xs", formHelpTextClass)}>
                        Create a one-use, account-restricted link. Links expire in 7 days.
                    </p>
                </div>

                <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-end lg:w-auto">
                    <label htmlFor="staff-invite-email" className="min-w-0 flex-1 sm:w-64">
                        <span className={cn("mb-1.5 block", formCompactLabelClass)}>Invite email</span>
                        <span className="relative block">
                            <Mail
                                size={15}
                                aria-hidden="true"
                                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--ui-form-help)]"
                            />
                            <input
                                id="staff-invite-email"
                                type="email"
                                autoComplete="email"
                                value={inviteEmail}
                                onChange={event => onEmailChange(event.target.value)}
                                disabled={!capability.allowed}
                                placeholder="staff@example.com"
                                className={cn(formControlClass, "h-11 w-full pl-9 pr-3 text-base lg:h-10 lg:text-sm")}
                            />
                        </span>
                    </label>
                    <div className={cn("grid grid-cols-2 gap-2 p-1", formSurfaceClass)} role="group" aria-label="Invite role">
                        {(["MANAGER", "STAFF"] as const).map(role => (
                            <button
                                key={role}
                                type="button"
                                onClick={() => onRoleChange(role)}
                                disabled={!capability.allowed}
                                aria-pressed={inviteRole === role}
                                className={cn(
                                    "h-8 rounded-lg px-3 text-xs font-semibold transition-colors",
                                    inviteRole === role
                                        ? "bg-cyan-500/15 text-cyan-200"
                                        : "text-[color:var(--ui-form-help)] hover:text-[color:var(--ui-table-text)]"
                                )}
                            >
                                {ROLE_DETAILS[role].label}
                            </button>
                        ))}
                    </div>
                    <Button
                        onClick={onCreateInvite}
                        isLoading={loading}
                        disabled={loading || !capability.allowed}
                        aria-describedby={!capability.allowed ? "staff-manage-blocker" : undefined}
                        className="h-11 whitespace-nowrap lg:h-10"
                    >
                        Create invite
                    </Button>
                </div>
            </div>

            {invite && (
                <div className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold uppercase tracking-wider text-cyan-200">Latest invite</span>
                        <span className={cn("text-xs", formHelpTextClass)}>Expires {formatDateTime(invite.expiresAt)}</span>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                            readOnly
                            aria-label="Latest invite link"
                            value={invite.inviteUrl}
                            className={cn(formControlClass, "h-11 min-w-0 flex-1 px-3 font-mono text-xs lg:h-10")}
                        />
                        <Button variant="outline" onClick={() => onCopyInvite(invite)} className="h-11 whitespace-nowrap lg:h-10">
                            {copiedInviteId === invite.id ? <><CheckCircle2 size={14} /> Copied</> : <><Copy size={14} /> Copy link</>}
                        </Button>
                        <Button
                            variant="danger"
                            isLoading={revokingInviteId === invite.id}
                            onClick={() => onRevokeInvite(invite.id)}
                            disabled={!capability.allowed}
                            aria-describedby={!capability.allowed ? "staff-manage-blocker" : undefined}
                            className="h-11 whitespace-nowrap lg:h-10"
                        >
                            <Trash2 size={14} /> Revoke
                        </Button>
                    </div>
                </div>
            )}

            <div className="mt-4 border-t border-[color:var(--ui-form-section-divider)] pt-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-semibold text-white">Active invite links</h3>
                        <p className={cn("text-xs", formHelpTextClass)}>Copy an existing link or revoke it when it should no longer be used.</p>
                    </div>
                    {invitesLoading && <Loader2 size={14} className={cn("animate-spin", formHelpTextClass)} />}
                </div>

                {!invitesLoading && activeInvites.length === 0 && (
                    <div className={cn("rounded-[var(--ui-radius-control)] border border-dashed border-[color:var(--ui-form-surface-border)] px-4 py-3 text-sm", formHelpTextClass)}>
                        No active invite links.
                    </div>
                )}

                {olderInvites.length > 0 && (
                    <div className="space-y-2">
                        {olderInvites.map(item => (
                            <div key={item.id} className={cn("flex flex-col gap-3 p-3 md:flex-row md:items-center", formSurfaceClass)}>
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant={item.role === "MANAGER" ? "cyan" : "default"}>
                                            {ROLE_DETAILS[item.role].label}
                                        </Badge>
                                        <span className={cn("text-xs", formHelpTextClass)}>Expires {formatDateTime(item.expiresAt)}</span>
                                    </div>
                                    <p className={cn("mt-1 truncate font-mono text-xs", formHelpTextClass)}>{item.inviteUrl}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Button variant="outline" size="sm" onClick={() => onCopyInvite(item)}>
                                        {copiedInviteId === item.id ? <><CheckCircle2 size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                                    </Button>
                                    <Button
                                        variant="danger"
                                        size="sm"
                                        isLoading={revokingInviteId === item.id}
                                        onClick={() => onRevokeInvite(item.id)}
                                        disabled={!capability.allowed}
                                        aria-describedby={!capability.allowed ? "staff-manage-blocker" : undefined}
                                    >
                                        <Trash2 size={13} /> Revoke
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {error && (
                <div className={cn("mt-3 flex items-center gap-2 px-3 py-2 text-sm", formErrorBannerClass)}>
                    <AlertCircle size={13} /> {error}
                </div>
            )}
        </Card>
    );
}

export default function StaffPage({ params }: { params: Promise<{ branchId: string }> }) {
    const { branchId } = use(params);

    return (
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.staff}>
            {access => (
                <StaffContent
                    key={branchId}
                    branchId={branchId}
                    staffManageDecision={getBranchCapabilityDecision(access, "staffManage")}
                />
            )}
        </BranchAccessGuard>
    );
}

function StaffCapabilityNotice({ decision }: { decision: CapabilityDecision }) {
    if (decision.allowed || decision.blocker === "permission") return null;

    return (
        <div id="staff-manage-blocker" className={cn("flex flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between", formWarningBannerClass)}>
            <span className="flex items-start gap-2">
                <LockKeyhole size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span><span className="font-semibold">Staff changes are unavailable.</span> {decision.reason}</span>
            </span>
            {decision.recoveryHref && (
                <Link href={decision.recoveryHref} className="shrink-0 font-semibold underline underline-offset-4">
                    Resolve access
                </Link>
            )}
        </div>
    );
}

function DisabledStaffAction() {
    return (
        <button
            type="button"
            disabled
            aria-describedby="staff-manage-blocker"
            className="inline-flex items-center gap-1.5 text-xs text-[color:var(--ui-table-subtle)] disabled:cursor-not-allowed"
        >
            <LockKeyhole size={13} aria-hidden="true" />
            Changes locked
        </button>
    );
}

function StaffContent({
    branchId,
    staffManageDecision,
}: {
    branchId: string;
    staffManageDecision: CapabilityDecision;
}) {
    const searchParams = useSearchParams();
    const targetStaffId = searchParams.get("staffId");
    const canMutateStaff = staffManageDecision.allowed;
    const showMutationControls = staffManageDecision.blocker !== "permission";
    const { show } = useToast();
    const { formatDate } = useUserPreferences();
    const [data, setData] = useState<StaffMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [total, setTotal] = useState(0);

    const [editTarget, setEditTarget] = useState<StaffMember | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [inviteRole, setInviteRole] = useState<StaffRoleOption>("STAFF");
    const [inviteEmail, setInviteEmail] = useState("");
    const [invite, setInvite] = useState<StaffInviteResponse | null>(null);
    const [activeInvites, setActiveInvites] = useState<StaffInviteResponse[]>([]);
    const [inviteLoading, setInviteLoading] = useState(false);
    const [invitesLoading, setInvitesLoading] = useState(false);
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);
    const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);

    const [removeTarget, setRemoveTarget] = useState<StaffMember | null>(null);
    const [removeLoading, setRemoveLoading] = useState(false);

    const showToast = useCallback((title: string, tone: "success" | "error" = "success") => {
        show({ title, tone });
    }, [show]);

    const loadStaff = useCallback(async (cursor?: string | null) => {
        if (staffManageDecision.blocker === "entitlement") {
            setLoading(false);
            return;
        }
        const append = Boolean(cursor);
        if (append) setLoadingMore(true);
        setLoadMoreError(null);
        try {
            const page = await staff.list(branchId, { cursor, limit: 50 });
            const loadedMembers = [...page.items];
            let resultCursor = page.nextCursor;
            let resultTotal = page.total;

            if (!append && targetStaffId) {
                const seenCursors = new Set<string>();
                while (
                    resultCursor
                    && !loadedMembers.some(member => member.id === targetStaffId)
                ) {
                    if (seenCursors.has(resultCursor)) {
                        throw new Error("Staff pagination returned a repeated cursor");
                    }
                    seenCursors.add(resultCursor);

                    const nextPage = await staff.list(branchId, {
                        cursor: resultCursor,
                        limit: 50,
                    });
                    const knownIds = new Set(loadedMembers.map(member => member.id));
                    loadedMembers.push(...nextPage.items.filter(member => !knownIds.has(member.id)));
                    resultCursor = nextPage.nextCursor;
                    resultTotal = nextPage.total;
                }
            }

            setData(current => {
                if (!append) return loadedMembers;
                const knownIds = new Set(current.map(member => member.id));
                return [
                    ...current,
                    ...loadedMembers.filter(member => !knownIds.has(member.id)),
                ];
            });
            setNextCursor(resultCursor);
            setTotal(resultTotal);
            setError(null);
        } catch (err: unknown) {
            const message = getErrorMessage(err, append
                ? "Failed to load more staff."
                : "Failed to load staff.");
            if (append) setLoadMoreError(message);
            else setError(message);
        } finally {
            if (append) setLoadingMore(false);
            else setLoading(false);
        }
    }, [branchId, staffManageDecision.blocker, targetStaffId]);

    useEffect(() => { void loadStaff(); }, [loadStaff]);

    useEffect(() => {
        if (loading || !targetStaffId) return;

        const desktop = window.matchMedia("(min-width: 768px)").matches;
        const destinationIds = desktop
            ? [`staff-row-${targetStaffId}`, `staff-card-${targetStaffId}`]
            : [`staff-card-${targetStaffId}`, `staff-row-${targetStaffId}`];
        const target = destinationIds
            .map(id => document.getElementById(id))
            .find((element): element is HTMLElement => element !== null);
        if (!target) return;

        const focusFrame = window.requestAnimationFrame(() => {
            const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
            target.focus({ preventScroll: true });
        });
        return () => window.cancelAnimationFrame(focusFrame);
    }, [data, loading, targetStaffId]);

    const loadInvites = useCallback(async () => {
        if (!showMutationControls) return;
        setInvitesLoading(true);
        try {
            const list = await staff.listInvites(branchId);
            setActiveInvites(list);
            setInviteError(null);
        } catch (err: unknown) {
            setInviteError(getErrorMessage(err, "Failed to load active invites."));
        } finally {
            setInvitesLoading(false);
        }
    }, [branchId, showMutationControls]);

    useEffect(() => { loadInvites(); }, [loadInvites]);

    const handleCreateInvite = async () => {
        if (!staffManageDecision.allowed) {
            setInviteError(staffManageDecision.reason);
            return;
        }
        const requiredResult = validateRequiredText(inviteEmail, "Invite email", 160);
        const emailResult = validateOptionalEmail(inviteEmail, "Invite email");
        if (!requiredResult.ok || !emailResult.ok || !emailResult.value) {
            setInviteError(
                !requiredResult.ok
                    ? requiredResult.error
                    : !emailResult.ok
                        ? emailResult.error
                        : "Invite email is required."
            );
            return;
        }

        setInviteLoading(true);
        setInviteError(null);
        setCopiedInviteId(null);
        try {
            const created = await staff.createInvite(branchId, {
                role: inviteRole,
                email: emailResult.value.toLowerCase(),
            });
            setInvite(created);
            setInviteEmail("");
            setActiveInvites(prev => [created, ...prev.filter(item => item.id !== created.id)]);
            showToast("Invite link created.");
        } catch (err: unknown) {
            setInviteError(getErrorMessage(err, "Failed to create invite."));
        } finally {
            setInviteLoading(false);
        }
    };

    const handleCopyInvite = async (inviteToCopy: StaffInviteResponse) => {
        try {
            await navigator.clipboard.writeText(inviteToCopy.inviteUrl);
            setCopiedInviteId(inviteToCopy.id);
            setTimeout(() => setCopiedInviteId(null), 2500);
        } catch {
            setInviteError("Could not copy the invite link. Select the link and copy it manually.");
        }
    };

    const handleRevokeInvite = async (inviteId: string) => {
        if (!staffManageDecision.allowed) {
            setInviteError(staffManageDecision.reason);
            return;
        }
        setRevokingInviteId(inviteId);
        setInviteError(null);
        try {
            await staff.revokeInvite(branchId, inviteId);
            setActiveInvites(prev => prev.filter(item => item.id !== inviteId));
            if (invite?.id === inviteId) setInvite(null);
            showToast("Invite revoked.");
        } catch (err: unknown) {
            setInviteError(getErrorMessage(err, "Failed to revoke invite."));
        } finally {
            setRevokingInviteId(null);
        }
    };

    const handleRemoveClick = (member: StaffMember) => {
        if (!staffManageDecision.allowed) return;
        setRemoveTarget(member);
    };

    const confirmRemove = async () => {
        if (!removeTarget || !staffManageDecision.allowed) {
            if (!staffManageDecision.allowed) {
                showToast(staffManageDecision.reason, "error");
            }
            return;
        }
        setRemoveLoading(true);
        try {
            const res = await fetch(`/api/branches/${branchId}/staff/${removeTarget.id}`, { method: "DELETE" });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || "Remove failed");
            }
            setData(prev => prev.filter(s => s.id !== removeTarget.id));
            setTotal(current => Math.max(0, current - 1));
            setRemoveTarget(null);
            showToast(`${removeTarget.user?.name || "Member"} removed.`);
        } catch (err: unknown) {
            showToast(getErrorMessage(err, "Remove failed."), "error");
        } finally {
            setRemoveLoading(false);
        }
    };

    if (loading) return <PageLoadingSkeleton label="Loading staff" variant="table" rows={5} />;

    if (error) return (
        <div className={pageErrorStateClass}>
            <AlertCircle className={pageErrorIconClass} />
            <p className={pageMutedTextClass}>{error}</p>
        </div>
    );

    const staffMemberActions = (member: StaffMember): RowAction[] => [
        {
            label: hasPermissionOverrides(member) ? "Edit Access" : "Set Access",
            icon: Pencil,
            onClick: () => {
                if (staffManageDecision.allowed) setEditTarget(member);
            },
        },
        {
            label: "Remove",
            icon: Trash2,
            variant: "danger",
            onClick: () => handleRemoveClick(member),
        },
    ];

    const staffCards = (
        <div className="grid gap-4">
            {data.map(member => (
                <div
                    key={member.id}
                    id={`staff-card-${member.id}`}
                    tabIndex={targetStaffId === member.id ? -1 : undefined}
                    aria-current={targetStaffId === member.id ? "true" : undefined}
                    aria-label={targetStaffId === member.id ? `${member.user?.name || member.user?.email || "Staff member"}, selected search result` : undefined}
                    className={cn(
                        pageGridCardClass,
                        pageGridCardHoverClass,
                        targetStaffId === member.id && "border-cyan-400/50 bg-cyan-400/[0.05] outline outline-2 outline-cyan-300/60"
                    )}
                >
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                            <Avatar name={member.user?.name || member.user?.email || "Staff member"} />
                            <div className="min-w-0">
                                <p className="truncate font-medium text-[color:var(--ui-table-text)]">{member.user?.name || <span className={cn("italic text-xs", pageSubtleTextClass)}>No name</span>}</p>
                                <p className={cn("mt-1 flex min-w-0 items-center gap-1 truncate text-xs", pageSubtleTextClass)}>
                                    <Mail size={10} className="flex-shrink-0" />{member.user?.email}
                                </p>
                            </div>
                        </div>
                        {canMutateStaff ? (
                            <RowActions actions={staffMemberActions(member)} />
                        ) : showMutationControls ? <DisabledStaffAction /> : null}
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <div className={cn("p-3", pageInsetSurfaceClass)}>
                            <div className={cn("text-xs", pageSubtleTextClass)}>Role</div>
                            <div className="mt-2">
                                <Badge variant={member.role === "MANAGER" ? "cyan" : "default"}>
                                    {member.role === "MANAGER"
                                        ? <><Shield size={10} className="mr-1" />Manager</>
                                        : <><UserCog size={10} className="mr-1" />Staff</>
                                    }
                                </Badge>
                            </div>
                        </div>
                        <div className={cn("p-3", pageInsetSurfaceClass)}>
                            <div className={cn("text-xs", pageSubtleTextClass)}>Added</div>
                            <div className={cn("mt-2 text-xs", pageMutedTextClass)}>{formatDate(member.createdAt)}</div>
                        </div>
                    </div>

                    <div className={cn("mt-3 p-3", pageInsetSurfaceClass)}>
                        <div className={cn("mb-2 text-xs", pageSubtleTextClass)}>Access</div>
                        <AccessSummary member={member} />
                    </div>
                </div>
            ))}
        </div>
    );

    return (
        <div className="relative space-y-6">
            <PageHeader
                title="Staff"
                subtitle="Manage team members and their access roles."
                onAdd={canMutateStaff ? () => setAddOpen(true) : undefined}
                extraActions={showMutationControls && !canMutateStaff ? (
                    <Button
                        disabled
                        icon={UserPlus}
                        aria-describedby="staff-manage-blocker"
                        className="flex-shrink-0 whitespace-nowrap"
                    >
                        Add Staff
                    </Button>
                ) : undefined}
                actionLabel="Add Staff"
            />

            <StaffCapabilityNotice decision={staffManageDecision} />

            {showMutationControls && (
                <InviteLinkPanel
                    inviteRole={inviteRole}
                    inviteEmail={inviteEmail}
                    invite={invite}
                    activeInvites={activeInvites}
                    loading={inviteLoading}
                    invitesLoading={invitesLoading}
                    error={inviteError}
                    copiedInviteId={copiedInviteId}
                    revokingInviteId={revokingInviteId}
                    onRoleChange={(role) => {
                        setInviteRole(role);
                        setInvite(null);
                        setInviteError(null);
                        setCopiedInviteId(null);
                    }}
                    onEmailChange={(email) => {
                        setInviteEmail(email);
                        setInviteError(null);
                    }}
                    onCreateInvite={handleCreateInvite}
                    onCopyInvite={handleCopyInvite}
                    onRevokeInvite={handleRevokeInvite}
                    capability={staffManageDecision}
                />
            )}

            {staffManageDecision.blocker === "entitlement" ? (
                <div className={cn("space-y-2", pageEmptyStateClass)} role="status">
                    <LockKeyhole size={32} className="mx-auto opacity-50" aria-hidden="true" />
                    <p className="font-medium text-[color:var(--text-primary)]">Staff directory is restricted</p>
                    <p className={cn("mx-auto max-w-md text-sm", pageMutedTextClass)}>{staffManageDecision.reason}</p>
                </div>
            ) : data.length === 0 ? (
                <div className={cn("space-y-3", pageEmptyStateClass)}>
                    <UserPlus size={36} className="mx-auto opacity-30" />
                    <p>No staff members yet.</p>
                    {canMutateStaff && (
                        <button onClick={() => setAddOpen(true)} className="text-sm text-[color:var(--ui-form-accent)] transition-colors hover:text-[color:var(--ui-form-accent-hover)]">
                            + Add your first staff member
                        </button>
                    )}
                </div>
            ) : (
                <>
                <div className="lg:hidden">{staffCards}</div>
                <Card noHover className="hidden overflow-visible p-0 lg:block lg:p-0">
                    <div
                        className="w-full overflow-x-auto scrollbar-thin scrollbar-thumb-cyan-400/35 scrollbar-track-slate-950/50"
                        role="region"
                        aria-label="Branch staff directory"
                        tabIndex={0}
                    >
                    <table className="w-full min-w-[54rem] text-left text-sm">
                        <caption className="sr-only">Branch staff directory</caption>
                        <thead>
                            <tr className="border-b border-[color:var(--ui-table-divider)] bg-[color:var(--ui-table-head-bg)] text-[color:var(--ui-table-muted)]">
                                <th scope="col" className="px-6 py-4 font-medium">Member</th>
                                <th scope="col" className="px-6 py-4 font-medium">Role</th>
                                <th scope="col" className="px-6 py-4 font-medium">Access</th>
                                <th scope="col" className="px-6 py-4 font-medium">Added</th>
                                <th scope="col" className="px-6 py-4 font-medium w-14"><span className="sr-only">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[color:var(--ui-table-divider)]">
                            {data.map(member => (
                                <tr
                                    key={member.id}
                                    id={`staff-row-${member.id}`}
                                    tabIndex={targetStaffId === member.id ? -1 : undefined}
                                    aria-current={targetStaffId === member.id ? "true" : undefined}
                                    aria-label={targetStaffId === member.id ? `${member.user?.name || member.user?.email || "Staff member"}, selected search result` : undefined}
                                    className={cn(
                                        "group transition-colors hover:bg-[color:var(--ui-table-row-hover-bg)]",
                                        targetStaffId === member.id && "bg-cyan-400/[0.05] outline outline-2 outline-cyan-300/60"
                                    )}
                                >
                                    {/* Member */}
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <Avatar name={member.user?.name || member.user?.email || "Staff member"} size="sm" />
                                            <div>
                                                <p className="font-medium text-[color:var(--ui-table-text)]">{member.user?.name || <span className="text-xs italic text-[color:var(--ui-table-subtle)]">No name</span>}</p>
                                                <p className="flex items-center gap-1 text-xs text-[color:var(--ui-table-subtle)]">
                                                    <Mail size={10} />{member.user?.email}
                                                </p>
                                            </div>
                                        </div>
                                    </td>
                                    {/* Role */}
                                    <td className="px-6 py-4">
                                        <Badge variant={member.role === "MANAGER" ? "cyan" : "default"}>
                                            {member.role === "MANAGER"
                                                ? <><Shield size={10} className="mr-1" />Manager</>
                                                : <><UserCog size={10} className="mr-1" />Staff</>
                                            }
                                        </Badge>
                                    </td>
                                    {/* Access */}
                                    <td className="px-6 py-4">
                                        <AccessSummary member={member} />
                                    </td>
                                    {/* Date */}
                                    <td className="px-6 py-4 text-xs text-[color:var(--ui-table-subtle)]">
                                        {formatDate(member.createdAt)}
                                    </td>
                                    {/* Actions */}
                                    <td className="px-6 py-4">
                                        {canMutateStaff ? (
                                            <RowActions actions={staffMemberActions(member)} />
                                        ) : showMutationControls ? <DisabledStaffAction /> : null}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    </div>
                </Card>
                </>
            )}

            {data.length > 0 && staffManageDecision.blocker !== "entitlement" && (
                <div className="flex flex-col items-center gap-3 text-center">
                    <p id="staff-pagination-status" className={cn("text-sm", pageMutedTextClass)} aria-live="polite">
                        Showing {data.length} of {total} staff member{total === 1 ? "" : "s"}
                    </p>
                    {nextCursor && (
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => void loadStaff(nextCursor)}
                            isLoading={loadingMore}
                            disabled={loadingMore}
                            aria-describedby="staff-pagination-status"
                            className="min-h-11 min-w-32 justify-center"
                        >
                            {loadingMore ? "Loading..." : "Load more staff"}
                        </Button>
                    )}
                    {loadMoreError && (
                        <div className={cn("flex items-center gap-2 text-sm", formErrorBannerClass)} role="alert">
                            <AlertCircle size={14} aria-hidden="true" />
                            <span>{loadMoreError}</span>
                        </div>
                    )}
                </div>
            )}

            {/* Edit role dialog */}
            {canMutateStaff && (
                <EditRoleDialog
                    isOpen={!!editTarget}
                    member={editTarget}
                    branchId={branchId}
                    onClose={() => setEditTarget(null)}
                    onSuccess={updated => {
                        setData(prev => prev.map(m => m.id === updated.id ? updated : m));
                        setEditTarget(null);
                        showToast("Staff access updated.");
                    }}
                    capability={staffManageDecision}
                />
            )}

            {/* Add staff dialog */}
            {canMutateStaff && (
                <AddStaffDialog
                    isOpen={addOpen}
                    branchId={branchId}
                    onClose={() => setAddOpen(false)}
                    onSuccess={member => {
                        setData(prev => [...prev, member]);
                        setTotal(current => current + 1);
                        showToast(`Staff member added.`);
                    }}
                    capability={staffManageDecision}
                />
            )}

            {/* Remove staff dialog */}
            {canMutateStaff && (
                <ConfirmDialog
                    isOpen={!!removeTarget}
                    onClose={() => setRemoveTarget(null)}
                    onConfirm={confirmRemove}
                    title="Remove Staff"
                    description={`Are you sure you want to remove ${removeTarget?.user?.name || removeTarget?.user?.email} from this branch?`}
                    confirmText="Remove"
                    variant="danger"
                    loading={removeLoading}
                />
            )}
        </div>
    );
}
