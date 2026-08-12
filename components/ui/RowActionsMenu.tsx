"use client";

import { cn } from "@/lib/utils";
import { MoreVertical } from "lucide-react";
import { type CSSProperties, type ElementType, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface RowActionsMenuItem {
    label: string;
    icon: ElementType;
    onClick: () => void;
    variant?: "default" | "danger" | "warning";
    disabled?: boolean;
    description?: string;
}

interface RowActionsMenuProps {
    actions: RowActionsMenuItem[];
    align?: "start" | "end";
    buttonClassName?: string;
    buttonIcon?: ElementType;
    buttonLabel?: string;
    menuClassName?: string;
    menuWidthClassName?: string;
}

export function RowActionsMenu({
    actions,
    align = "end",
    buttonClassName,
    buttonIcon: ButtonIcon = MoreVertical,
    buttonLabel = "Actions",
    menuClassName,
    menuWidthClassName = "w-44",
}: RowActionsMenuProps) {
    const [open, setOpen] = useState(false);
    const [menuStyle, setMenuStyle] = useState<CSSProperties>({
        position: "fixed",
        left: 0,
        top: 0,
        visibility: "hidden",
    });

    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const menuId = useId();

    const enabledIndexes = useMemo(
        () => actions
            .map((action, index) => action.disabled ? -1 : index)
            .filter(index => index >= 0),
        [actions]
    );

    const focusItem = useCallback((index: number) => {
        itemRefs.current[index]?.focus();
    }, []);

    const closeAndRestoreFocus = useCallback(() => {
        setOpen(false);
        queueMicrotask(() => triggerRef.current?.focus());
    }, []);

    const updatePosition = useCallback(() => {
        const trigger = triggerRef.current?.getBoundingClientRect();
        const menu = menuRef.current;

        if (!trigger || !menu) return;

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const gap = 8;
        const margin = 8;
        const menuRect = menu.getBoundingClientRect();
        const menuWidth = menuRect.width;
        const menuHeight = menuRect.height;

        let left = align === "end" ? trigger.right - menuWidth : trigger.left;
        left = Math.min(Math.max(margin, left), Math.max(margin, viewportWidth - menuWidth - margin));

        const spaceBelow = viewportHeight - trigger.bottom - gap;
        const spaceAbove = trigger.top - gap;
        const shouldOpenAbove = menuHeight > spaceBelow && spaceAbove > spaceBelow;

        let top = shouldOpenAbove ? trigger.top - menuHeight - gap : trigger.bottom + gap;
        top = Math.min(Math.max(margin, top), Math.max(margin, viewportHeight - menuHeight - margin));

        setMenuStyle({
            position: "fixed",
            left,
            top,
            visibility: "visible",
        });
    }, [align]);

    useLayoutEffect(() => {
        if (!open) return;

        updatePosition();
        const frame = window.requestAnimationFrame(() => {
            updatePosition();
            if (!menuRef.current?.contains(document.activeElement)) {
                const firstEnabled = enabledIndexes[0];
                if (firstEnabled !== undefined) focusItem(firstEnabled);
            }
        });

        return () => window.cancelAnimationFrame(frame);
    }, [enabledIndexes, focusItem, open, updatePosition]);

    useEffect(() => {
        if (!open) return;

        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target as Node;

            if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
                return;
            }

            setOpen(false);
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeAndRestoreFocus();
            }
        };

        document.addEventListener("mousedown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);

        return () => {
            document.removeEventListener("mousedown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
    }, [closeAndRestoreFocus, open, updatePosition]);

    const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (enabledIndexes.length === 0) return;
        const current = itemRefs.current.findIndex(item => item === document.activeElement);
        const currentPosition = Math.max(0, enabledIndexes.indexOf(current));

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            const nextPosition = (currentPosition + delta + enabledIndexes.length) % enabledIndexes.length;
            focusItem(enabledIndexes[nextPosition]);
        } else if (event.key === "Home") {
            event.preventDefault();
            focusItem(enabledIndexes[0]);
        } else if (event.key === "End") {
            event.preventDefault();
            focusItem(enabledIndexes[enabledIndexes.length - 1]);
        } else if (event.key === "Tab") {
            setOpen(false);
        }
    };

    if (actions.length === 0) return null;

    const menu = open && typeof document !== "undefined"
        ? createPortal(
            <div
                ref={menuRef}
                style={menuStyle}
                className={cn(
                    "z-[120] max-h-[min(20rem,calc(100dvh-1rem))] overflow-y-auto rounded-[var(--ui-menu-radius)] border border-[color:var(--ui-menu-border)] bg-[color:var(--ui-menu-bg)] py-1 shadow-[var(--ui-menu-shadow)] ui-dialog-enter",
                    menuWidthClassName,
                    menuClassName
                )}
                role="menu"
                aria-label={buttonLabel}
                id={menuId}
                onKeyDown={handleMenuKeyDown}
            >
                {actions.map((action, index) => {
                    const Icon = action.icon;

                    return (
                        <button
                            key={`${action.label}-${index}`}
                            ref={element => { itemRefs.current[index] = element; }}
                            type="button"
                            disabled={action.disabled}
                            role="menuitem"
                            onClick={() => {
                                if (action.disabled) return;
                                closeAndRestoreFocus();
                                action.onClick();
                            }}
                            className={cn(
                                "flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                                action.variant === "danger"
                                    ? "text-[color:var(--ui-menu-item-danger-text)] hover:bg-[color:var(--ui-menu-item-danger-hover-bg)]"
                                    : action.variant === "warning"
                                        ? "text-[color:var(--ui-menu-item-warning-text)] hover:bg-[color:var(--ui-menu-item-warning-hover-bg)]"
                                        : "text-[color:var(--ui-menu-item-text)] hover:bg-[color:var(--ui-menu-item-hover-bg)] hover:text-[color:var(--ui-menu-item-hover-text)]"
                            )}
                        >
                            <Icon size={14} className="shrink-0" />
                            <span className="min-w-0">
                                <span className="block truncate">{action.label}</span>
                                {action.description ? <span className="mt-0.5 block text-xs leading-4 opacity-80">{action.description}</span> : null}
                            </span>
                        </button>
                    );
                })}
            </div>,
            document.body
        )
        : null;

    return (
        <div className="flex justify-end">
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen(value => !value)}
                onKeyDown={event => {
                    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                    event.preventDefault();
                    setOpen(true);
                    queueMicrotask(() => {
                        const index = event.key === "ArrowUp"
                            ? enabledIndexes[enabledIndexes.length - 1]
                            : enabledIndexes[0];
                        if (index !== undefined) focusItem(index);
                    });
                }}
                className={cn(
                    "flex h-8 w-8 cursor-pointer items-center justify-center rounded-[var(--ui-radius-control)] text-[color:var(--ui-menu-trigger-text)] transition-all hover:bg-[color:var(--ui-menu-trigger-hover-bg)] hover:text-[color:var(--ui-menu-trigger-hover-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)]",
                    open && "bg-[color:var(--ui-menu-trigger-active-bg)] text-[color:var(--ui-menu-trigger-active-text)]",
                    buttonClassName
                )}
                title={buttonLabel}
                aria-label={buttonLabel}
                aria-expanded={open}
                aria-haspopup="menu"
                aria-controls={open ? menuId : undefined}
            >
                <ButtonIcon size={16} />
            </button>
            {menu}
        </div>
    );
}
