import { cn } from "@/lib/utils";
import { Loader2, LucideIcon } from "lucide-react";
import { ButtonHTMLAttributes, forwardRef } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "primary" | "secondary" | "ghost" | "danger" | "outline" | "glow" | "cyan";
    size?: "sm" | "md" | "lg" | "icon";
    isLoading?: boolean;
    icon?: LucideIcon;
}

const variantClasses = {
    primary:
        "border-[color:var(--ui-button-primary-border)] bg-[color:var(--ui-button-primary-bg)] text-[color:var(--ui-button-primary-text)] shadow-[var(--ui-button-primary-shadow)] hover:border-[color:var(--ui-button-primary-hover-border)] hover:bg-[color:var(--ui-button-primary-hover-bg)]",
    secondary:
        "border-[color:var(--ui-button-secondary-border)] bg-[color:var(--ui-button-secondary-bg)] text-[color:var(--ui-button-secondary-text)] shadow-[var(--ui-button-secondary-shadow)] hover:border-[color:var(--ui-button-secondary-hover-border)] hover:bg-[color:var(--ui-button-secondary-hover-bg)]",
    outline:
        "border-[color:var(--ui-button-secondary-border)] bg-[color:var(--ui-button-secondary-bg)] text-[color:var(--ui-button-secondary-text)] shadow-[var(--ui-button-secondary-shadow)] hover:border-[color:var(--ui-button-secondary-hover-border)] hover:bg-[color:var(--ui-button-secondary-hover-bg)]",
    ghost:
        "border-[color:var(--ui-button-quiet-border)] bg-[color:var(--ui-button-quiet-bg)] text-[color:var(--ui-button-quiet-text)] hover:border-[color:var(--ui-button-quiet-hover-border)] hover:bg-[color:var(--ui-button-quiet-hover-bg)] hover:text-[color:var(--ui-button-quiet-hover-text)]",
    danger:
        "border-[color:var(--ui-button-danger-border)] bg-[color:var(--ui-button-danger-bg)] text-[color:var(--ui-button-danger-text)] hover:border-[color:var(--ui-button-danger-hover-border)] hover:bg-[color:var(--ui-button-danger-hover-bg)]",
    glow:
        "border-[color:var(--ui-button-primary-border)] bg-[color:var(--ui-button-primary-bg)] text-[color:var(--ui-button-primary-text)] shadow-[var(--ui-button-primary-shadow)] hover:border-[color:var(--ui-button-primary-hover-border)] hover:bg-[color:var(--ui-button-primary-hover-bg)]",
    cyan:
        "border-[color:var(--ui-button-primary-border)] bg-[color:var(--ui-button-primary-bg)] text-[color:var(--ui-button-primary-text)] shadow-[var(--ui-button-primary-shadow)] hover:border-[color:var(--ui-button-primary-hover-border)] hover:bg-[color:var(--ui-button-primary-hover-bg)]",
};

const sizeClasses = {
    sm: "h-8 px-2.5 text-xs",
    md: "h-10 px-3 text-sm",
    lg: "h-11 px-4 text-base",
    icon: "h-10 w-10 p-0",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = "primary", size = "md", isLoading, icon: Icon, children, disabled, type = "button", ...props }, ref) => {

        return (
            <button
                ref={ref}
                type={type}
                disabled={isLoading || disabled}
                className={cn(
                    "group inline-flex cursor-pointer items-center justify-center gap-2 rounded-[var(--ui-radius-control)] border font-semibold tracking-[0.01em] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]",
                    variantClasses[variant],
                    sizeClasses[size],
                    className
                )}
                {...props}
            >
                {isLoading && <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
                {!isLoading && Icon && <Icon size={16} className="shrink-0" />}
                {children && <span className="inline-flex min-w-0 items-center gap-2 truncate">{children}</span>}
            </button>
        );
    }
);

Button.displayName = "Button";
