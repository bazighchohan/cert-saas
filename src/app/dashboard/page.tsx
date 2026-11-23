import "server-only";

import { redirect } from "next/navigation";
import { logoutAction } from "@/app/auth/actions";
import { getCurrentOrg, getCurrentUser } from "@/lib/auth";
import { getReleased } from "@/lib/supabase";
import ReleaseToggle from "@/app/admin/ReleaseToggle";
import AdminContentWrapper from "@/app/admin/AdminContentWrapper";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const org = await getCurrentOrg();
  if (!org) {
    redirect("/login?error=Could+not+load+your+organization");
  }

  let released = false;
  try {
    released = await getReleased();
  } catch {
    // Legacy single-event settings table may not exist on new multi-tenant DB.
    released = false;
  }

  return (
    <main className="min-h-dvh bg-slate-50 text-slate-900 pb-16">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-base font-bold text-white shadow-sm">
              📜
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold text-slate-900 sm:text-lg">{org.name}</h1>
                <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200">
                  {org.planId} plan
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                  {org.role}
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Slug: <code className="font-mono text-slate-700">{org.slug}</code> · Signed in as{" "}
                <span className="font-medium text-slate-700">{user.email}</span>
              </p>
            </div>
          </div>

          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              Sign Out
            </button>
          </form>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
        <ReleaseToggle initialReleased={released} />
        <AdminContentWrapper />
      </div>
    </main>
  );
}
