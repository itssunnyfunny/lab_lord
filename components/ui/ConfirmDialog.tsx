"use client";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { AlertCircle, AlertTriangle, Info, type LucideIcon } from "lucide-react";
import { ComponentProps } from "react";
import { createPortal } from "react-dom";

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
    if (!isOpen || typeof document === "undefined") return null;

    const tone = dialogVariants[variant];
    const DialogIcon = tone.icon;

    const dialogContent = (
        <div className="fixed inset-0 z-[100] flex items-end justify-center p-3 sm:items-center sm:p-4">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-[color:var(--ui-backdrop-bg)] backdrop-blur-sm"
                onClick={!loading ? onClose : undefined}
            />

            {/* Dialog */}
            <div className="relative max-h-[calc(100dvh-1.5rem)] w-full max-w-sm overflow-y-auto rounded-[var(--ui-dialog-radius)] border border-[color:var(--ui-dialog-border)] bg-[color:var(--ui-dialog-bg)] p-4 shadow-[var(--ui-dialog-shadow)] animate-in fade-in zoom-in-95 duration-200 sm:p-6">
                {/* Header */}
                <div className="flex gap-4 items-start">
                    <div className={cn("shrink-0 rounded-full p-2", tone.iconBgClassName)}>
                        <DialogIcon className={cn("h-6 w-6", tone.iconClassName)} />
                    </div>
                    <div className="space-y-1.5 mt-0.5">
                        <h2 className="text-lg font-bold leading-tight text-[color:var(--ui-dialog-title)]">{title}</h2>
                        <div className="text-sm text-[color:var(--ui-dialog-description)]">{description}</div>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex flex-col-reverse gap-3 mt-8 sm:flex-row sm:justify-end">
                    <Button variant="ghost" onClick={onClose} disabled={loading}>
                        {cancelText}
                    </Button>
                    <Button
                        variant={tone.buttonVariant}
                        onClick={() => void onConfirm()}
                        isLoading={loading}
                    >
                        {confirmText}
                    </Button>
                </div>
            </div>
        </div>
    );

    return createPortal(dialogContent, document.body);
}
