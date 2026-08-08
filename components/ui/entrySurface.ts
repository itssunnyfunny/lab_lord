export const entryRootClass =
    "relative flex min-h-[100dvh] items-center justify-center overflow-x-hidden overflow-y-auto bg-[color:var(--bg-app)] p-4 text-[color:var(--text-primary)] sm:p-6";

export const entryContentClass = "relative z-10 w-full";

export const entryPanelClass =
    "overflow-hidden rounded-[var(--ui-radius-panel)] border border-[color:var(--ui-panel-border)] bg-[color:var(--ui-panel-bg)] shadow-[var(--ui-form-dialog-shadow)] backdrop-blur-xl";

export const entryIconFrameClass =
    "inline-flex items-center justify-center rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)] text-[color:var(--ui-form-accent)]";

export const entryTitleClass = "text-2xl font-semibold tracking-tight text-[color:var(--text-primary)] sm:text-3xl";

export const entrySubtitleClass = "text-sm leading-6 text-[color:var(--text-secondary)]";

export const entryMutedTextClass = "text-[color:var(--text-secondary)]";

export const entrySubtleTextClass = "text-[color:var(--text-muted)]";

export const entryInlineInfoClass =
    "rounded-[var(--ui-radius-control)] border border-[color:var(--ui-form-surface-border)] bg-[color:var(--ui-form-surface-bg)]";

export const entryPrimaryLinkClass =
    "inline-flex h-10 items-center justify-center gap-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-primary-border)] bg-[color:var(--ui-button-primary-bg)] px-5 text-sm font-semibold text-[color:var(--ui-button-primary-text)] shadow-[var(--ui-button-primary-shadow)] transition-colors hover:border-[color:var(--ui-button-primary-hover-border)] hover:bg-[color:var(--ui-button-primary-hover-bg)]";

export const entrySecondaryLinkClass =
    "inline-flex h-10 items-center justify-center gap-2 rounded-[var(--ui-radius-control)] border border-[color:var(--ui-button-secondary-border)] bg-[color:var(--ui-button-secondary-bg)] px-5 text-sm font-semibold text-[color:var(--ui-button-secondary-text)] shadow-[var(--ui-button-secondary-shadow)] transition-colors hover:border-[color:var(--ui-button-secondary-hover-border)] hover:bg-[color:var(--ui-button-secondary-hover-bg)]";

const clerkThemeVariables = {
    colorPrimary: "#67e8f9",
    colorBackground: "#0f111a",
    colorInputBackground: "#171a24",
    colorInputText: "#f9fafb",
    colorText: "#f9fafb",
    colorTextSecondary: "#b6bdc9",
    colorDanger: "#fca5a5",
    colorNeutral: "#a8b0bd",
    borderRadius: "12px",
    fontFamily: "inherit",
};

export const entryClerkAppearance = {
    variables: clerkThemeVariables,
    elements: {
        rootBox: "w-full",
        cardBox: "w-full shadow-none",
        card:
            "w-full max-w-full gap-5 rounded-2xl border border-white/10 !bg-[#0f111a] px-5 py-6 shadow-[0_24px_70px_rgba(0,0,0,0.38)] sm:px-7 sm:py-7",
        header: "gap-2 text-left",
        headerTitle: "!text-xl font-semibold tracking-tight !text-white",
        headerSubtitle: "text-sm leading-6 !text-slate-300",
        socialButtons: "gap-3",
        socialButtonsBlockButton:
            "min-h-11 rounded-xl !border-white/15 !bg-white/[0.04] text-sm font-semibold !text-slate-100 shadow-none transition-colors hover:!border-white/25 hover:!bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-cyan-300/40",
        socialButtonsBlockButtonText: "font-semibold !text-slate-100",
        dividerRow: "gap-3",
        dividerLine: "!bg-white/10",
        dividerText: "text-xs font-medium uppercase tracking-[0.14em] !text-slate-400",
        form: "gap-4",
        formFieldRow: "gap-4",
        formField: "gap-2",
        formFieldLabel: "text-sm font-medium !text-slate-200",
        formFieldInput:
            "min-h-11 rounded-xl !border-white/15 !bg-[#171a24] px-3.5 text-base !text-white shadow-none outline-none transition-colors placeholder:!text-slate-500 focus:!border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/15 sm:text-sm",
        formFieldInputShowPasswordButton:
            "!text-slate-400 hover:!text-white focus-visible:ring-2 focus-visible:ring-cyan-300/40",
        formFieldAction:
            "font-medium !text-cyan-300 hover:!text-cyan-200",
        formFieldHintText: "text-sm leading-5 !text-slate-300",
        formFieldInfoText: "text-sm leading-5 !text-slate-300",
        formFieldWarningText: "text-sm leading-5 !text-amber-200",
        formFieldErrorText: "text-sm !text-red-300",
        formFieldSuccessText: "text-sm !text-emerald-300",
        formButtonPrimary:
            "min-h-11 rounded-xl !border-cyan-200/70 !bg-cyan-300 text-sm font-semibold !text-slate-950 shadow-none transition-colors hover:!bg-cyan-200 focus-visible:ring-2 focus-visible:ring-cyan-200/50",
        otpCodeFieldInput:
            "h-12 !border-white/15 !bg-[#171a24] !text-white focus:!border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/15",
        identityPreview:
            "rounded-xl !border-white/10 !bg-white/[0.04]",
        identityPreviewText: "!text-white",
        identityPreviewEditButton:
            "!text-cyan-300 hover:!text-cyan-200",
        alternativeMethodsBlockButton:
            "min-h-11 rounded-xl !border-white/15 !bg-white/[0.04] !text-slate-100 hover:!border-white/25 hover:!bg-white/[0.07]",
        alert:
            "rounded-xl !border-red-400/30 !bg-red-400/10",
        alertText: "text-sm !text-red-200",
        footer: "gap-4",
        footerAction: "gap-1.5",
        footerActionText: "text-sm !text-slate-400",
        footerActionLink:
            "text-sm font-semibold !text-cyan-300 hover:!text-cyan-200",
        footerPages: "!text-slate-400",
        footerPageLink: "!text-slate-400 hover:!text-slate-200",
        backLink:
            "font-medium !text-cyan-300 hover:!text-cyan-200",
        formResendCodeLink:
            "font-medium !text-cyan-300 hover:!text-cyan-200",
    },
};

export const accountMenuClerkAppearance = {
    variables: clerkThemeVariables,
    elements: {
        avatarBox:
            "h-9 w-9 rounded-full ring-1 ring-white/15 transition-shadow hover:ring-cyan-300/45 focus-visible:ring-2 focus-visible:ring-cyan-300/60",
        userButtonPopoverCard:
            "rounded-xl !border !border-white/10 !bg-[#0f111a] shadow-[0_24px_70px_rgba(0,0,0,0.48)]",
        userButtonPopoverMain: "!bg-[#0f111a]",
        userButtonPopoverActionButton:
            "rounded-lg !text-slate-200 transition-colors hover:!bg-white/[0.06] hover:!text-white",
        userButtonPopoverActionButtonIcon: "!text-slate-400",
        userButtonPopoverActionButtonText: "font-medium",
        userPreviewMainIdentifier: "!text-white",
        userPreviewSecondaryIdentifier: "!text-slate-400",
        userButtonPopoverFooter: "!border-white/10 !bg-[#0b0d14]",
        userButtonPopoverFooterPages: "!text-slate-500",
        userButtonPopoverFooterPagesLink: "!text-slate-400 hover:!text-slate-200",
    },
};

export const accountProfileClerkAppearance = {
    variables: clerkThemeVariables,
    elements: {
        modalBackdrop: "!bg-black/75 backdrop-blur-sm",
        modalContent:
            "overflow-hidden rounded-2xl !border !border-white/10 !bg-[#0f111a] shadow-[0_28px_90px_rgba(0,0,0,0.58)]",
        rootBox: "!text-slate-100",
        cardBox: "!bg-[#0f111a] shadow-none",
        card:
            "rounded-2xl !border !border-white/10 !bg-[#0f111a] shadow-[0_28px_90px_rgba(0,0,0,0.52)]",
        navbar: "!border-white/10 !bg-[#0b0d14]",
        navbarButton:
            "rounded-lg !text-slate-400 transition-colors hover:!bg-white/[0.05] hover:!text-white",
        navbarButtonIcon: "!text-slate-500",
        navbarMobileMenuButton:
            "rounded-lg !border-white/10 !bg-white/[0.04] !text-slate-200 hover:!bg-white/[0.08]",
        pageScrollBox: "!bg-[#0f111a]",
        page: "gap-6 !bg-[#0f111a]",
        headerTitle: "!text-white",
        headerSubtitle: "!text-slate-400",
        profileSection: "rounded-xl !border-white/10 !bg-white/[0.025]",
        profileSectionTitle: "!border-white/10",
        profileSectionTitleText: "!text-slate-100",
        profileSectionContent: "!border-white/10",
        profileSectionPrimaryButton:
            "rounded-lg !border-white/15 !bg-white/[0.04] !text-cyan-300 hover:!border-white/25 hover:!bg-white/[0.08] hover:!text-cyan-200",
        profileSectionItem: "!border-white/10",
        profileSectionItemText: "!text-slate-200",
        profileSectionItemAction: "!text-cyan-300 hover:!text-cyan-200",
        formFieldLabel: "!text-slate-200",
        formFieldInput:
            "rounded-xl !border-white/15 !bg-[#171a24] !text-white placeholder:!text-slate-500 focus:!border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/15",
        formButtonPrimary:
            "rounded-xl !border-cyan-200/70 !bg-cyan-300 font-semibold !text-slate-950 hover:!bg-cyan-200",
        formButtonReset:
            "rounded-xl !text-slate-300 hover:!bg-white/[0.05] hover:!text-white",
        badge: "!border-white/10 !bg-white/[0.05] !text-slate-300",
        alert: "rounded-xl !border-red-400/30 !bg-red-400/10",
        alertText: "!text-red-200",
        modalCloseButton:
            "rounded-lg !text-slate-400 hover:!bg-white/[0.06] hover:!text-white",
    },
};

export const clerkAppAppearance = {
    variables: clerkThemeVariables,
    elements: {
        ...entryClerkAppearance.elements,
        ...accountMenuClerkAppearance.elements,
        ...accountProfileClerkAppearance.elements,
    },
};
