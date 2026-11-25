import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser, type CurrentUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";

/**
 * Checks whether a user ID is present in `public.super_admins`.
 * NEVER checks any environment variable or password — `public.super_admins` is
 * the single source of truth.
 */
export const isUserInSuperAdminsTable = cache(
  async (userId: string | null | undefined): Promise<boolean> => {
    if (!userId) return false;
    try {
      const admin = getSupabaseAdmin();
      const { data, error } = await admin
        .from("super_admins")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (error || !data) return false;
      return data.user_id === userId;
    } catch {
      return false;
    }
  },
);

/**
 * Returns the authenticated platform super-admin user if signed in AND listed in
 * `public.super_admins`, or `null` otherwise.
 */
export const getCurrentSuperAdmin = cache(
  async (): Promise<CurrentUser | null> => {
    const user = await getCurrentUser();
    if (!user) return null;
    const allowed = await isUserInSuperAdminsTable(user.id);
    return allowed ? user : null;
  },
);

/**
 * Guard for `/superadmin/**` Server Components.
 * Redirects unauthenticated visitors to `/login?next=/superadmin`; returns
 * `{ user, authorized }` so signed-in non-super-admins see a clean 403 screen.
 */
export async function checkSuperAdminPageAccess(): Promise<
  | { authorized: true; user: CurrentUser }
  | { authorized: false; user: CurrentUser }
> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login?next=/superadmin");
  }
  const allowed = await isUserInSuperAdminsTable(user.id);
  if (!allowed) {
    return { authorized: false, user };
  }
  return { authorized: true, user };
}
