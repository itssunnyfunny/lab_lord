"use client";

import { cn } from "@/lib/utils";
import {
    cloneElement,
    isValidElement,
    useId,
    type ReactElement,
    type ReactNode,
} from "react";
import { FieldError } from "./InlineFieldError";
import { formHelpTextClass, formLabelClass } from "./formSurface";

type FieldControlProps = {
    id?: string;
    required?: boolean;
    "aria-invalid"?: boolean | "true" | "false";
    "aria-describedby"?: string;
    "aria-required"?: boolean | "true" | "false";
};

export interface FormFieldProps {
    label: string;
    children: ReactElement<FieldControlProps>;
    id?: string;
    description?: ReactNode;
    error?: string | null;
    required?: boolean;
    className?: string;
}

function mergeIds(...values: Array<string | undefined>) {
    const ids = values.flatMap(value => value?.split(/\s+/).filter(Boolean) ?? []);
    return ids.length > 0 ? [...new Set(ids)].join(" ") : undefined;
}

/** Associates one native/custom form control with its label, help, and error. */
export function FormField({
    label,
    children,
    id,
    description,
    error,
    required = false,
    className,
}: FormFieldProps) {
    const generatedId = useId().replace(/:/g, "");

    if (!isValidElement(children)) return null;

    const controlId = children.props.id ?? id ?? `field-${generatedId}`;
    const descriptionId = description ? `${controlId}-description` : undefined;
    const errorId = error ? `${controlId}-error` : undefined;

    const control = cloneElement(children, {
        id: controlId,
        required: children.props.required ?? required,
        "aria-required": children.props["aria-required"] ?? (required || undefined),
        "aria-invalid": children.props["aria-invalid"] ?? (error ? true : undefined),
        "aria-describedby": mergeIds(
            children.props["aria-describedby"],
            descriptionId,
            errorId
        ),
    });

    return (
        <div className={cn("space-y-1.5", className)}>
            <label htmlFor={controlId} className={formLabelClass}>
                {label}
                {required ? <span aria-hidden="true" className="ml-1 text-red-300">*</span> : null}
            </label>
            {description ? (
                <p id={descriptionId} className={cn("text-xs leading-5", formHelpTextClass)}>
                    {description}
                </p>
            ) : null}
            {control}
            <FieldError id={errorId} error={error} />
        </div>
    );
}

export function focusFirstInvalidField(root: ParentNode = document) {
    const invalid = root.querySelector<HTMLElement>(
        "[aria-invalid='true']:not([disabled]), [data-invalid='true']:not([disabled])"
    );
    invalid?.focus();
    const reduceMotion = typeof window !== "undefined"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    invalid?.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    return invalid ?? null;
}
