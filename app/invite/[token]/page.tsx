import Link from "next/link";
import { CheckCircle2, Clock, ShieldAlert, UserPlus } from "lucide-react";
import { LogoMark } from "@/components/brand/AppLogo";
import { AmbientBackground } from "@/components/ui/AmbientBackground";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { getSessionUser } from "@/lib/auth";
import { StaffInviteService } from "@/services/staffInvite.service";
import { InviteAcceptanceActions } from "./InviteAcceptanceActions";
import {
    entryContentClass,
    entryIconFrameClass,
    entryInlineInfoClass,
    entryMutedTextClass,
    entryPanelClass,
    entryPrimaryLinkClass,
    entryRootClass,
    entrySecondaryLinkClass,
    entrySubtitleClass,
    entryTitleClass,
} from "@/components/ui/entrySurface";

export const dynamic = "force-dynamic";

type InvitePageProps = {
    params: Promise<{ token: string }>;
};

function AuthLinks({ invitePath }: { invitePath: string }) {
    const encodedRedirect = encodeURIComponent(invitePath);

    return (
        <div className="flex flex-col gap-3 sm:flex-row">
            <Link href={`/sign-in?redirect_url=${encodedRedirect}`} className={cn(entryPrimaryLinkClass, "w-full")}>
                <UserPlus size={16} />
                Sign in to join
            </Link>
            <Link href={`/sign-up?redirect_url=${encodedRedirect}`} className={cn(entrySecondaryLinkClass, "w-full")}>
                Create account
            </Link>
        </div>
    );
}

function InviteState({
    title,
    message,
    variant = "default",
}: {
    title: string;
    message: string;
    variant?: "default" | "success" | "danger";
}) {
    const Icon = variant === "success" ? CheckCircle2 : variant === "danger" ? ShieldAlert : Clock;

    return (
        <main className={entryRootClass}>
            <AmbientBackground />
            <section className={cn(entryContentClass, entryPanelClass, "max-w-lg p-5 sm:p-8")}>
                <div className={cn(entryIconFrameClass, "mb-5 flex h-12 w-12", variant === "danger" && "text-[color:var(--ui-badge-danger-text)]")}>
                    <Icon size={24} />
                </div>
                <h1 className={entryTitleClass}>{title}</h1>
                <p className={cn("mt-3", entrySubtitleClass)}>{message}</p>
                <Link
                    href="/app"
                    className={cn(entrySecondaryLinkClass, "mt-6")}
                >
                    Return to workspaces
                </Link>
            </section>
        </main>
    );
}

export default async function StaffInvitePage({ params }: InvitePageProps) {
    const { token } = await params;
    const invitePath = `/invite/${token}`;

    let invite;
    try {
        invite = await StaffInviteService.getInvitePreview(token);
    } catch {
        return (
            <InviteState
                title="Invite not found"
                message="This invite link is invalid, has been removed, or uses an older format. Ask the branch owner to send a fresh link."
                variant="danger"
            />
        );
    }

    if (invite.acceptedAt) {
        return (
            <InviteState
                title="Invite already used"
                message="This invite link has already been accepted. Ask the branch owner for a new link if another staff member needs access."
                variant="danger"
            />
        );
    }

    if (invite.isExpired) {
        return (
            <InviteState
                title="Invite expired"
                message="This invite link has expired. Ask the branch owner to generate a new one from Staff Management."
                variant="danger"
            />
        );
    }

    const user = await getSessionUser();

    return (
        <main className={entryRootClass}>
            <AmbientBackground />
            <section className={cn(entryContentClass, entryPanelClass, "max-w-xl p-5 sm:p-8")}>
                <div className={cn(entryIconFrameClass, "mb-6 h-14 w-14")}>
                    <LogoMark className="h-11 w-11" title="Lab Lords logo" />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <h1 className={entryTitleClass}>Join {invite.branch.name}</h1>
                    <Badge variant={invite.role === "MANAGER" ? "cyan" : "default"}>
                        {invite.role === "MANAGER" ? "Manager" : "Staff"}
                    </Badge>
                </div>
                <p className={cn("mt-2 text-sm", entryMutedTextClass)}>{invite.branch.organization.name}</p>
                <p className={cn("mt-5", entrySubtitleClass)}>
                    {user
                        ? "Review the workspace and role below, then explicitly accept when you are ready. No access is created until you confirm."
                        : "Sign in or create an account to review and accept this branch invite. This link only works for the intended email address."}
                </p>
                <div className={cn(entryInlineInfoClass, "mt-6 p-4 text-sm", entryMutedTextClass)}>
                    <dl className="grid gap-3 sm:grid-cols-2">
                        <div>
                            <dt className="text-xs uppercase tracking-wide text-[color:var(--text-muted)]">Role</dt>
                            <dd className="mt-1 font-medium text-[color:var(--text-primary)]">
                                {invite.role === "MANAGER" ? "Manager" : "Staff"}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-xs uppercase tracking-wide text-[color:var(--text-muted)]">Expires</dt>
                            <dd className="mt-1 font-medium text-[color:var(--text-primary)]">
                                {invite.expiresAt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                            </dd>
                        </div>
                    </dl>
                </div>
                {user ? (
                    <InviteAcceptanceActions
                        token={token}
                        invitePath={invitePath}
                        signedInEmail={user.email ?? "Current account"}
                    />
                ) : (
                    <div className="mt-6">
                        <AuthLinks invitePath={invitePath} />
                    </div>
                )}
            </section>
        </main>
    );
}
