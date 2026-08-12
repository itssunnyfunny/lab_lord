import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Workspace",
    robots: { index: false, follow: false },
};

export default function WorkspaceEntryLayout({ children }: { children: React.ReactNode }) {
    return children;
}
