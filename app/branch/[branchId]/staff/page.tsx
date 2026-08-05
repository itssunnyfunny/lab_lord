"use client";

import { useCallback, useEffect, useState, use } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageLoadingSkeleton } from "@/components/ui";
import { BranchAccessGuard } from "@/components/auth/BranchAccessGuard";
import {
    Loader2, AlertCircle,
    Pencil, Trash2, X, CheckCircle2, Shield, UserCog,
    UserPlus, Mail, Link2, Copy, SlidersHorizontal, RotateCcw,
} from "lucide-react";
import { staff, StaffInviteResponse, StaffWithUser } from "@/lib/api/staff";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { RowActionsMenu, type RowActionsMenuItem } from "@/components/ui/RowActionsMenu";
import {
    formCompactLabelClass,
    formControlClass,
    formDialogFooterClass,
    formDialogHeaderClass,
    formDialogOverlayClass,
    formDialogPanelClass,
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
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import type { OverridableStaffAction, StaffPermissionUpdate } from "@/types";
import { BRANCH_PAGE_ACCESS } from "@/lib/branchPageAccess";
import { getPermissionHelpText } from "@/lib/permissionMessages";
import { validateOptionalEmail, validateRequiredText } from "@/lib/formValidation";

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
            className={cn(
                "inline-flex h-8 min-w-0 items-center justify-center gap-1 rounded-lg px-2 text-[11px] font-semibold transition-colors",
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
}

function EditRoleDialog({ isOpen, member, branchId, onClose, onSuccess }: EditRoleDialogProps) {
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
        <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-4">
            <div className={cn("cursor-pointer", formDialogOverlayClass)} onClick={onClose} />
            <div className={cn("relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col sm:max-h-[90vh]", formDialogPanelClass)}>
                {/* Header */}
                <div className={cn("flex flex-shrink-0 items-center justify-between px-4 py-4 sm:px-6", formDialogHeaderClass)}>
                    <div>
                        <h2 className="text-base font-bold text-[color:var(--ui-dialog-title)]">Staff Access</h2>
                        <p className={cn("mt-0.5 text-xs", formHelpTextClass)}>{member.user?.name || member.user?.email}</p>
                    </div>
                    <button onClick={onClose} disabled={loading} className={cn("transition-colors hover:text-[color:var(--ui-table-text)]", formHelpTextClass)}>
                        <X size={18} />
                    </button>
                </div>

                {/* Body */}
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
                    <div className="grid gap-3 md:grid-cols-2">
                        {(["MANAGER", "STAFF"] as const).map(r => (
                            <button
                                key={r}
                                onClick={() => setRole(r)}
                                className={cn(
                                    "w-full flex items-start gap-4 p-4 rounded-xl border transition-all text-left",
                                    role === r
                                        ? "border-cyan-500/40 bg-cyan-500/5"
                                        : "border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-muted-surface-bg)] hover:border-[color:var(--ui-form-input-border)]"
                                )}
                            >
                                <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5",
                                    role === r ? "bg-cyan-500/20" : "bg-[color:var(--ui-form-input-bg)]"
                                )}>
                                    {r === "MANAGER" ? <Shield size={15} className={role === r ? "text-cyan-400" : formIconClass} /> : <UserCog size={15} className={role === r ? "text-cyan-400" : formIconClass} />}
                                </div>
                                <div className="flex-1">
                                    <p className={cn("text-sm font-semibold", role === r ? "text-[color:var(--ui-form-label-strong)]" : "text-[color:var(--ui-form-label)]")}>{ROLE_DETAILS[r].label}</p>
                                    <RolePermissionSummary role={r} />
                                </div>
                                {role === r && <div className="w-4 h-4 rounded-full border-2 border-cyan-500 bg-cyan-500/30 flex-shrink-0 mt-1" />}
                            </button>
                        ))}
                    </div>

                    <PermissionControls
                        role={role}
                        draft={permissionDraft}
                        onChange={handlePermissionChange}
                    />

                    {error && (
                        <div className={cn("flex items-center gap-2 px-3 py-2 text-sm", formErrorBannerClass)}>
                            <AlertCircle size={13} /> {error}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className={cn("flex flex-shrink-0 flex-col-reverse gap-3 px-4 py-4 sm:flex-row sm:justify-end sm:px-6", formDialogFooterClass)}>
                    <Button variant="ghost" onClick={onClose} disabled={loading} className="text-sm h-8 px-3">Cancel</Button>
                    <Button onClick={handleSave} disabled={loading || !hasChanges} className="text-sm h-8 px-4 min-w-[120px] justify-center">
                        {loading
                            ? <><Loader2 size={12} className="animate-spin mr-1.5" /> Saving...</>
                            : "Save Access"
                        }
                    </Button>
                </div>
            </div>
        </div>
    );
}

// ─── Add Staff Dialog ────────────────────────────────────────────────────────

interface AddStaffDialogProps {
    isOpen: boolean;
    branchId: string;
    onClose: () => void;
    onSuccess: (member: StaffMember) => void;
}

function AddStaffDialog({ isOpen, branchId, onClose, onSuccess }: AddStaffDialogProps) {
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
        <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-4">
            <div className={cn("cursor-pointer", formDialogOverlayClass)} onClick={onClose} />
            <div className={cn("relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-md flex-col sm:max-h-[90vh]", formDialogPanelClass)}>
                <div className={cn("flex flex-shrink-0 items-center justify-between px-4 py-4 sm:px-6", formDialogHeaderClass)}>
                    <div>
                        <h2 className="text-base font-bold text-[color:var(--ui-dialog-title)]">Add Staff Member</h2>
                        <p className={cn("mt-0.5 text-xs", formHelpTextClass)}>Enter their account email and assign a role</p>
                    </div>
                    <button onClick={onClose} disabled={loading} className={cn("transition-colors hover:text-[color:var(--ui-table-text)]", formHelpTextClass)}><X size={18} /></button>
                </div>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
                    <div className="space-y-1.5">
                        <label className={formCompactLabelClass}>Email *</label>
                        <div className="relative">
                            <Mail size={14} className={cn("absolute left-3 top-1/2 -translate-y-1/2", formIconClass)} />
                            <input
                                type="email"
                                value={email}
                                onChange={e => { setEmail(e.target.value); setError(null); }}
                                onBlur={() => markTouched("email")}
                                placeholder="teammate@example.com"
                                autoFocus
                                className={cn(formControlClass, "py-2.5 pl-9 pr-4 text-sm", fieldErrorClass(emailError))}
                                {...fieldErrorProps("add-staff-email-error", emailError)}
                            />
                        </div>
                        <FieldError id="add-staff-email-error" error={emailError} />
                        <p className="text-xs text-[color:var(--ui-table-subtle)]">The user must sign in once before they can be added.</p>
                    </div>

                    <div className="space-y-1.5">
                        <label className={formCompactLabelClass}>Role</label>
                        <div className="grid gap-2">
                            {(["MANAGER", "STAFF"] as const).map(r => (
                                <button key={r} onClick={() => setRole(r)}
                                    className={cn("rounded-[var(--ui-radius-control)] border p-3 text-left transition-all",
                                        role === r
                                            ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-400"
                                            : cn("text-[color:var(--ui-form-label)]", formSurfaceClass, formSurfaceHoverClass)
                                    )}>
                                    <div className="flex items-center gap-2 text-sm font-semibold">
                                        {r === "MANAGER" ? <Shield size={14} /> : <UserCog size={14} />}
                                        {ROLE_DETAILS[r].label}
                                    </div>
                                    {role === r && <RolePermissionSummary role={r} />}
                                </button>
                            ))}
                        </div>
                    </div>

                    {error && (
                        <div className={cn("flex items-center gap-2 px-3 py-2 text-sm", formErrorBannerClass)}>
                            <AlertCircle size={13} /> {error}
                        </div>
                    )}
                </div>

                <div className={cn("flex flex-shrink-0 flex-col-reverse gap-3 px-4 py-4 sm:flex-row sm:justify-end sm:px-6", formDialogFooterClass)}>
                    <Button variant="ghost" onClick={onClose} disabled={loading} className="text-sm h-8 px-3">Cancel</Button>
                    <Button onClick={handleAdd} disabled={loading} className="text-sm h-8 px-4 min-w-[100px] justify-center">
                        {loading
                            ? <><Loader2 size={12} className="animate-spin mr-1.5" /> Adding...</>
                            : "Add Staff"
                        }
                    </Button>
                </div>
            </div>
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function InviteLinkPanel({
    inviteRole,
    invite,
    activeInvites,
    loading,
    invitesLoading,
    error,
    copiedInviteId,
    revokingInviteId,
    onRoleChange,
    onCreateInvite,
    onCopyInvite,
    onRevokeInvite,
}: {
    inviteRole: StaffRoleOption;
    invite: StaffInviteResponse | null;
    activeInvites: StaffInviteResponse[];
    loading: boolean;
    invitesLoading: boolean;
    error: string | null;
    copiedInviteId: string | null;
    revokingInviteId: string | null;
    onRoleChange: (role: StaffRoleOption) => void;
    onCreateInvite: () => void;
    onCopyInvite: (invite: StaffInviteResponse) => void;
    onRevokeInvite: (inviteId: string) => void;
}) {
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
                        Create a one-use link for a new staff member. Links expire in 7 days.
                    </p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className={cn("grid grid-cols-2 gap-2 p-1", formSurfaceClass)}>
                        {(["MANAGER", "STAFF"] as const).map(role => (
                            <button
                                key={role}
                                type="button"
                                onClick={() => onRoleChange(role)}
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
                    <Button onClick={onCreateInvite} isLoading={loading} disabled={loading} className="h-10 whitespace-nowrap">
                        Create invite
                    </Button>
                </div>
            </div>

            {invite && (
                <div className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/[0.04] p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold uppercase tracking-wider text-cyan-200">Latest invite</span>
                        <span className={cn("text-xs", formHelpTextClass)}>Expires {format(new Date(invite.expiresAt), "PPp")}</span>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                            readOnly
                            value={invite.inviteUrl}
                            className={cn(formControlClass, "h-10 min-w-0 flex-1 px-3 font-mono text-xs")}
                        />
                        <Button variant="outline" onClick={() => onCopyInvite(invite)} className="h-10 whitespace-nowrap">
                            {copiedInviteId === invite.id ? <><CheckCircle2 size={14} /> Copied</> : <><Copy size={14} /> Copy link</>}
                        </Button>
                        <Button
                            variant="danger"
                            isLoading={revokingInviteId === invite.id}
                            onClick={() => onRevokeInvite(invite.id)}
                            className="h-10 whitespace-nowrap"
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
                                        <span className={cn("text-xs", formHelpTextClass)}>Expires {format(new Date(item.expiresAt), "PPp")}</span>
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
        <BranchAccessGuard branchId={branchId} permission={BRANCH_PAGE_ACCESS.staff} feature="STAFF_CONTROLS">
            {access => (
                <StaffContent
                    branchId={branchId}
                    canManageStaff={access.permissions.staff_management}
                />
            )}
        </BranchAccessGuard>
    );
}

function StaffContent({
    branchId,
    canManageStaff,
}: {
    branchId: string;
    canManageStaff: boolean;
}) {
    const staffManagementHelpText = getPermissionHelpText("staff_management");
    const [data, setData] = useState<StaffMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

    const [editTarget, setEditTarget] = useState<StaffMember | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [inviteRole, setInviteRole] = useState<StaffRoleOption>("STAFF");
    const [invite, setInvite] = useState<StaffInviteResponse | null>(null);
    const [activeInvites, setActiveInvites] = useState<StaffInviteResponse[]>([]);
    const [inviteLoading, setInviteLoading] = useState(false);
    const [invitesLoading, setInvitesLoading] = useState(false);
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);
    const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);

    const [removeTarget, setRemoveTarget] = useState<StaffMember | null>(null);
    const [removeLoading, setRemoveLoading] = useState(false);

    const showToast = (msg: string, type: "success" | "error" = "success") => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3500);
    };

    const loadStaff = useCallback(async () => {
        try {
            const list = await staff.list(branchId);
            setData(list);
            setError(null);
        } catch {
            setError("Failed to load staff.");
        } finally {
            setLoading(false);
        }
    }, [branchId]);

    useEffect(() => { loadStaff(); }, [loadStaff]);

    const loadInvites = useCallback(async () => {
        if (!canManageStaff) return;
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
    }, [branchId, canManageStaff]);

    useEffect(() => { loadInvites(); }, [loadInvites]);

    const handleCreateInvite = async () => {
        setInviteLoading(true);
        setInviteError(null);
        setCopiedInviteId(null);
        try {
            const created = await staff.createInvite(branchId, { role: inviteRole });
            setInvite(created);
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
        setRemoveTarget(member);
    };

    const confirmRemove = async () => {
        if (!removeTarget) return;
        setRemoveLoading(true);
        try {
            const res = await fetch(`/api/branches/${branchId}/staff/${removeTarget.id}`, { method: "DELETE" });
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                throw new Error(d.error || "Remove failed");
            }
            setData(prev => prev.filter(s => s.id !== removeTarget.id));
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
            onClick: () => setEditTarget(member),
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
                    className={cn(pageGridCardClass, pageGridCardHoverClass)}
                >
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500/20 to-purple-600/20 border border-[color:var(--ui-card-border)] flex items-center justify-center text-sm font-bold text-cyan-300 flex-shrink-0">
                                {(member.user?.name || member.user?.email || "?")[0].toUpperCase()}
                            </div>
                            <div className="min-w-0">
                                <p className="truncate font-medium text-[color:var(--ui-table-text)]">{member.user?.name || <span className={cn("italic text-xs", pageSubtleTextClass)}>No name</span>}</p>
                                <p className={cn("mt-1 flex min-w-0 items-center gap-1 truncate text-xs", pageSubtleTextClass)}>
                                    <Mail size={10} className="flex-shrink-0" />{member.user?.email}
                                </p>
                            </div>
                        </div>
                        {canManageStaff ? (
                            <RowActions actions={staffMemberActions(member)} />
                        ) : (
                            <span className={cn("text-xs", pageSubtleTextClass)} title={staffManagementHelpText}>
                                View only
                            </span>
                        )}
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
                            <div className={cn("mt-2 text-xs", pageMutedTextClass)}>{format(new Date(member.createdAt), "PP")}</div>
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
        <div className="p-4 md:p-8 space-y-6 relative">
            {/* Toast */}
            {toast && (
                <div className={cn(
                    "fixed bottom-4 left-4 right-4 z-50 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-2xl animate-in fade-in slide-in-from-bottom-2 sm:bottom-6 sm:left-auto sm:right-6 sm:w-auto",
                    toast.type === "success"
                        ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                        : "bg-red-500/10 border-red-500/20 text-red-400"
                )}>
                    {toast.type === "success" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                    {toast.msg}
                </div>
            )}

            <PageHeader
                title="Staff"
                subtitle="Manage team members and their access roles."
                onAdd={canManageStaff ? () => setAddOpen(true) : undefined}
                actionLabel="Add Staff"
            />

            {!canManageStaff && (
                <div className={cn("px-4 py-3 text-sm", formWarningBannerClass)}>
                    Staff changes and invite links are disabled. {staffManagementHelpText}
                </div>
            )}

            {canManageStaff && (
                <InviteLinkPanel
                    inviteRole={inviteRole}
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
                    onCreateInvite={handleCreateInvite}
                    onCopyInvite={handleCopyInvite}
                    onRevokeInvite={handleRevokeInvite}
                />
            )}

            {data.length === 0 ? (
                <div className={cn("space-y-3", pageEmptyStateClass)}>
                    <UserPlus size={36} className="mx-auto opacity-30" />
                    <p>No staff members yet.</p>
                    {canManageStaff && (
                        <button onClick={() => setAddOpen(true)} className="text-sm text-[color:var(--ui-form-accent)] transition-colors hover:text-[color:var(--ui-form-accent-hover)]">
                            + Add your first staff member
                        </button>
                    )}
                </div>
            ) : (
                <>
                <div className="md:hidden">{staffCards}</div>
                <Card noHover className="hidden overflow-visible p-0 md:block md:p-0">
                    <div className="w-full overflow-x-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                    <table className="w-full min-w-[54rem] text-left text-sm">
                        <thead>
                            <tr className="border-b border-[color:var(--ui-table-divider)] bg-[color:var(--ui-table-head-bg)] text-[color:var(--ui-table-muted)]">
                                <th className="px-6 py-4 font-medium">Member</th>
                                <th className="px-6 py-4 font-medium">Role</th>
                                <th className="px-6 py-4 font-medium">Access</th>
                                <th className="px-6 py-4 font-medium">Added</th>
                                <th className="px-6 py-4 font-medium w-14" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[color:var(--ui-table-divider)]">
                            {data.map(member => (
                                <tr key={member.id} className="group transition-colors hover:bg-[color:var(--ui-table-row-hover-bg)]">
                                    {/* Member */}
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-500/20 to-purple-600/20 border border-[color:var(--ui-card-border)] flex items-center justify-center text-sm font-bold text-cyan-300 flex-shrink-0">
                                                {(member.user?.name || member.user?.email || "?")[0].toUpperCase()}
                                            </div>
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
                                        {format(new Date(member.createdAt), "PP")}
                                    </td>
                                    {/* Actions */}
                                    <td className="px-6 py-4">
                                        {canManageStaff ? (
                                            <RowActions actions={staffMemberActions(member)} />
                                        ) : (
                                            <span className="text-xs text-[color:var(--ui-table-subtle)]" title={staffManagementHelpText}>
                                                View only
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    </div>
                </Card>
                </>
            )}

            {/* Edit role dialog */}
            {canManageStaff && (
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
                />
            )}

            {/* Add staff dialog */}
            {canManageStaff && (
                <AddStaffDialog
                    isOpen={addOpen}
                    branchId={branchId}
                    onClose={() => setAddOpen(false)}
                    onSuccess={member => {
                        setData(prev => [...prev, member]);
                        showToast(`Staff member added.`);
                    }}
                />
            )}

            {/* Remove staff dialog */}
            {canManageStaff && (
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
