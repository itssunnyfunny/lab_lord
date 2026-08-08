"use client";

import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let bodyScrollLockCount = 0;
let bodyOverflowBeforeLock = "";

function lockBodyScroll() {
  if (bodyScrollLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }

  bodyScrollLockCount += 1;

  return () => {
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (bodyScrollLockCount === 0) {
      document.body.style.overflow = bodyOverflowBeforeLock;
    }
  };
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute("aria-hidden") !== "true" && !element.hasAttribute("hidden")
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
  role?: "dialog" | "alertdialog";
  closeLabel?: string;
  closeDisabled?: boolean;
  dismissOnBackdrop?: boolean;
  dismissOnEscape?: boolean;
  showCloseButton?: boolean;
  placement?: "center" | "right" | "bottom";
  className?: string;
}

/**
 * Accessible modal foundation for application dialogs.
 *
 * Add `data-dialog-initial-focus` to the safest action when it should receive
 * focus before the close button or the first other interactive element.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  icon,
  role = "dialog",
  closeLabel = "Close dialog",
  closeDisabled = false,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  showCloseButton = true,
  placement = "center",
  className,
}: DialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const overlay = overlayRef.current;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const restoreBodyScroll = lockBodyScroll();
    const inertedSiblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay)
      .map((element) => ({ element, wasInert: element.inert }));

    for (const { element } of inertedSiblings) {
      element.inert = true;
    }

    queueMicrotask(() => {
      if (cancelled) return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const requestedInitialFocus = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]");
      requestedInitialFocus?.focus();
      if (!requestedInitialFocus) {
        getFocusableElements(dialog)[0]?.focus();
      }
      if (!dialog.contains(document.activeElement)) {
        dialog.focus();
      }
    });

    return () => {
      cancelled = true;
      restoreBodyScroll();
      for (const { element, wasInert } of inertedSiblings) {
        element.inert = wasInert;
      }

      const previouslyFocused = previouslyFocusedRef.current;
      queueMicrotask(() => {
        if (previouslyFocused?.isConnected) {
          previouslyFocused.focus();
        }
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === "Escape" && dismissOnEscape && !closeDisabled) {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusableElements = getFocusableElements(dialog);
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && (activeElement === first || activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeDisabled, dismissOnEscape, onClose, open]);

  if (!open || typeof document === "undefined") return null;

  const requestBackdropClose = () => {
    if (dismissOnBackdrop && !closeDisabled) {
      onClose();
    }
  };

  return createPortal(
    <div
      ref={overlayRef}
      className={cn(
        "fixed inset-0 z-[100] flex",
        placement === "right"
          ? "items-stretch justify-end"
          : placement === "bottom"
            ? "items-end justify-center p-0 sm:p-4"
            : "items-end justify-center p-3 sm:items-center sm:p-4"
      )}
      data-dialog-overlay="true"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-[color:var(--ui-backdrop-bg)] backdrop-blur-sm"
        onClick={requestBackdropClose}
        disabled={closeDisabled}
        tabIndex={-1}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        className={cn(
          "relative max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto rounded-[var(--ui-dialog-radius)] border border-[color:var(--ui-dialog-border)] bg-[color:var(--ui-dialog-bg)] p-4 shadow-[var(--ui-dialog-shadow)] sm:p-6",
          placement === "right" && "h-full max-h-none max-w-md rounded-none border-y-0 border-r-0",
          placement === "bottom" && "max-h-[90dvh] rounded-b-none sm:rounded-[var(--ui-dialog-radius)]",
          "ui-dialog-enter",
          className
        )}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={closeDisabled || undefined}
        tabIndex={-1}
      >
        <div className="flex items-start gap-3 pr-10">
          {icon ? <div className="shrink-0" aria-hidden="true">{icon}</div> : null}
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold leading-tight text-[color:var(--ui-dialog-title)]">
              {title}
            </h2>
            {description ? (
              <div id={descriptionId} className="mt-1.5 text-sm leading-6 text-[color:var(--ui-dialog-description)]">
                {description}
              </div>
            ) : null}
          </div>
        </div>

        {showCloseButton ? (
          <button
            type="button"
            className="absolute right-2 top-2 inline-flex h-11 w-11 items-center justify-center rounded-[var(--ui-radius-control)] text-[color:var(--ui-text-muted)] transition-colors hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--ui-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ui-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label={closeLabel}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        ) : null}

        {children ? <div className="mt-5">{children}</div> : null}
        {footer ? (
          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
