import "server-only";

import { requireDashboardAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardHelpPage() {
  const { org } = await requireDashboardAuth();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
          Help & Quick Start
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          How to issue e-certificates for <strong className="text-slate-900">{org.name}</strong>.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
          <h2 className="text-sm font-bold text-slate-900">
            1. Create an Event
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            Go to <strong>Events</strong> and create an event with a unique slug, event date, and the identifier label your attendees will enter (such as Roll Number, Registration ID, or Email).
          </p>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
          <h2 className="text-sm font-bold text-slate-900">
            2. Upload Your Certificate Template
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            Upload a high-resolution PDF or PNG certificate template and drag the recipient name box into position using the visual placement editor.
          </p>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
          <h2 className="text-sm font-bold text-slate-900">
            3. Import Attendees via CSV or Manually
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            Upload a CSV list of attendees with preview & validation, or add individual recipients manually at any time.
          </p>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
          <h2 className="text-sm font-bold text-slate-900">
            4. Release & Track Downloads
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            Toggle the event to <strong>Released</strong>, share the public event link with attendees, and track who has or hasn&apos;t downloaded their certificate.
          </p>
        </section>
      </div>
    </div>
  );
}
