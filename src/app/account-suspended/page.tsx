import "server-only";

import Link from "next/link";
import { redirect } from "next/navigation";
import { logoutAction } from "@/app/auth/actions";
import { getCurrentOrgResult, getCurrentUser } from "@/lib/auth";
import { isUserInSuperAdminsTable } from "@/lib/superadmin";

export const dynamic = "force-dynamic";

export default async function AccountSuspendedPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const [{ org }, isSuperAdmin] = await Promise.all([
    getCurrentOrgResult(),
    isUserInSuperAdminsTable(user.id),
  ]);

  if (org && org.status === "active") {
    redirect("/dashboard");
  }

  if (org && org.status !== "suspended" && !isSuperAdmin) {
    redirect("/pending");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-12 text-slate-900">
      <section
        role="alert"
        className="w-full max-w-md rounded-2xl border border-red-200 bg-white p-8 text-center shadow-sm"
      >
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-2xl text-red-600 ring-1 ring-red-200">
          🚫
        </div>
        <h1 className="text-xl font-bold text-slate-900">
          Organization Suspended
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          {org ? (
            <>
              Access for <strong>{org.name}</strong> has been suspended by a
              platform administrator. Dashboard access and public certificate
              pages for this organization are currently unavailable.
            </>
          ) : (
            "Your organization account has been suspended by a platform administrator."
          )}
        </p>
        <p className="mt-3 text-xs text-slate-500">
          Signed in as <span className="font-mono">{user.email}</span>
        </p>

        <div className="mt-6 flex flex-col gap-2.5">
          <form action={logoutAction}>
            <button
              type="submit"
              className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Sign Out
            </button>
          </form>

          {isSuperAdmin && (
            <Link
              href="/superadmin"
              className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
            >
              Open /superadmin Console →
            </Link>
          )}
        </div>
      </section>
    </main>
  );
}
