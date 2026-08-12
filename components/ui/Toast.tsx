"use client";

import { cn } from "@/lib/utils";
import { AlertCircle, CheckCircle2, Info, Loader2, X } from "lucide-react";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";

export type ToastTone = "info" | "success" | "error" | "pending";

export type ToastInput = {
    title: string;
    description?: string;
    tone?: ToastTone;
    persistent?: boolean;
    action?: { label: string; onClick: () => void };
};

type ToastItem = ToastInput & { id: number };
type ToastApi = {
    show: (toast: ToastInput) => number;
    dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const toneClasses: Record<ToastTone, string> = {
    info: "border-cyan-300/30 bg-slate-950 text-slate-100",
    success: "border-emerald-300/30 bg-slate-950 text-emerald-100",
    error: "border-red-300/35 bg-slate-950 text-red-100",
    pending: "border-violet-300/30 bg-slate-950 text-violet-100",
};

const toneIcons = {
    info: Info,
    success: CheckCircle2,
    error: AlertCircle,
    pending: Loader2,
} as const;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [items, setItems] = useState<ToastItem[]>([]);
    const nextId = useRef(1);

    const dismiss = useCallback((id: number) => {
        setItems(current => current.filter(item => item.id !== id));
    }, []);

    const show = useCallback((toast: ToastInput) => {
        const id = nextId.current++;
        setItems(current => [...current.slice(-3), { ...toast, id }]);
        return id;
    }, []);

    const api = useMemo(() => ({ show, dismiss }), [dismiss, show]);

    return (
        <ToastContext.Provider value={api}>
            {children}
            <div
                className="pointer-events-none fixed inset-x-4 bottom-4 z-[160] flex flex-col items-end gap-2 sm:left-auto sm:w-[380px]"
                aria-label="Notifications"
            >
                {items.map(item => (
                    <ToastCard key={item.id} toast={item} onDismiss={() => dismiss(item.id)} />
                ))}
            </div>
        </ToastContext.Provider>
    );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
    const tone = toast.tone ?? "info";
    const Icon = toneIcons[tone];

    useEffect(() => {
        if (toast.persistent || tone === "error" || tone === "pending") return;
        const timeout = window.setTimeout(onDismiss, 5000);
        return () => window.clearTimeout(timeout);
    }, [onDismiss, toast.persistent, tone]);

    return (
        <div
            role={tone === "error" ? "alert" : "status"}
            aria-live={tone === "error" ? "assertive" : "polite"}
            className={cn(
                "pointer-events-auto w-full rounded-[var(--ui-radius-panel)] border p-4 shadow-2xl",
                "ui-dialog-enter",
                toneClasses[tone]
            )}
        >
            <div className="flex items-start gap-3">
                <Icon
                    className={cn("mt-0.5 h-5 w-5 shrink-0", tone === "pending" && "animate-spin")}
                    aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{toast.title}</p>
                    {toast.description ? (
                        <p className="mt-1 text-sm leading-5 text-slate-300">{toast.description}</p>
                    ) : null}
                    {toast.action ? (
                        <button
                            type="button"
                            className="mt-2 min-h-11 text-sm font-semibold text-cyan-200 underline underline-offset-4"
                            onClick={() => {
                                toast.action?.onClick();
                                onDismiss();
                            }}
                        >
                            {toast.action.label}
                        </button>
                    ) : null}
                </div>
                <button
                    type="button"
                    className="-m-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-300 hover:bg-white/10 hover:text-white"
                    onClick={onDismiss}
                    aria-label={`Dismiss ${toast.title}`}
                >
                    <X className="h-4 w-4" aria-hidden="true" />
                </button>
            </div>
        </div>
    );
}

export function useToast() {
    const value = useContext(ToastContext);
    if (!value) throw new Error("useToast must be used within ToastProvider");
    return value;
}
