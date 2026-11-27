import "server-only";

import type { ReactNode } from "react";
import Link from "next/link";
import { checkSuperAdminPageAccess } from "@/lib/superadmin";
import { getPendingSignupRequestsCount } from "@/lib/superadmin-data";
import SuperAdminShell from "./SuperAdminShell";

export const dynamic = "force-dynamic";

export default async function SuperAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const access = await checkSuperAdminPageAccess();

  if (!access.authorized) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-slate-950 px-4 py-12 text-slate-100">
        <section
          role="alert"
          className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl"
        >
          <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-red-500/15 text-xl text-red-400 ring-1 ring-red-500/30">
            🛡️
          </div>
          <h1 className="text-xl font-bold text-white">
            403 — Super-Admin Access Required
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-300">
            <code className="font-mono text-indigo-300">/superadmin</code> is
            restricted exclusively to accounts listed in the{" "}
            <code className="font-mono text-indigo-300">public.super_admins</code>{" "}
            database table (never via an environment password).
          </p>
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-3.5 text-xs text-slate-400">
            <p>
              Signed in as:{" "}
              <strong className="text-slate-200">{access.user.email}</strong>
            </p>
            <p className="mt-1 font-mono text-[11px] text-slate-500">
              user_id: {access.user.id}
            </p>
          </div>
          <div className="mt-6 flex items-center gap-3">
            <Link
              href="/dashboard"
              className="rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              ← Return to Organization Dashboard
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const pendingRequestsCount = await getPendingSignupRequestsCount();

  return (
    <SuperAdminShell
      user={access.user}
      pendingRequestsCount={pendingRequestsCount}
    >
      {children}
    </SuperAdminShell>
  );
}
