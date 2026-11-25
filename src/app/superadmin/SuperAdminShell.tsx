"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/auth/actions";
import { ToastProvider } from "@/components/ui";
import type { CurrentUser } from "@/lib/auth";

const NAV_LINKS = [
  { href: "/superadmin", label: "Platform Overview", exact: true },
  { href: "/superadmin/organizations", label: "Organizations", exact: false },
  { href: "/superadmin/payments", label: "Payment Requests", exact: false },
];

export default function SuperAdminShell({
  user,
  children,
}: {
  user: CurrentUser;
  children: ReactNode;
}) {
  const pathname = usePathname();

  return (
    <ToastProvider>
      <div className="min-h-dvh bg-slate-50 text-slate-900">
        {/* Top platform console bar */}
        <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950 text-white">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3.5 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-center gap-6">
              <Link href="/superadmin" className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
                  🛡️
                </span>
                <div>
                  <span className="block text-sm font-bold tracking-tight">
                    cert-saas /superadmin
                  </span>
                  <span className="block text-[10px] font-medium text-slate-400">
                    Platform Governance · No Impersonation
                  </span>
                </div>
              </Link>

              <nav className="flex items-center gap-1" aria-label="Superadmin">
                {NAV_LINKS.map((item) => {
                  const active = item.exact
                    ? pathname === item.href
                    : pathname === item.href ||
                      pathname.startsWith(`${item.href}/`);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                        active
                          ? "bg-indigo-600 text-white"
                          : "text-slate-300 hover:bg-slate-800 hover:text-white"
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            </div>

            <div className="flex items-center gap-3 text-xs">
              <span className="hidden rounded-full bg-slate-900 px-2.5 py-1 font-mono text-[11px] text-slate-300 ring-1 ring-slate-800 sm:inline-block">
                {user.email}
              </span>
              <Link
                href="/dashboard"
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                Org Dashboard ↗
              </Link>
              <form action={logoutAction}>
                <button
                  type="submit"
                  className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-semibold text-slate-300 transition hover:bg-red-950 hover:text-red-200"
                >
                  Sign Out
                </button>
              </form>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </ToastProvider>
  );
}
