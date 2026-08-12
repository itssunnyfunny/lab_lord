import { cn } from "@/lib/utils";
import { Loader2, LucideIcon } from "lucide-react";
import { ButtonHTMLAttributes, forwardRef } from "react";

export interface AppButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "primary" | "secondary" | "quiet" | "danger" | "ghost" | "outline" | "glow" | "cyan";
    size?: "sm" | "md" | "lg" | "icon";
    icon?: LucideIcon;
    rightIcon?: LucideIcon;
    isLoading?: boolean;
}

const variantClasses = {
    primary:
        "border-[color:var(--ui-button-primary-border)] bg-[color:var(--ui-button-primary-bg)] text-[color:var(--ui-button-primary-text)] shadow-[var(--ui-button-primary-shadow)] hover:border-[color:var(--ui-button-primary-hover-border)] hover:bg-[color:var(--ui-button-primary-hover-bg)]",
    secondary:
        "border-[color:var(--ui-button-secondary-border)] bg-[color:var(--ui-button-secondary-bg)] text-[color:var(--ui-button-secondary-text)] shadow-[var(--ui-button-secondary-shadow)] hover:border-[color:var(--ui-button-secondary-hover-border)] hover:bg-[color:var(--ui-button-secondary-hover-bg)]",
    quiet:
        "border-[color:var(--ui-button-quiet-border)] bg-[color:var(--ui-button-quiet-bg)] text-[color:var(--ui-button-quiet-text)] hover:border-[color:var(--ui-button-quiet-hover-border)] hover:bg-[color:var(--ui-button-quiet-hover-bg)] hover:text-[color:var(--ui-button-quiet-hover-text)]",
    danger:
        "border-[color:var(--ui-button-danger-border)] bg-[color:var(--ui-button-danger-bg)] text-[color:var(--ui-button-danger-text)] hover:border-[color:var(--ui-button-danger-hover-border)] hover:bg-[color:var(--ui-button-danger-hover-bg)]",
    ghost:
        "border-[color:var(--ui-button-quiet-border)] bg-[color:var(--ui-button-quiet-bg)] text-[color:var(--ui-button-quiet-text)] hover:border-[color:var(--ui-button-quiet-hover-border)] hover:bg-[color:var(--ui-button-quiet-hover-bg)] hover:text-[color:var(--ui-button-quiet-hover-text)]",
    outline:
        "border-[color:var(--ui-button-secondary-border)] bg-[color:var(--ui-button-secondary-bg)] text-[color:var(--ui-button-secondary-text)] shadow-[var(--ui-button-secondary-shadow)] hover:border-[color:var(--ui-button-secondary-hover-border)] hover:bg-[color:var(--ui-button-secondary-hover-bg)]",
    glow:
        "border-[color:var(--ui-button-primary-border)] bg-[color:var(--ui-button-primary-bg)] text-[color:var(--ui-button-primary-text)] shadow-[var(--ui-button-primary-shadow)] hover:border-[color:var(--ui-button-primary-hover-border)] hover:bg-[color:var(--ui-button-primary-hover-bg)]",
    cyan:
        "border-[color:var(--ui-button-primary-border)] bg-[color:var(--ui-button-primary-bg)] text-[color:var(--ui-button-primary-text)] shadow-[var(--ui-button-primary-shadow)] hover:border-[color:var(--ui-button-primary-hover-border)] hover:bg-[color:var(--ui-button-primary-hover-bg)]",
};

const sizeClasses = {
    sm: "h-11 px-2.5 text-xs sm:h-8",
    md: "h-11 px-3 text-sm sm:h-10",
    lg: "h-12 px-4 text-base",
    icon: "h-11 w-11 p-0 sm:h-10 sm:w-10",
};

export const AppButton = forwardRef<HTMLButtonElement, AppButtonProps>(
    (
        {
            children,
            className,
            variant = "secondary",
            size = "md",
            icon: Icon,
            rightIcon: RightIcon,
            isLoading,
            type = "button",
            disabled,
            ...props
        },
        ref
    ) => {
        const iconSize = size === "sm" ? 14 : 15;

        return (
            <button
                ref={ref}
                type={type}
                disabled={disabled || isLoading}
                aria-busy={isLoading || undefined}
                className={cn(
                    "group inline-flex cursor-pointer items-center justify-center gap-2 rounded-[var(--ui-radius-control)] border font-semibold tracking-[0.01em] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]",
                    variantClasses[variant],
                    sizeClasses[size],
                    className
                )}
                {...props}
            >
                {isLoading ? (
                    <Loader2 size={iconSize} className="shrink-0 animate-spin" />
                ) : (
                    Icon && <Icon size={iconSize} className="shrink-0" />
                )}
                {children && <span className="inline-flex min-w-0 items-center gap-2 truncate">{children}</span>}
                {RightIcon && !isLoading && (
                    <RightIcon
                        size={iconSize}
                        className="shrink-0 transition-transform duration-200 group-hover:translate-x-0.5"
                    />
                )}
            </button>
        );
    }
);

AppButton.displayName = "AppButton";
