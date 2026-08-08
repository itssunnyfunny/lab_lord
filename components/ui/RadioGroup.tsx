"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

export type RadioOption<T extends string> = {
    value: T;
    label: string;
    description?: string;
    disabled?: boolean;
};

export function RadioGroup<T extends string>({
    value,
    options,
    onChange,
    id,
    labelledBy,
    describedBy,
    className,
}: {
    value: T;
    options: RadioOption<T>[];
    onChange: (value: T) => void;
    id?: string;
    labelledBy?: string;
    describedBy?: string;
    className?: string;
}) {
    const refs = useRef<Array<HTMLButtonElement | null>>([]);
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);

    const move = (currentIndex: number, delta: number) => {
        const position = Math.max(0, enabled.indexOf(currentIndex));
        const nextIndex = enabled[(position + delta + enabled.length) % enabled.length];
        const option = options[nextIndex];
        if (!option) return;
        onChange(option.value);
        refs.current[nextIndex]?.focus();
    };

    return (
        <div
            id={id}
            role="radiogroup"
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            className={cn("flex flex-wrap gap-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] p-1", className)}
        >
            {options.map((option, index) => {
                const active = value === option.value;
                return (
                    <button
                        key={option.value}
                        ref={element => { refs.current[index] = element; }}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={option.disabled}
                        tabIndex={active ? 0 : -1}
                        onClick={() => onChange(option.value)}
                        onKeyDown={event => {
                            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                                event.preventDefault();
                                move(index, 1);
                            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                                event.preventDefault();
                                move(index, -1);
                            } else if (event.key === "Home") {
                                event.preventDefault();
                                const first = enabled[0];
                                if (first !== undefined) move(first, 0);
                            } else if (event.key === "End") {
                                event.preventDefault();
                                const last = enabled[enabled.length - 1];
                                if (last !== undefined) move(last, 0);
                            }
                        }}
                        className={cn(
                            "min-h-9 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]",
                            active
                                ? "bg-[color:var(--ui-view-toggle-table-active-bg)] text-[color:var(--ui-view-toggle-table-active-text)]"
                                : "text-[color:var(--ui-table-muted)] hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--ui-table-text)]"
                        )}
                    >
                        <span className="block">{option.label}</span>
                        {option.description ? <span className="mt-0.5 block text-[11px] opacity-80">{option.description}</span> : null}
                    </button>
                );
            })}
        </div>
    );
}
