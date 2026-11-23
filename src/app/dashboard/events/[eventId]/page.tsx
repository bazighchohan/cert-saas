import "server-only";

import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgEventById } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;

  // Strictly scoped to getCurrentOrg(): returns null if the event belongs to another org.
  const event = await getOrgEventById(eventId);
  if (!event) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/dashboard"
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-500"
          >
            ← Back to Events
          </Link>
          <h1 className="mt-1 text-xl font-bold text-slate-900 sm:text-2xl">
            {event.title}
          </h1>
          {event.subtitle && (
            <p className="text-sm text-slate-600">{event.subtitle}</p>
          )}
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            event.released
              ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
              : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
          }`}
        >
          {event.released ? "Released" : "Draft"}
        </span>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium text-slate-500">Public slug</dt>
            <dd className="mt-1 font-mono text-slate-900">/e/{event.slug}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-slate-500">Identifier label</dt>
            <dd className="mt-1 font-medium text-slate-900">
              {event.identifierLabel}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-slate-500">Attendees</dt>
            <dd className="mt-1 font-medium text-slate-900">
              {event.attendeeCount}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
