"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/auth/actions";
import { ToastProvider } from "@/components/ui";
import type { CurrentUser } from "@/lib/auth";

export default function SuperAdminShell({
  user,
  pendingRequestsCount = 0,
  children,
}: {
  user: CurrentUser;
  pendingRequestsCount?: number;
  children: ReactNode;
}) {
  const pathname = usePathname();

  const navLinks = [
    { href: "/superadmin", label: "Platform Overview", exact: true },
    {
      href: "/superadmin/requests",
      label: "Signup Requests",
      exact: false,
      badge: pendingRequestsCount,
    },
    { href: "/superadmin/organizations", label: "Organizations", exact: false },
    { href: "/superadmin/payments", label: "Payment Requests", exact: false },
    {
      href: "/superadmin/payment-settings",
      label: "Payment Settings",
      exact: false,
    },
  ];

  return (
    <ToastProvider>
      <div className="min-h-dvh bg-slate-50 text-slate-900">
        {/* Top platform console bar */}
        <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950 text-white">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3.5 sm:px-6 lg:px-8">
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

          {/* Mobile navigation strip */}
          <nav
            className="flex items-center gap-1 overflow-x-auto border-t border-slate-800/80 px-4 py-2 lg:hidden"
            aria-label="Superadmin Mobile"
          >
            {navLinks.map((item) => {
              const active = item.exact
                ? pathname === item.href
                : pathname === item.href ||
                  pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    active
                      ? "bg-indigo-600 text-white"
                      : "text-slate-300 hover:bg-slate-800 hover:text-white"
                  }`}
                >
                  <span>{item.label}</span>
                  {typeof item.badge === "number" && (
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                        item.badge > 0
                          ? "bg-amber-400 text-slate-950"
                          : "bg-slate-800 text-slate-300"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </header>

        {/* Desktop sidebar + main content */}
        <div className="mx-auto flex max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:px-8">
          <aside className="hidden w-60 shrink-0 lg:block">
            <nav
              className="sticky top-24 space-y-1 rounded-2xl border border-slate-200 bg-white p-3 shadow-xs"
              aria-label="Superadmin Sidebar"
            >
              {navLinks.map((item) => {
                const active = item.exact
                  ? pathname === item.href
                  : pathname === item.href ||
                    pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-xs font-semibold transition ${
                      active
                        ? "bg-indigo-600 text-white shadow-2xs"
                        : "text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    <span>{item.label}</span>
                    {typeof item.badge === "number" && (
                      <span
                        aria-label={`${item.badge} pending signup requests`}
                        className={`inline-flex min-w-5 items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ${
                          item.badge > 0
                            ? active
                              ? "bg-amber-300 text-slate-950"
                              : "bg-amber-100 text-amber-900 ring-1 ring-amber-300"
                            : active
                              ? "bg-indigo-500 text-indigo-100"
                              : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>
          </aside>

          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
