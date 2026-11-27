import "server-only";

import Link from "next/link";
import { redirect } from "next/navigation";
import { logoutAction } from "@/app/auth/actions";
import { getPendingPageData } from "@/lib/auth";

export const dynamic = "force-dynamic";

function formatDate(iso: string | null): string {
  if (!iso) return "Just now";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function PendingOrganizationPage() {
  const data = await getPendingPageData();
  if (!data) {
    redirect("/login");
  }

  const { user, org, orgCreatedAt, purchaseSummary, isSuperAdmin } = data;

  if (org && org.status === "active" && !isSuperAdmin) {
    redirect("/dashboard");
  }

  const status = org?.status ?? "pending";

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-12 text-slate-900">
      <div className="w-full max-w-xl space-y-6">
        <section
          role="status"
          className={`rounded-2xl border bg-white p-6 shadow-sm sm:p-8 ${
            status === "rejected"
              ? "border-red-200"
              : status === "suspended"
                ? "border-red-200"
                : "border-amber-200"
          }`}
        >
          {/* Status badge + icon */}
          <div className="flex items-center justify-between gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ring-1 ${
                status === "rejected"
                  ? "bg-red-50 text-red-700 ring-red-200"
                  : status === "suspended"
                    ? "bg-red-50 text-red-700 ring-red-200"
                    : "bg-amber-50 text-amber-800 ring-amber-200"
              }`}
            >
              {status === "rejected"
                ? "✕ Request Declined"
                : status === "suspended"
                  ? "🚫 Account Suspended"
                  : "⏳ Pending Approval"}
            </span>
            <span className="font-mono text-xs text-slate-400">
              {user.email}
            </span>
          </div>

          {status === "pending" && (
            <>
              <h1 className="mt-4 text-2xl font-bold text-slate-900">
                Your request is pending approval
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                Your request is pending approval. We&apos;ll contact you on
                WhatsApp once it&apos;s approved.
              </p>
            </>
          )}

          {status === "rejected" && (
            <>
              <h1 className="mt-4 text-2xl font-bold text-slate-900">
                Your organization request was not approved
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                Unfortunately, your request for{" "}
                <strong>{org?.name ?? "your organization"}</strong> could not be
                approved at this time.
              </p>
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50/70 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-red-800">
                  Reason provided by administrator
                </p>
                <p className="mt-1 text-sm font-medium text-red-950">
                  {org?.rejectionReason ||
                    "No additional reason was recorded. Please reach out to support if you believe this is an error."}
                </p>
              </div>
            </>
          )}

          {status === "suspended" && (
            <>
              <h1 className="mt-4 text-2xl font-bold text-slate-900">
                Organization Account Suspended
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                Access for{" "}
                <strong>{org?.name ?? "your organization"}</strong> has been
                suspended by a platform administrator. Dashboard operations and
                public certificate pages are currently unavailable.
              </p>
            </>
          )}

          {/* Organization & Plan Summary */}
          {org && (
            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Organization &amp; Plan Summary
                  </p>
                  <p className="mt-0.5 text-base font-bold text-slate-900">
                    {org.name}
                  </p>
                </div>
                <span className="text-xs text-slate-500">
                  Submitted {formatDate(purchaseSummary?.createdAt ?? orgCreatedAt)}
                </span>
              </div>

              <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                {org.contactName && (
                  <div>
                    <dt className="font-medium text-slate-500">Contact Person</dt>
                    <dd className="mt-0.5 font-semibold text-slate-900">
                      {org.contactName}
                    </dd>
                  </div>
                )}

                {org.whatsappNumber && (
                  <div>
                    <dt className="font-medium text-slate-500">WhatsApp Number</dt>
                    <dd className="mt-0.5 font-mono font-semibold text-slate-900">
                      {org.whatsappNumber}
                    </dd>
                  </div>
                )}

                {purchaseSummary ? (
                  <>
                    <div>
                      <dt className="font-medium text-slate-500">Selected Package</dt>
                      <dd className="mt-0.5 font-semibold text-slate-900">
                        {purchaseSummary.planName}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Capacity &amp; Validity</dt>
                      <dd className="mt-0.5 font-semibold text-slate-900">
                        {purchaseSummary.eventsTotal}{" "}
                        {purchaseSummary.eventsTotal === 1 ? "event" : "events"} ×{" "}
                        {purchaseSummary.certsPerEvent} certs ·{" "}
                        {purchaseSummary.months} months
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">List Price</dt>
                      <dd className="mt-0.5 font-mono font-semibold text-slate-900">
                        PKR {purchaseSummary.listPricePkr.toLocaleString()}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Package Total</dt>
                      <dd className="mt-0.5 font-mono font-bold text-indigo-700">
                        PKR {purchaseSummary.finalPricePkr.toLocaleString()}
                      </dd>
                    </div>
                  </>
                ) : (
                  <div className="sm:col-span-2">
                    <dt className="font-medium text-slate-500">Selected Package</dt>
                    <dd className="mt-0.5 text-slate-700">
                      Awaiting package assignment
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          {/* Actions */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <form action={logoutAction}>
              <button
                type="submit"
                className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-xs transition hover:bg-slate-100"
              >
                Log out
              </button>
            </form>

            {status === "pending" && (
              <a
                href="/pending"
                className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs transition hover:bg-indigo-700"
              >
                Check Approval Status ↻
              </a>
            )}

            {isSuperAdmin && (
              <div className="flex items-center gap-2">
                <Link
                  href="/superadmin/requests"
                  className="rounded-xl border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                >
                  Open /superadmin/requests →
                </Link>
                <Link
                  href="/dashboard"
                  className="rounded-xl border border-slate-200 bg-slate-100 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200"
                >
                  Dashboard (Exempt) →
                </Link>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
