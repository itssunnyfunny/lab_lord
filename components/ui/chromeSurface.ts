export const chromeAppRootClass =
    "flex h-[100dvh] max-w-full overflow-hidden bg-[color:var(--bg-app)] text-[color:var(--text-primary)] font-sans selection:bg-cyan-500/30 selection:text-cyan-50";

export const chromeSidebarClass =
    "relative z-30 flex h-full w-full flex-col border-r border-[color:var(--ui-panel-border)] bg-[color:var(--ui-panel-bg)] backdrop-blur-xl lg:w-64";

export const chromeOrgSidebarClass =
    "relative z-30 flex h-full w-full flex-col border-r border-[color:var(--ui-panel-border)] bg-[color:var(--ui-panel-bg)] backdrop-blur-xl lg:w-72";

export const chromeSidebarHeaderClass =
    "flex h-14 items-center gap-2 border-b border-[color:var(--ui-panel-header-border)] bg-[color:var(--ui-form-muted-surface-bg)] px-4";

export const chromeSidebarFooterClass =
    "border-t border-[color:var(--ui-panel-header-border)] bg-[color:var(--ui-form-muted-surface-bg)] px-3 py-3";

export const chromeSidebarSectionLabelClass =
    "px-2 text-[10px] font-bold uppercase tracking-widest text-[color:var(--text-muted)]";

export const chromeHeaderClass =
    "sticky top-0 z-40 flex min-h-16 items-center justify-between gap-2 border-b border-[color:var(--ui-panel-border)] bg-[color:var(--ui-panel-bg)] px-3 [padding-top:env(safe-area-inset-top)] backdrop-blur-md sm:px-4 lg:px-6";

export const chromeOverlayClass = "absolute inset-0 bg-[color:var(--ui-form-overlay-bg)] backdrop-blur-sm";

export const chromeMobilePanelClass =
    "relative h-full w-[min(18rem,calc(100vw-2rem))] overflow-hidden border-r border-[color:var(--ui-panel-border)] bg-[color:var(--ui-panel-bg)] shadow-2xl";

export const chromeIconButtonClass =
    "inline-flex h-11 w-11 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-quiet-border)] bg-[color:var(--ui-button-quiet-bg)] text-[color:var(--ui-button-quiet-text)] transition-colors hover:border-[color:var(--ui-button-quiet-hover-border)] hover:bg-[color:var(--ui-button-quiet-hover-bg)] hover:text-[color:var(--ui-button-quiet-hover-text)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)] lg:h-10 lg:w-10";

export const chromeCompactIconButtonClass =
    "inline-flex h-11 w-11 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-quiet-border)] bg-[color:var(--ui-button-quiet-bg)] text-[color:var(--ui-button-quiet-text)] transition-colors hover:border-[color:var(--ui-button-quiet-hover-border)] hover:bg-[color:var(--ui-button-quiet-hover-bg)] hover:text-[color:var(--ui-button-quiet-hover-text)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)] lg:h-9 lg:w-9";

export const chromeDividerClass = "bg-[color:var(--ui-panel-header-border)]";

export const chromeInputShellClass = "relative w-full min-w-0 max-w-sm";

export const chromeInputClass =
    "w-full rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-input-border)] bg-[color:var(--ui-form-input-bg)] py-2 pl-10 pr-4 text-sm text-[color:var(--ui-form-input-text)] outline-none transition-colors placeholder:text-[color:var(--ui-form-input-placeholder)] focus:border-[color:var(--ui-form-input-focus-border)] focus:ring-2 focus:ring-[color:var(--ui-form-input-focus-ring)] disabled:cursor-not-allowed disabled:opacity-[var(--ui-control-disabled-opacity)]";

export const chromeInputIconClass =
    "absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--ui-form-icon)] transition-colors group-focus-within:text-[color:var(--ui-form-accent)]";

export const chromePopoverClass =
    "fixed left-3 right-3 top-[4.25rem] z-50 overflow-hidden rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-panel-border)] bg-[color:var(--ui-panel-bg)] shadow-[var(--ui-form-dialog-shadow)] backdrop-blur-xl";

export const chromePopoverHeaderClass =
    "flex items-center justify-between border-b border-[color:var(--ui-panel-header-border)] px-4 py-3";

export const chromePopoverScrollClass =
    "max-h-[min(28rem,calc(100dvh-6rem))] overflow-y-auto py-2 scrollbar-thin scrollbar-thumb-cyan-400/35 scrollbar-track-slate-950/50";

export const chromeListItemClass =
    "flex w-full items-center gap-3 rounded-[var(--ui-radius-control)] px-3 py-2.5 text-left text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--ui-form-surface-hover-bg)] hover:text-[color:var(--text-primary)]";

export const chromeListItemActiveClass =
    "bg-[color:var(--ui-form-surface-hover-bg)] text-[color:var(--text-primary)]";

export const chromeListIconClass =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] text-[color:var(--text-secondary)]";

export const chromeEmptyStateClass =
    "px-5 py-8 text-center text-[color:var(--text-secondary)]";

export const chromeMutedTextClass = "text-[color:var(--text-secondary)]";
export const chromeSubtleTextClass = "text-[color:var(--text-muted)]";

export const chromeInlineCardClass =
    "rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)]";

export const chromeInlineCardHoverClass =
    "transition-colors hover:border-[color:var(--ui-form-input-border)] hover:bg-[color:var(--ui-form-surface-hover-bg)]";

export const chromePulseBlockClass = "animate-pulse rounded-[var(--ui-radius-control)] bg-[color:var(--ui-form-muted-surface-bg)]";
