import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { LAST_ACTIVE_BRANCH_COOKIE } from "@/lib/workspaceRouting";
import { UserService } from "@/services/user.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Open workspace",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function SmartAppRouterPage() {
  const user = await getSessionUser();
  if (!user) {
    redirect("/sign-in?redirect_url=%2Fapp");
  }

  const cookieStore = await cookies();
  const directory = await UserService.getWorkspaceDirectory(
    user.id,
    cookieStore.get(LAST_ACTIVE_BRANCH_COOKIE)?.value
  );

  redirect(directory.defaultHref);
}
