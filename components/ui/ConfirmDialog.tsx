"use client";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { cn } from "@/lib/utils";
import { AlertCircle, AlertTriangle, Info, type LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
    title: string;
    description: React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    loading?: boolean;
    variant?: "danger" | "warning" | "info" | "default";
}

type ConfirmVariant = NonNullable<ConfirmDialogProps["variant"]>;

const dialogVariants: Record<ConfirmVariant, {
    icon: LucideIcon;
    iconClassName: string;
    iconBgClassName: string;
    buttonVariant: ComponentProps<typeof Button>["variant"];
}> = {
    danger: {
        icon: AlertCircle,
        iconClassName: "text-[color:var(--ui-dialog-icon-danger-text)]",
        iconBgClassName: "bg-[color:var(--ui-dialog-icon-danger-bg)]",
        buttonVariant: "danger",
    },
    warning: {
        icon: AlertTriangle,
        iconClassName: "text-[color:var(--ui-dialog-icon-warning-text)]",
        iconBgClassName: "bg-[color:var(--ui-dialog-icon-warning-bg)]",
        buttonVariant: "cyan",
    },
    info: {
        icon: Info,
        iconClassName: "text-[color:var(--ui-dialog-icon-info-text)]",
        iconBgClassName: "bg-[color:var(--ui-dialog-icon-info-bg)]",
        buttonVariant: "cyan",
    },
    default: {
        icon: Info,
        iconClassName: "text-[color:var(--ui-dialog-icon-default-text)]",
        iconBgClassName: "bg-[color:var(--ui-dialog-icon-default-bg)]",
        buttonVariant: "cyan",
    },
};

export function ConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title,
    description,
    confirmText = "Confirm",
    cancelText = "Cancel",
    loading = false,
    variant = "default",
}: ConfirmDialogProps) {
    const tone = dialogVariants[variant];
    const DialogIcon = tone.icon;

    return (
        <Dialog
            open={isOpen}
            onClose={onClose}
            role="alertdialog"
            title={title}
            description={description}
            closeLabel={`Close ${title}`}
            closeDisabled={loading}
            className="max-w-sm"
            icon={(
                <div className={cn("rounded-full p-2", tone.iconBgClassName)}>
                    <DialogIcon className={cn("h-6 w-6", tone.iconClassName)} aria-hidden="true" />
                </div>
            )}
            footer={(
                <>
                    <Button
                        variant="ghost"
                        onClick={onClose}
                        disabled={loading}
                        data-dialog-initial-focus
                    >
                        {cancelText}
                    </Button>
                    <Button
                        variant={tone.buttonVariant}
                        onClick={() => void onConfirm()}
                        isLoading={loading}
                    >
                        {confirmText}
                    </Button>
                </>
            )}
        />
    );
}
