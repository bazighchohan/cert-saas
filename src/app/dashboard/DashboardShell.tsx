"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/auth/actions";
import { ToastProvider } from "@/components/ui";
import type { CurrentOrg, CurrentUser } from "@/lib/auth";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  exact?: boolean;
  badge?: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Events", icon: "📅", exact: true },
  { href: "/dashboard/settings", label: "Settings", icon: "⚙️" },
  { href: "/dashboard/billing", label: "Billing", icon: "💳" },
  { href: "/dashboard/help", label: "Help", icon: "❓" },
];

export default function DashboardShell({
  org,
  user,
  children,
}: {
  org: CurrentOrg;
  user: CurrentUser;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  function isActive(item: NavItem): boolean {
    if (item.exact) {
      return pathname === item.href || pathname.startsWith("/dashboard/events");
    }
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

  const userInitial = (user.email[0] || "U").toUpperCase();

  return (
    <ToastProvider>
      <div className="flex min-h-dvh bg-slate-50 text-slate-900">
        {/* Mobile sidebar backdrop */}
        {mobileMenuOpen && (
          <div
            className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-xs lg:hidden"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Sidebar (desktop fixed + mobile slide-over) */}
        <aside
          className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-200 lg:static lg:translate-x-0 ${
            mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          {/* Brand header */}
          <div className="flex h-16 items-center justify-between border-b border-slate-100 px-5">
            <Link
              href="/dashboard"
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center gap-2.5"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-base font-bold text-white shadow-xs">
                📜
              </span>
              <div>
                <span className="block text-sm font-bold tracking-tight text-slate-900">
                  cert-saas
                </span>
                <span className="block text-[11px] font-medium text-slate-500">
                  E-Certificate Platform
                </span>
              </div>
            </Link>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Close navigation menu"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:hidden"
            >
              ✕
            </button>
          </div>

          {/* Organization pill */}
          <div className="border-b border-slate-100 px-4 py-3.5">
            <div className="rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200/80">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs font-bold text-slate-900">
                  {org.name}
                </p>
                <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200">
                  {org.packageLabel}
                </span>
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                /{org.slug}
              </p>
            </div>
          </div>

          {/* Navigation links */}
          <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Dashboard">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
                    active
                      ? "bg-indigo-50 text-indigo-700 font-semibold"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <span className="text-base" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </span>
                  {item.badge && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Footer user summary */}
          <div className="border-t border-slate-100 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-slate-900">
                  {user.email}
                </p>
                <p className="text-[11px] capitalize text-slate-500">
                  {org.role} · {org.status}
                </p>
              </div>
              <form action={logoutAction}>
                <button
                  type="submit"
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
                >
                  Out
                </button>
              </form>
            </div>
          </div>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200 bg-white/95 px-4 backdrop-blur-xs sm:px-6 lg:px-8">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                aria-label="Open navigation menu"
                className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50 lg:hidden"
              >
                ☰
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-bold text-slate-900 sm:text-base">
                    {org.name}
                  </span>
                  <span className="hidden rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200 sm:inline-block">
                    {org.packageLabel}
                  </span>
                </div>
              </div>
            </div>

            {/* User menu dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setUserMenuOpen((prev) => !prev)}
                aria-expanded={userMenuOpen}
                aria-haspopup="menu"
                className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-left text-xs transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                  {userInitial}
                </span>
                <span className="hidden max-w-[160px] truncate font-medium text-slate-700 sm:inline-block">
                  {user.email}
                </span>
                <span className="text-slate-400" aria-hidden="true">
                  ▾
                </span>
              </button>

              {userMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setUserMenuOpen(false)}
                    aria-hidden="true"
                  />
                  <div
                    role="menu"
                    className="absolute right-0 z-40 mt-2 w-60 overflow-hidden rounded-2xl border border-slate-200 bg-white py-1.5 shadow-lg"
                  >
                    <div className="border-b border-slate-100 px-4 py-2.5">
                      <p className="truncate text-xs font-bold text-slate-900">
                        {org.name}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {user.email}
                      </p>
                      <p className="mt-1 inline-block rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-600">
                        {org.role} · {org.packageLabel}
                      </p>
                    </div>
                    <Link
                      href="/dashboard/settings"
                      onClick={() => setUserMenuOpen(false)}
                      role="menuitem"
                      className="block px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Organization Settings
                    </Link>
                    <Link
                      href="/dashboard/billing"
                      onClick={() => setUserMenuOpen(false)}
                      role="menuitem"
                      className="block px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Plan & Billing
                    </Link>
                    <div className="mt-1 border-t border-slate-100 pt-1">
                      <form action={logoutAction}>
                        <button
                          type="submit"
                          role="menuitem"
                          className="block w-full px-4 py-2 text-left text-xs font-semibold text-red-600 hover:bg-red-50"
                        >
                          Sign Out
                        </button>
                      </form>
                    </div>
                  </div>
                </>
              )}
            </div>
          </header>

          {/* Global Read-Only / Pending / Expiring-Soon Package Banner */}
          {org.isReadOnly && (
            <div className="border-b border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-900 sm:px-6 lg:px-8">
              <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
                <span>
                  <strong>Read-Only Mode:</strong> Your package has expired.
                  Viewing &amp; exports work and released public certificate
                  downloads remain live until their retention date, but creating
                  events or adding attendees is disabled.
                </span>
                <Link
                  href="/dashboard/billing"
                  className="font-bold text-red-950 underline hover:no-underline"
                >
                  Buy a Package in Billing →
                </Link>
              </div>
            </div>
          )}
          {!org.isReadOnly && !org.hasActivePurchase && org.hasPendingPurchase && (
            <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-950 sm:px-6 lg:px-8">
              <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
                <span>
                  <strong>Waiting for Approval:</strong> Your package purchase is
                  pending verification. You can create and release events as soon
                  as it is approved.
                </span>
                <Link
                  href="/dashboard/billing"
                  className="font-bold text-amber-950 underline hover:no-underline"
                >
                  View Purchase Status →
                </Link>
              </div>
            </div>
          )}
          {!org.isReadOnly && !org.hasActivePurchase && !org.hasPendingPurchase && (
            <div className="border-b border-indigo-200 bg-indigo-50 px-4 py-2.5 text-xs text-indigo-950 sm:px-6 lg:px-8">
              <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
                <span>
                  <strong>No Active Package:</strong> Buy a package in Billing
                  before creating or releasing events.
                </span>
                <Link
                  href="/dashboard/billing"
                  className="font-bold text-indigo-800 underline hover:no-underline"
                >
                  Buy a Package →
                </Link>
              </div>
            </div>
          )}
          {!org.isReadOnly && org.planExpiringSoon && (
            <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-950 sm:px-6 lg:px-8">
              <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
                <span>
                  <strong>Package Expiring Soon:</strong> An active package
                  expires within 14 days. Buy another package ahead of time to
                  keep creating events without interruption.
                </span>
                <Link
                  href="/dashboard/billing"
                  className="font-bold text-amber-950 underline hover:no-underline"
                >
                  Open Billing →
                </Link>
              </div>
            </div>
          )}

          {/* Page content */}
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
