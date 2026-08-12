import { cn } from "@/lib/utils";

const avatarPalettes = [
    "border-cyan-300/30 from-cyan-400/35 via-sky-500/20 to-blue-600/35 text-cyan-50",
    "border-violet-300/30 from-violet-400/35 via-fuchsia-500/20 to-indigo-600/35 text-violet-50",
    "border-emerald-300/30 from-emerald-400/35 via-teal-500/20 to-cyan-600/35 text-emerald-50",
    "border-amber-300/30 from-amber-400/35 via-orange-500/20 to-rose-600/30 text-amber-50",
    "border-rose-300/30 from-rose-400/35 via-pink-500/20 to-violet-600/30 text-rose-50",
] as const;

const avatarSizes = {
    sm: "h-8 w-8 text-[11px]",
    md: "h-10 w-10 text-sm",
    lg: "h-12 w-12 text-base",
    xl: "h-16 w-16 text-xl",
} as const;

function initials(name: string) {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    return `${words[0]?.[0] ?? "?"}${words.length > 1 ? words.at(-1)?.[0] ?? "" : ""}`.toUpperCase();
}

function paletteFor(name: string) {
    const hash = Array.from(name).reduce((total, character) => total + character.charCodeAt(0), 0);
    return avatarPalettes[hash % avatarPalettes.length];
}

export function Avatar({
    name,
    size = "md",
    className,
}: {
    name: string;
    size?: keyof typeof avatarSizes;
    className?: string;
}) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border bg-gradient-to-br font-bold tracking-wide shadow-[0_8px_24px_rgba(6,182,212,0.12)]",
                avatarSizes[size],
                paletteFor(name),
                className
            )}
        >
            <span className="absolute inset-[1px] rounded-full bg-[radial-gradient(circle_at_28%_20%,rgba(255,255,255,0.22),transparent_38%)]" />
            <span className="relative">{initials(name)}</span>
        </span>
    );
}
