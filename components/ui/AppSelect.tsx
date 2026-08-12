"use client";

import { Check, ChevronDown } from "lucide-react";
import {
    type CSSProperties,
    type FocusEventHandler,
    type KeyboardEvent,
    type ReactNode,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface AppSelectOption {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
}

export interface AppSelectGroup {
    label: string;
    options: readonly AppSelectOption[];
    disabled?: boolean;
}

export type AppSelectItem = AppSelectOption | AppSelectGroup;

export interface AppSelectProps {
    value: string;
    options: readonly AppSelectItem[];
    onValueChange: (value: string) => void;
    id?: string;
    name?: string;
    label?: ReactNode;
    placeholder?: string;
    disabled?: boolean;
    required?: boolean;
    error?: string | null;
    errorId?: string;
    className?: string;
    containerClassName?: string;
    menuClassName?: string;
    labelClassName?: string;
    align?: "start" | "end";
    onBlur?: FocusEventHandler<HTMLButtonElement>;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | "false" | "true" | "grammar" | "spelling";
}

type FlatOption = AppSelectOption & {
    group?: string;
    index: number;
};

function isGroup(item: AppSelectItem): item is AppSelectGroup {
    return "options" in item;
}

function mergeIds(...values: Array<string | undefined>) {
    const ids = values.flatMap(value => value?.split(/\s+/).filter(Boolean) ?? []);
    return ids.length > 0 ? [...new Set(ids)].join(" ") : undefined;
}

export function flattenAppSelectOptions(items: readonly AppSelectItem[]): FlatOption[] {
    const options: FlatOption[] = [];

    items.forEach(item => {
        if (isGroup(item)) {
            item.options.forEach(option => {
                options.push({
                    ...option,
                    disabled: item.disabled || option.disabled,
                    group: item.label,
                    index: options.length,
                });
            });
            return;
        }

        options.push({ ...item, index: options.length });
    });

    return options;
}

export function AppSelect({
    value,
    options,
    onValueChange,
    id,
    name,
    label,
    placeholder = "Select an option",
    disabled = false,
    required = false,
    error,
    errorId,
    className,
    containerClassName,
    menuClassName,
    labelClassName,
    align = "start",
    onBlur,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
}: AppSelectProps) {
    const generatedId = useId().replace(/:/g, "");
    const controlId = id ?? `app-select-${generatedId}`;
    const labelId = label ? `${controlId}-label` : undefined;
    const menuId = `${controlId}-listbox`;
    const resolvedErrorId = errorId ?? (error ? `${controlId}-error` : undefined);
    const describedBy = mergeIds(ariaDescribedBy, error ? resolvedErrorId : undefined);
    const invalid = ariaInvalid ?? Boolean(error);

    const flatOptions = useMemo(() => flattenAppSelectOptions(options), [options]);
    const enabledOptions = useMemo(
        () => flatOptions.filter(option => !option.disabled),
        [flatOptions]
    );
    const selectedOption = flatOptions.find(option => option.value === value);

    const [open, setOpen] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(-1);
    const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
    const [menuStyle, setMenuStyle] = useState<CSSProperties>({
        position: "fixed",
        left: 0,
        top: 0,
        visibility: "hidden",
    });

    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const typeaheadRef = useRef("");
    const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const firstEnabledIndex = enabledOptions[0]?.index ?? -1;
    const lastEnabledIndex = enabledOptions[enabledOptions.length - 1]?.index ?? -1;

    const close = useCallback((restoreFocus = false) => {
        setOpen(false);
        if (restoreFocus) {
            queueMicrotask(() => triggerRef.current?.focus());
        }
    }, []);

    const openMenu = useCallback((preferredIndex?: number) => {
        if (disabled || enabledOptions.length === 0) return;
        setPortalHost(
            triggerRef.current?.closest<HTMLElement>("[data-dialog-overlay='true']") ?? document.body
        );
        const selectedIndex = flatOptions.find(option => option.value === value && !option.disabled)?.index;
        setHighlightedIndex(preferredIndex ?? selectedIndex ?? firstEnabledIndex);
        setOpen(true);
    }, [disabled, enabledOptions.length, firstEnabledIndex, flatOptions, value]);

    const moveHighlight = useCallback((delta: number) => {
        if (enabledOptions.length === 0) return;
        setHighlightedIndex(currentIndex => {
            const position = enabledOptions.findIndex(option => option.index === currentIndex);
            const nextPosition = position < 0
                ? (delta > 0 ? 0 : enabledOptions.length - 1)
                : (position + delta + enabledOptions.length) % enabledOptions.length;
            return enabledOptions[nextPosition].index;
        });
    }, [enabledOptions]);

    const selectOption = useCallback((option: FlatOption) => {
        if (option.disabled) return;
        onValueChange(option.value);
        close(true);
    }, [close, onValueChange]);

    const updatePosition = useCallback(() => {
        const trigger = triggerRef.current?.getBoundingClientRect();
        const menu = menuRef.current;
        if (!trigger || !menu) return;

        const margin = 8;
        const gap = 6;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const availableWidth = Math.max(0, viewportWidth - margin * 2);
        const menuWidth = Math.min(
            Math.max(trigger.width, Math.min(menu.scrollWidth, 360)),
            availableWidth
        );
        const spaceBelow = Math.max(0, viewportHeight - trigger.bottom - gap - margin);
        const spaceAbove = Math.max(0, trigger.top - gap - margin);
        const openAbove = menu.scrollHeight > spaceBelow && spaceAbove > spaceBelow;
        const availableHeight = openAbove ? spaceAbove : spaceBelow;
        const maxHeight = Math.max(72, availableHeight);
        const menuHeight = Math.min(menu.scrollHeight, maxHeight);

        let left = align === "end" ? trigger.right - menuWidth : trigger.left;
        left = Math.min(Math.max(margin, left), Math.max(margin, viewportWidth - menuWidth - margin));
        const top = openAbove
            ? Math.max(margin, trigger.top - gap - menuHeight)
            : Math.min(trigger.bottom + gap, Math.max(margin, viewportHeight - menuHeight - margin));

        setMenuStyle({
            position: "fixed",
            left,
            top,
            width: menuWidth,
            maxHeight,
            visibility: "visible",
        });
    }, [align]);

    useLayoutEffect(() => {
        if (!open) return;
        updatePosition();
        const frame = window.requestAnimationFrame(updatePosition);
        return () => window.cancelAnimationFrame(frame);
    }, [open, updatePosition]);

    useEffect(() => {
        if (!open) return;

        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
            close(false);
        };

        document.addEventListener("mousedown", handlePointerDown);
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        return () => {
            document.removeEventListener("mousedown", handlePointerDown);
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
    }, [close, open, updatePosition]);

    useEffect(() => {
        if (!open || highlightedIndex < 0) return;
        optionRefs.current[highlightedIndex]?.scrollIntoView({ block: "nearest" });
    }, [highlightedIndex, open]);

    useEffect(() => () => {
        if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    }, []);

    const handleTypeahead = (key: string) => {
        if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
        typeaheadRef.current += key.toLocaleLowerCase();
        typeaheadTimerRef.current = setTimeout(() => {
            typeaheadRef.current = "";
        }, 500);

        const query = typeaheadRef.current;
        const currentPosition = enabledOptions.findIndex(option => option.index === highlightedIndex);
        const ordered = [
            ...enabledOptions.slice(currentPosition + 1),
            ...enabledOptions.slice(0, currentPosition + 1),
        ];
        const match = ordered.find(option => option.label.toLocaleLowerCase().startsWith(query));
        if (match) {
            setHighlightedIndex(match.index);
            if (!open) setOpen(true);
        }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (disabled) return;

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
                openMenu(event.key === "ArrowDown" ? firstEnabledIndex : lastEnabledIndex);
            } else {
                moveHighlight(event.key === "ArrowDown" ? 1 : -1);
            }
            return;
        }

        if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            if (!open) openMenu(event.key === "Home" ? firstEnabledIndex : lastEnabledIndex);
            else setHighlightedIndex(event.key === "Home" ? firstEnabledIndex : lastEnabledIndex);
            return;
        }

        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!open) openMenu();
            else {
                const option = flatOptions[highlightedIndex];
                if (option) selectOption(option);
            }
            return;
        }

        if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close(true);
            return;
        }

        if (event.key === "Tab") {
            close(false);
            return;
        }

        if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
            handleTypeahead(event.key);
        }
    };

    const activeDescendant = open && highlightedIndex >= 0
        ? `${controlId}-option-${highlightedIndex}`
        : undefined;

    const menu = open && portalHost
        ? createPortal(
            <div
                ref={menuRef}
                id={menuId}
                role="listbox"
                aria-labelledby={ariaLabelledBy ?? labelId}
                aria-label={!ariaLabelledBy && !labelId ? ariaLabel : undefined}
                style={menuStyle}
                className={cn(
                    "z-[130] overflow-y-auto rounded-[var(--ui-menu-radius)] border border-[color:var(--ui-menu-border)] bg-[color:var(--ui-menu-bg)] py-1 shadow-[var(--ui-menu-shadow)] ui-dialog-enter",
                    menuClassName
                )}
            >
                {options.map((item, itemIndex) => {
                    const group = isGroup(item) ? item : null;
                    const groupOptions: readonly AppSelectOption[] = group
                        ? group.options
                        : [item as AppSelectOption];
                    const indexes = groupOptions.map(groupOption => flatOptions.findIndex(option => (
                        option === groupOption ||
                        (option.value === groupOption.value && option.label === groupOption.label && option.group === group?.label)
                    )));

                    const content = groupOptions.map((option, optionIndex) => {
                        const flatIndex = indexes[optionIndex];
                        const flatOption = flatOptions[flatIndex];
                        if (!flatOption) return null;
                        const selected = flatOption.value === value;
                        const highlighted = flatOption.index === highlightedIndex;

                        return (
                            <button
                                key={`${flatOption.value}-${flatOption.index}`}
                                ref={element => { optionRefs.current[flatOption.index] = element; }}
                                id={`${controlId}-option-${flatOption.index}`}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                aria-disabled={flatOption.disabled || undefined}
                                disabled={flatOption.disabled}
                                tabIndex={-1}
                                onMouseDown={event => event.preventDefault()}
                                onMouseEnter={() => {
                                    if (!flatOption.disabled) setHighlightedIndex(flatOption.index);
                                }}
                                onClick={() => selectOption(flatOption)}
                                className={cn(
                                    "flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-[color:var(--ui-menu-item-text)] transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
                                    !flatOption.disabled && "cursor-pointer hover:bg-[color:var(--ui-menu-item-hover-bg)] hover:text-[color:var(--ui-menu-item-hover-text)]",
                                    highlighted && !flatOption.disabled && "bg-[color:var(--ui-menu-item-hover-bg)] text-[color:var(--ui-menu-item-hover-text)]",
                                    selected && "text-[color:var(--ui-form-accent)]"
                                )}
                            >
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate font-medium">{flatOption.label}</span>
                                    {flatOption.description ? (
                                        <span className="mt-0.5 block text-xs leading-4 text-[color:var(--text-muted)]">
                                            {flatOption.description}
                                        </span>
                                    ) : null}
                                </span>
                                <Check
                                    size={15}
                                    aria-hidden="true"
                                    className={cn("shrink-0", selected ? "opacity-100" : "opacity-0")}
                                />
                            </button>
                        );
                    });

                    if (!group) return <div key={`option-${itemIndex}`}>{content}</div>;
                    return (
                        <div key={`${group.label}-${itemIndex}`} role="group" aria-label={group.label}>
                            <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--text-muted)]">
                                {group.label}
                            </div>
                            {content}
                        </div>
                    );
                })}
            </div>,
            portalHost
        )
        : null;

    return (
        <div className={cn("min-w-0", containerClassName)}>
            {label ? (
                <label
                    id={labelId}
                    htmlFor={controlId}
                    className={cn("mb-1.5 block text-sm font-medium text-[color:var(--ui-form-label)]", labelClassName)}
                >
                    {label}
                </label>
            ) : null}
            {name ? <input type="hidden" name={name} value={value} disabled={disabled} /> : null}
            <button
                ref={triggerRef}
                id={controlId}
                type="button"
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                aria-owns={open ? menuId : undefined}
                aria-activedescendant={activeDescendant}
                aria-label={ariaLabel}
                aria-labelledby={ariaLabelledBy ?? labelId}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                aria-required={required || undefined}
                disabled={disabled}
                onBlur={onBlur}
                onClick={() => open ? close(false) : openMenu()}
                onKeyDown={handleKeyDown}
                className={cn(
                    "flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-input-border)] bg-[color:var(--ui-form-input-bg)] px-3 py-2 text-left text-sm text-[color:var(--ui-form-input-text)] outline-none transition-colors hover:border-[color:var(--ui-form-input-focus-border)] focus-visible:border-[color:var(--ui-form-input-focus-border)] focus-visible:ring-2 focus-visible:ring-[color:var(--ui-form-input-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]",
                    invalid && "border-[color:var(--ui-form-error-border)] focus-visible:border-[color:var(--ui-form-error-focus-border)]",
                    className
                )}
            >
                <span className={cn("min-w-0 flex-1 truncate", !selectedOption && "text-[color:var(--ui-form-input-placeholder)]")}>
                    {selectedOption?.label ?? placeholder}
                </span>
                <ChevronDown
                    size={16}
                    aria-hidden="true"
                    className={cn("shrink-0 text-[color:var(--ui-form-icon)] transition-transform", open && "rotate-180")}
                />
            </button>
            {error ? (
                <p id={resolvedErrorId} role="alert" className="mt-1 text-xs text-[color:var(--ui-form-error-text)]">
                    {error}
                </p>
            ) : null}
            {menu}
        </div>
    );
}
