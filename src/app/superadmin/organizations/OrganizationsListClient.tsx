"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import type { PlanDetails } from "@/lib/dashboard-data";
import { isPlanExpired } from "@/lib/plan-enforcement-helpers";
import {
  filterSuperAdminOrganizations,
  type SuperAdminOrgRow,
} from "@/lib/superadmin-helpers";
import { setOrganizationSuspendedAction } from "../actions";

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function OrganizationsListClient({
  organizations,
  plans,
}: {
  organizations: SuperAdminOrgRow[];
  plans: PlanDetails[];
}) {
  const router = useRouter();
  const { showToast } = useToast();

  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "active" | "suspended"
  >("all");

  const [confirmOrg, setConfirmOrg] = useState<SuperAdminOrgRow | null>(null);
  const [acting, setActing] = useState(false);

  const filtered = useMemo(
    () =>
      filterSuperAdminOrganizations({
        organizations,
        search,
        planFilter,
        statusFilter,
      }),
    [organizations, search, planFilter, statusFilter],
  );

  async function handleConfirmToggleSuspend() {
    if (!confirmOrg) return;
    const nextSuspended = confirmOrg.status === "active";
    setActing(true);

    try {
      const res = await setOrganizationSuspendedAction({
        orgId: confirmOrg.id,
        suspended: nextSuspended,
        reason: nextSuspended
          ? "Suspended from /superadmin/organizations"
          : "Unsuspended from /superadmin/organizations",
      });

      if (res.error) {
        showToast(res.error, "error");
        return;
      }

      showToast(
        nextSuspended
          ? `Suspended "${confirmOrg.name}" — admin sessions and public pages blocked.`
          : `Unsuspended "${confirmOrg.name}" — access restored.`,
        "success",
      );
      setConfirmOrg(null);
      router.refresh();
    } catch {
      showToast("Failed to update organization status.", "error");
    } finally {
      setActing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
          Organizations ({organizations.length})
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Search tenants, inspect plan &amp; certificate usage, check last admin
          login, or suspend/unsuspend accounts. Impersonation is disabled by
          platform policy.
        </p>
      </div>

      {/* Filters toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search organization name, slug, or owner email..."
          className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none sm:w-80"
        />

        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={planFilter}
            onChange={(e) => setPlanFilter(e.target.value)}
            aria-label="Filter by plan"
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 focus:border-indigo-500 focus:outline-none"
          >
            <option value="all">All Plans</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as "all" | "active" | "suspended")
            }
            aria-label="Filter by status"
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 focus:border-indigo-500 focus:outline-none"
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-xs sm:text-sm">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3.5">Organization</th>
                <th className="px-5 py-3.5">Plan</th>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5 text-right">Events</th>
                <th className="px-5 py-3.5 text-right">Certificates Issued</th>
                <th className="px-5 py-3.5">Last Login</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-6 py-10 text-center text-xs text-slate-500"
                  >
                    No organizations match your search or filter.
                  </td>
                </tr>
              ) : (
                filtered.map((org) => {
                  const expired = isPlanExpired(org.planExpiresAt);
                  return (
                    <tr
                      key={org.id}
                      className={
                        org.status === "suspended"
                          ? "bg-red-50/30 hover:bg-red-50/50"
                          : "hover:bg-slate-50/70"
                      }
                    >
                      <td className="px-5 py-3.5">
                        <Link
                          href={`/superadmin/organizations/${org.id}`}
                          className="font-bold text-slate-900 hover:text-indigo-600"
                        >
                          {org.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span className="font-mono">/{org.slug}</span>
                          {org.ownerEmail && <span>· {org.ownerEmail}</span>}
                        </div>
                      </td>

                      <td className="px-5 py-3.5">
                        <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold uppercase text-indigo-700 ring-1 ring-indigo-200">
                          {org.planName}
                        </span>
                        {org.planExpiresAt && (
                          <p
                            className={`mt-1 text-[11px] ${
                              expired
                                ? "font-semibold text-red-600"
                                : "text-slate-500"
                            }`}
                          >
                            {expired ? "Expired " : "Until "}
                            {new Date(org.planExpiresAt).toLocaleDateString()}
                          </p>
                        )}
                      </td>

                      <td className="px-5 py-3.5">
                        {org.status === "active" ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-800 ring-1 ring-red-200">
                            Suspended
                          </span>
                        )}
                      </td>

                      <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900">
                        {org.eventsCount.toLocaleString()}
                      </td>

                      <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900">
                        {org.certificatesIssuedCount.toLocaleString()}
                      </td>

                      <td className="px-5 py-3.5 text-xs text-slate-600 whitespace-nowrap">
                        {formatDate(org.lastLoginAt)}
                      </td>

                      <td className="px-5 py-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <Link
                            href={`/superadmin/organizations/${org.id}`}
                            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                          >
                            Detail →
                          </Link>
                          <Button
                            variant={
                              org.status === "active" ? "danger" : "secondary"
                            }
                            size="sm"
                            onClick={() => setConfirmOrg(org)}
                          >
                            {org.status === "active" ? "Suspend" : "Unsuspend"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(confirmOrg)}
        onClose={() => !acting && setConfirmOrg(null)}
        onConfirm={() => void handleConfirmToggleSuspend()}
        loading={acting}
        variant={confirmOrg?.status === "active" ? "danger" : "primary"}
        title={
          confirmOrg?.status === "active"
            ? `Suspend "${confirmOrg?.name}"?`
            : `Unsuspend "${confirmOrg?.name}"?`
        }
        description={
          confirmOrg?.status === "active"
            ? "All organization admins will be signed out and blocked from logging in at once, and all public /e/[slug] event pages for this organization will immediately show unavailable."
            : "Admins will be able to sign in again and released public event pages will be restored."
        }
        confirmLabel={
          confirmOrg?.status === "active"
            ? "Suspend Organization"
            : "Unsuspend Organization"
        }
      />
    </div>
  );
}
