"use client";

import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PlatformOverviewData } from "@/lib/superadmin-data";

function formatDateTime(iso: string): string {
  if (!iso) return "—";
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

export default function PlatformOverviewClient({
  data,
}: {
  data: PlatformOverviewData;
}) {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
            Platform Overview
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Global metrics across all organizations, events, certificates,
            downloads, and manual billing revenue.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            href="/superadmin/organizations"
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 shadow-xs transition hover:bg-slate-50"
          >
            Manage Organizations ({data.totalOrgs}) →
          </Link>
          <Link
            href="/superadmin/payments"
            className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-indigo-700"
          >
            Review Payment Requests ({data.pendingPaymentsCount} pending)
          </Link>
        </div>
      </div>

      {/* 1. Platform KPI Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Organizations
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {data.totalOrgs.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {data.activeOrgs} active · {data.suspendedOrgs} suspended ·{" "}
            {data.paidOrgs} paid
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Total Events
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {data.totalEvents.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {data.releasedEvents.toLocaleString()} released publicly
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Certificates Issued
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {data.totalCertificatesIssued.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Assigned attendee certificates
          </p>
        </div>

        <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5 shadow-xs">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
            Total Downloads
          </p>
          <p className="mt-2 text-2xl font-bold text-indigo-950">
            {data.totalDownloads.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-indigo-800">
            Recorded in <code className="font-mono">download_log</code>
          </p>
        </div>

        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5 shadow-xs col-span-2 lg:col-span-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
            Approved Revenue
          </p>
          <p className="mt-2 text-2xl font-bold text-emerald-950">
            PKR {data.totalApprovedRevenuePkr.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-emerald-800">
            {data.totalApprovedRequests} approved · {data.pendingPaymentsCount}{" "}
            pending
          </p>
        </div>
      </div>

      {/* 2. Revenue per Month Chart + Breakdown Table */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Revenue per Month (PKR)
            </h2>
            <p className="text-xs text-slate-500">
              Monthly approved <code className="font-mono">payment_requests</code>{" "}
              across Bank Transfer, JazzCash, and Easypaisa
            </p>
          </div>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
            Total: PKR {data.totalApprovedRevenuePkr.toLocaleString()}
          </span>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="h-64 w-full lg:col-span-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.monthlyRevenue}
                margin={{ top: 8, right: 12, left: 4, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: "#64748B" }}
                  tickLine={false}
                  axisLine={{ stroke: "#CBD5E1" }}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "#64748B" }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: "12px",
                    border: "1px solid #E2E8F0",
                    fontSize: "12px",
                  }}
                />
                <Bar
                  dataKey="revenuePkr"
                  name="Revenue (PKR)"
                  fill="#059669"
                  radius={[6, 6, 0, 0]}
                  maxBarSize={42}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3.5 py-2.5">Month</th>
                  <th className="px-3.5 py-2.5 text-right">Approved</th>
                  <th className="px-3.5 py-2.5 text-right">Revenue (PKR)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                {[...data.monthlyRevenue].reverse().map((m) => (
                  <tr key={m.month}>
                    <td className="px-3.5 py-2 font-medium text-slate-900">
                      {m.label}
                    </td>
                    <td className="px-3.5 py-2 text-right">{m.approvedCount}</td>
                    <td className="px-3.5 py-2 text-right font-mono font-semibold text-slate-900">
                      {m.revenuePkr.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* 3. Recent Platform Audit Log */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
        <div className="border-b border-slate-100 px-6 py-4">
          <h2 className="text-base font-bold text-slate-900">
            Recent Platform Audit Log
          </h2>
          <p className="text-xs text-slate-500">
            Latest administrative &amp; superadmin actions recorded in{" "}
            <code className="font-mono">public.audit_log</code>
          </p>
        </div>

        {data.recentAuditLogs.length === 0 ? (
          <div className="px-6 py-8 text-center text-xs text-slate-500">
            No audit log entries recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3">Timestamp</th>
                  <th className="px-6 py-3">Organization</th>
                  <th className="px-6 py-3">Action</th>
                  <th className="px-6 py-3">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                {data.recentAuditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/60">
                    <td className="px-6 py-3 whitespace-nowrap text-slate-500">
                      {formatDateTime(log.createdAt)}
                    </td>
                    <td className="px-6 py-3 font-semibold text-slate-900">
                      <Link
                        href={`/superadmin/organizations/${log.orgId}`}
                        className="text-indigo-600 hover:underline"
                      >
                        {log.orgName}
                      </Link>
                    </td>
                    <td className="px-6 py-3 font-mono font-semibold text-slate-900">
                      {log.action}
                    </td>
                    <td className="max-w-md truncate px-6 py-3 font-mono text-[11px] text-slate-500">
                      {JSON.stringify(log.details)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
