"use client";

import type { DialogProps } from "./Dialog";
import { Dialog } from "./Dialog";

export type DrawerProps = Omit<DialogProps, "placement">;

/** Right-edge modal drawer using the same focus/inert/scroll contract as Dialog. */
export function Drawer(props: DrawerProps) {
    return <Dialog {...props} placement="right" />;
}
